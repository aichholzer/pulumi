// Copyright 2016-2024, Pulumi Corporation.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as asset from "../asset";
import { isGrpcError } from "../errors";
import * as log from "../log";
import { getAllResources, Input, Inputs, isUnknown, Output, unknown, OutputToStringError } from "../output";
import { ComponentResource, CustomResource, DependencyResource, ProviderResource, Resource } from "../resource";
import { debuggablePromise, debugPromiseLeaks, errorString } from "./debuggable";
import { getAllTransitivelyReferencedResourceURNs } from "./dependsOn";
import { excessiveDebugOutput, isDryRun } from "./settings";
import { getStore, getResourcePackages, getResourceModules } from "./state";

import * as gstruct from "google-protobuf/google/protobuf/struct_pb";
import * as semver from "semver";

export type OutputResolvers = Record<
    string,
    (value: any, isStable: boolean, isSecret: boolean, deps?: Resource[], err?: Error) => void
>;

// Fix to cover cases such as https://github.com/pulumi/pulumi/issues/17736 where an array or other
// nested object contains an Output, and it's toString method tries to call toString on that output.
function safeToString(v: any): string {
    try {
        return `${v}`;
    } catch (err) {
        // We only want to catch our toString errors here. Anything else we should still bubble up to the user.
        if (OutputToStringError.isInstance(err)) {
            return "Output<T>";
        }
        throw err;
    }
}

/**
 * Mutates the `onto` resource so that it has Promise-valued properties for all
 * the `props` input/output props. *Importantly* all these promises are
 * completely unresolved. This is because we don't want anyone to observe the
 * values of these properties until the rpc call to registerResource actually
 * returns. This is because the registerResource call may actually override
 * input values, and we only want people to see the final value.
 *
 * The result of this call (beyond the stateful changes to `onto`) is the set of
 * {@link Promise} resolvers that will be called post-RPC call.  When the
 * {@link registerResource} RPC call comes back, the values that the engine
 * actualy produced will be used to resolve all the unresolved promised placed
 * on `onto`.
 */
export function transferProperties(onto: Resource, label: string, props: Inputs): OutputResolvers {
    const resolvers: OutputResolvers = {};
    for (const k of Object.keys(props)) {
        // Skip "id" and "urn", since we handle those specially.
        if (k === "id" || k === "urn") {
            continue;
        }

        // Create a property to wrap the value and store it on the resource.
        if (onto.hasOwnProperty(k)) {
            throw new Error(`Property '${k}' is already initialized on target '${label}`);
        }

        let resolveValue: (v: any) => void;
        let rejectValue: (err: Error) => void;
        let resolveIsKnown: (v: boolean) => void;
        let rejectIsKnown: (err: Error) => void;
        let resolveIsSecret: (v: boolean) => void;
        let rejectIsSecret: (err: Error) => void;
        let resolveDeps: (v: Resource[]) => void;
        let rejectDeps: (err: Error) => void;

        resolvers[k] = (v: any, isKnown: boolean, isSecret: boolean, deps: Resource[] = [], err?: Error) => {
            if (err) {
                if (isGrpcError(err)) {
                    if (debugPromiseLeaks) {
                        console.error("info: skipped rejection in transferProperties");
                    }
                    return;
                }
                rejectValue(err);
                rejectIsKnown(err);
                rejectIsSecret(err);
                rejectDeps(err);
            } else {
                resolveValue(v);
                resolveIsKnown(isKnown);
                resolveIsSecret(isSecret);
                resolveDeps(deps);
            }
        };

        const propString = Output.isInstance(props[k]) ? "Output<T>" : safeToString(props[k]);
        (<any>onto)[k] = new Output(
            onto,
            debuggablePromise(
                new Promise<any>((resolve, reject) => {
                    resolveValue = resolve;
                    rejectValue = reject;
                }),
                `transferProperty(${label}, ${k}, ${propString})`,
            ),
            debuggablePromise(
                new Promise<boolean>((resolve, reject) => {
                    resolveIsKnown = resolve;
                    rejectIsKnown = reject;
                }),
                `transferIsStable(${label}, ${k}, ${propString})`,
            ),
            debuggablePromise(
                new Promise<boolean>((resolve, reject) => {
                    resolveIsSecret = resolve;
                    rejectIsSecret = reject;
                }),
                `transferIsSecret(${label}, ${k}, ${propString})`,
            ),
            debuggablePromise(
                new Promise<Resource[]>((resolve, reject) => {
                    resolveDeps = resolve;
                    rejectDeps = reject;
                }),
                `transferDeps(${label}, ${k}, ${propString})`,
            ),
        );
    }

    return resolvers;
}

/**
 * Controls the serialization of RPC structures.
 */
export interface SerializationOptions {
    /**
     * True if we are keeping output values. If the monitor does not support
     * output values, they will not be kept, even when this is set to true.
     */
    keepOutputValues?: boolean;

    /**
     * True if we should exclude resource references from the set of dependencies
     * identified during serialization. This is useful for remote components where
     * we want propertyDependencies to be empty for a property that only contains
     * resource references. If the monitor does not support resource references,
     * this will have no effect.
     */
    excludeResourceReferencesFromDependencies?: boolean;
}

/**
 * Walks the props object passed in, awaiting all interior promises for
 * properties with keys that match the provided filter, creating a reasonable
 * POJO object that can be remoted over to {@link registerResource}.
 */
async function serializeFilteredProperties(
    label: string,
    props: Inputs,
    acceptKey: (k: string) => boolean,
    opts?: SerializationOptions,
): Promise<[Record<string, any>, Map<string, Set<Resource>>]> {
    const propertyToDependentResources = new Map<string, Set<Resource>>();

    const result: Record<string, any> = {};
    for (const k of Object.keys(props)) {
        if (acceptKey(k)) {
            // We treat properties with undefined values as if they do not exist.
            const dependentResources = new Set<Resource>();
            const v = await serializeProperty(`${label}.${k}`, props[k], dependentResources, opts);
            if (v !== undefined) {
                result[k] = v;
                propertyToDependentResources.set(k, dependentResources);
            }
        }
    }

    return [result, propertyToDependentResources];
}

/**
 * Walks the props object passed in, awaiting all interior promises besides
 * those for `id` and `urn`, creating a reasonable POJO object that can be
 * remoted over to {@link registerResource}.
 */
export async function serializeResourceProperties(label: string, props: Inputs, opts?: SerializationOptions) {
    return serializeFilteredProperties(label, props, (key) => key !== "id" && key !== "urn", opts);
}

/**
 * Walks the props object passed in, awaiting all interior promises, creating a
 * reasonable POJO object that can be remoted over to {@link registerResource}.
 */
export async function serializeProperties(label: string, props: Inputs, opts?: SerializationOptions) {
    const [result] = await serializeFilteredProperties(label, props, (_) => true, opts);
    return result;
}

/**
 * @internal
 */
export async function serializePropertiesReturnDeps(label: string, props: Inputs, opts?: SerializationOptions) {
    return serializeFilteredProperties(label, props, (_) => true, opts);
}

/**
 * Fetches the raw outputs and deserializes them from a gRPC call result.
 */
export function deserializeProperties(outputsStruct: gstruct.Struct, keepUnknowns?: boolean): Inputs {
    const props: Inputs = {};
    const outputs = outputsStruct.toJavaScript();
    for (const k of Object.keys(outputs)) {
        // We treat properties with undefined values as if they do not exist.
        if (outputs[k] !== undefined) {
            props[k] = deserializeProperty(outputs[k], keepUnknowns);
        }
    }
    return props;
}

/**
 * Takes as input a gRPC serialized `proto.google.protobuf.Struct` and resolves
 * all of the resource's matching properties to the values inside.
 *
 * NOTE: it is imperative that the properties in `allProps` were produced by
 * `deserializeProperties` in order for output properties to work correctly
 * w.r.t. knowns/unknowns: this function assumes that any undefined value in
 * `allProps`represents an unknown value that was returned by an engine
 * operation.
 */
export function resolveProperties(
    res: Resource,
    resolvers: Record<string, (v: any, isKnown: boolean, isSecret: boolean, deps?: Resource[], err?: Error) => void>,
    t: string,
    name: string,
    allProps: any,
    deps: Record<string, Resource[]>,
    err?: Error,
    keepUnknowns?: boolean,
): void {
    // If there is an error, just reject everything.
    if (err) {
        for (const k of Object.keys(resolvers)) {
            const resolve = resolvers[k];
            resolve(undefined, true, false, [], err);
        }
        return;
    }

    // Now go ahead and resolve all properties present in the inputs and outputs set.
    for (const k of Object.keys(allProps)) {
        // Skip "id" and "urn", since we handle those specially.
        if (k === "id" || k === "urn") {
            continue;
        }

        // Otherwise, unmarshal the value, and store it on the resource object.
        const resolve = resolvers[k];

        if (resolve === undefined) {
            // engine returned a property that was not in our initial property-map.  This can happen
            // for outputs that were registered through direct calls to 'registerOutputs'. We do
            // *not* want to do anything with these returned properties.  First, the component
            // resources that were calling 'registerOutputs' will have already assigned these fields
            // directly on them themselves.  Second, if we were to try to assign here we would have
            // an incredibly bad race condition for two reasons:
            //
            //  1. This call to 'resolveProperties' happens asynchronously at some point far after
            //     the resource was constructed.  So the user will have been able to observe the
            //     initial value up until we get to this point.
            //
            //  2. The component resource will have often assigned a value of some arbitrary type
            //     (say, a 'string').  If we overwrite this with an `Output<string>` we'll be changing
            //     the type at some non-deterministic point in the future.
            continue;
        }

        // If this value is a secret, unwrap its inner value.
        let value = allProps[k];
        const isSecret = isRpcSecret(value);
        value = unwrapRpcSecret(value);

        try {
            // If the value the engine handed back is or contains an unknown value, the resolver will mark its value as
            // unknown automatically, so we just pass true for isKnown here. Note that unknown values will only be
            // present during previews (i.e. isDryRun() will be true).
            resolve(value, /*isKnown*/ true, isSecret, deps[k]);
        } catch (resolveError) {
            throw new Error(
                `Unable to set property '${k}' on resource '${name}' [${t}]; error: ${errorString(resolveError)}`,
            );
        }
    }

    // `allProps` may not have contained a value for every resolver: for example, optional outputs may not be present.
    // We will resolve all of these values as `undefined`, and will mark the value as known if we are not running a
    // preview.  For updates when the update of the resource was either skipped or failed we'll mark them as `unknown`.
    for (const k of Object.keys(resolvers)) {
        if (!allProps.hasOwnProperty(k)) {
            const resolve = resolvers[k];
            if (!isDryRun && keepUnknowns) {
                resolve(unknown, true, false);
            } else {
                resolve(undefined, !isDryRun() && !keepUnknowns, false);
            }
        }
    }
}

/**
 * Unknown values are encoded as a distinguished string value.
 */
export const unknownValue = "04da6b54-80e4-46f7-96ec-b56ff0331ba9";

/**
 * {@link specialSigKey} is sometimes used to encode type identity inside of a
 * map.
 *
 * @see sdk/go/common/resource/properties.go.
 */
export const specialSigKey = "4dabf18193072939515e22adb298388d";

/**
 * {@link specialAssetSig} is a randomly assigned hash used to identify assets
 * in maps.
 *
 * @see sdk/go/common/resource/asset.go.
 */
export const specialAssetSig = "c44067f5952c0a294b673a41bacd8c17";

/**
 * {@link specialArchiveSig} is a randomly assigned hash used to identify
 * archives in maps.
 *
 * @see sdk/go/common/resource/asset.go.
 */
export const specialArchiveSig = "0def7320c3a5731c473e5ecbe6d01bc7";

/**
 * {@link specialSecretSig} is a randomly assigned hash used to identify secrets
 * in maps.
 *
 * @see sdk/go/common/resource/properties.go.
 */
export const specialSecretSig = "1b47061264138c4ac30d75fd1eb44270";

/**
 * {@link specialResourceSig} is a randomly assigned hash used to identify
 * resources in maps.
 *
 * @see sdk/go/common/resource/properties.go.
 */
export const specialResourceSig = "5cf8f73096256a8f31e491e813e4eb8e";

/**
 * {@link specialOutputValueSig} is a randomly assigned hash used to identify
 * outputs in maps.
 *
 * @see sdk/go/common/resource/properties.go.
 */
export const specialOutputValueSig = "d0e6a833031e9bbcd3f4e8bde6ca49a4";

/** @internal */
export function serializeSecretValue(value: any): any {
    return {
        [specialSigKey]: specialSecretSig,
        // coerce 'undefined' to 'null' as required by the protobuf system.
        value: value === undefined ? null : value,
    };
}

/**
 * Serializes properties deeply.  This understands how to wait on any unresolved
 * promises, as appropriate, in addition to translating certain "special" values
 * so that they are ready to go on the wire.
 */
export async function serializeProperty(
    ctx: string,
    prop: Input<any>,
    dependentResources?: Set<Resource>,
    opts?: SerializationOptions,
): Promise<any> {
    // IMPORTANT:
    // IMPORTANT: Keep this in sync with serializePropertiesSync in invoke.ts
    // IMPORTANT:

    if (
        prop === undefined ||
        prop === null ||
        typeof prop === "boolean" ||
        typeof prop === "number" ||
        typeof prop === "string"
    ) {
        if (excessiveDebugOutput) {
            log.debug(`Serialize property [${ctx}]: primitive=${prop}`);
        }
        return prop;
    }

    if (asset.Asset.isInstance(prop) || asset.Archive.isInstance(prop)) {
        // Serializing an asset or archive requires the use of a magical signature key, since otherwise it would look
        // like any old weakly typed object/map when received by the other side of the RPC boundary.
        const obj: any = {
            [specialSigKey]: asset.Asset.isInstance(prop) ? specialAssetSig : specialArchiveSig,
        };

        return await serializeAllKeys(prop, obj, { keepOutputValues: false });
    }

    if (prop instanceof Promise) {
        // For a promise input, await the property and then serialize the result.
        if (excessiveDebugOutput) {
            log.debug(`Serialize property [${ctx}]: Promise<T>`);
        }

        const subctx = `Promise<${ctx}>`;
        return serializeProperty(
            subctx,
            await debuggablePromise(prop, `serializeProperty.await(${subctx})`),
            dependentResources,
            opts,
        );
    }

    if (Output.isInstance(prop)) {
        if (excessiveDebugOutput) {
            log.debug(`Serialize property [${ctx}]: Output<T>`);
        }

        // handle serializing both old-style outputs (with sync resources) and new-style outputs
        // (with async resources).

        const propResources = await getAllResources(prop);
        for (const resource of propResources) {
            if (dependentResources) {
                dependentResources.add(resource);
            }
        }

        // When serializing an Output, we will either serialize it as its resolved value or the "unknown value"
        // sentinel. We will do the former for all outputs created directly by user code (such outputs always
        // resolve isKnown to true) and for any resource outputs that were resolved with known values.
        const isKnown = await prop.isKnown;

        // You might think that doing an explict `=== true` here is not needed, but it is for a subtle reason. If the
        // output we are serializing is a proxy itself, and it comes from a version of the SDK that did not have the
        // `isSecret` member on `OutputImpl` then the call to `prop.isSecret` here will return an Output itself,
        // which will wrap undefined, if it were to be resolved (since `Output` has no member named .isSecret).
        // so we must compare to the literal true instead of just doing await prop.isSecret.
        const isSecret = (await prop.isSecret) === true;
        const promiseDeps = new Set<Resource>();
        const value = await serializeProperty(`${ctx}.id`, prop.promise(), promiseDeps, {
            keepOutputValues: false,
        });
        for (const resource of promiseDeps) {
            propResources.add(resource);
            if (dependentResources) {
                dependentResources.add(resource);
            }
        }

        if (opts?.keepOutputValues && getStore().supportsOutputValues) {
            const urnDeps = new Set<Resource>();
            for (const resource of propResources) {
                await serializeProperty(`${ctx} dependency`, resource.urn, urnDeps, {
                    keepOutputValues: false,
                });
            }
            for (const resource of urnDeps) {
                propResources.add(resource);
                if (dependentResources) {
                    dependentResources.add(resource);
                }
            }

            const dependencies = await getAllTransitivelyReferencedResourceURNs(propResources, new Set<Resource>());

            const obj: any = {
                [specialSigKey]: specialOutputValueSig,
            };
            if (isKnown) {
                // coerce 'undefined' to 'null' as required by the protobuf system.
                obj["value"] = value === undefined ? null : value;
            }
            if (isSecret) {
                obj["secret"] = isSecret;
            }
            if (dependencies.size > 0) {
                obj["dependencies"] = Array.from(dependencies);
            }
            return obj;
        }

        if (!isKnown) {
            return unknownValue;
        }
        if (isSecret && getStore().supportsSecrets) {
            return serializeSecretValue(value);
        }
        return value;
    }

    if (isUnknown(prop)) {
        return unknownValue;
    }

    if (CustomResource.isInstance(prop)) {
        if (excessiveDebugOutput) {
            log.debug(`Serialize property [${ctx}]: custom resource urn`);
        }

        if (opts?.excludeResourceReferencesFromDependencies && getStore().supportsResourceReferences) {
            // If excluding resource references from dependencies and the monitor supports resource
            // references, we don't want to track this dependency, so we set `dependentResources`
            // to undefined so when serializing the `id` and `urn` the resource won't be included
            // in the caller's `dependentResources`.
            dependentResources = undefined;
        } else {
            // Otherwise, track the dependency.
            if (dependentResources) {
                dependentResources.add(prop);
            }
        }

        const id = await serializeProperty(`${ctx}.id`, prop.id, dependentResources, {
            keepOutputValues: false,
        });

        if (getStore().supportsResourceReferences) {
            // If we are keeping resources, emit a stronly typed wrapper over the URN
            const urn = await serializeProperty(`${ctx}.urn`, prop.urn, dependentResources, {
                keepOutputValues: false,
            });
            return {
                [specialSigKey]: specialResourceSig,
                urn: urn,
                id: id,
            };
        }

        // Else, return the id for backward compatibility.
        return id;
    }

    if (ComponentResource.isInstance(prop)) {
        // Component resources often can contain cycles in them.  For example, an awsinfra
        // SecurityGroupRule can point a the awsinfra SecurityGroup, which in turn can point back to
        // its rules through its `egressRules` and `ingressRules` properties.  If serializing out
        // the `SecurityGroup` resource ends up trying to serialize out those properties, a deadlock
        // will happen, due to waiting on the child, which is waiting on the parent.
        //
        // Practically, there is no need to actually serialize out a component.  It doesn't represent
        // a real resource, nor does it have normal properties that need to be tracked for differences
        // (since changes to its properties don't represent changes to resources in the real world).
        //
        // So, to avoid these problems, while allowing a flexible and simple programming model, we
        // just serialize out the component as its urn.  This allows the component to be identified
        // and tracked in a reasonable manner, while not causing us to compute or embed information
        // about it that is not needed, and which can lead to deadlocks.
        if (excessiveDebugOutput) {
            log.debug(`Serialize property [${ctx}]: component resource urn`);
        }

        if (getStore().supportsResourceReferences) {
            if (opts?.excludeResourceReferencesFromDependencies) {
                // If excluding resource references from dependencies and the monitor supports resource
                // references, we don't want to track this dependency, so we set `dependentResources`
                // to undefined so when serializing the `urn` the resource won't be included in the
                // caller's `dependentResources`.
                dependentResources = undefined;
            }

            // If we are keeping resources, emit a strongly typed wrapper over the URN
            const urn = await serializeProperty(`${ctx}.urn`, prop.urn, dependentResources, {
                keepOutputValues: false,
            });
            return {
                [specialSigKey]: specialResourceSig,
                urn: urn,
            };
        }
        // Else, return the urn for backward compatibility.
        return serializeProperty(`${ctx}.urn`, prop.urn, dependentResources, {
            keepOutputValues: false,
        });
    }

    if (prop instanceof Array) {
        const result: any[] = [];
        for (let i = 0; i < prop.length; i++) {
            if (excessiveDebugOutput) {
                log.debug(`Serialize property [${ctx}]: array[${i}] element`);
            }
            // When serializing arrays, we serialize any undefined values as `null`. This matches JSON semantics.
            const elem = await serializeProperty(`${ctx}[${i}]`, prop[i], dependentResources, opts);
            result.push(elem === undefined ? null : elem);
        }
        return result;
    }

    return await serializeAllKeys(prop, {}, opts);

    async function serializeAllKeys(innerProp: any, obj: any, innerOpts?: SerializationOptions) {
        for (const k of Object.keys(innerProp)) {
            if (excessiveDebugOutput) {
                log.debug(`Serialize property [${ctx}]: object.${k}`);
            }

            // When serializing an object, we omit any keys with undefined values. This matches JSON semantics.
            const v = await serializeProperty(`${ctx}.${k}`, innerProp[k], dependentResources, innerOpts);
            if (v !== undefined) {
                obj[k] = v;
            }
        }

        return obj;
    }
}

/**
 * Returns true if the given object is a wrapped secret value (i.e. it's an
 * object with the special key set).
 */
export function isRpcSecret(obj: any): boolean {
    return obj && obj[specialSigKey] === specialSecretSig;
}

/**
 * Returns the underlying value for a secret, or the value itself if it was not
 * a secret.
 */
export function unwrapRpcSecret(obj: any): any {
    if (!isRpcSecret(obj)) {
        return obj;
    }
    return obj.value;
}

function isPrimitive(value: unknown): boolean {
    return (
        value === null ||
        value === undefined ||
        typeof value === "boolean" ||
        typeof value === "number" ||
        typeof value === "string"
    );
}

/** @internal */
export function containsUnknownValues(value: unknown): boolean {
    if (value === unknownValue) {
        return true;
    } else if (isPrimitive(value)) {
        return false;
    } else if (value instanceof Array) {
        return value.some(containsUnknownValues);
    } else {
        const map = value as Record<string, unknown>;
        return Object.keys(map).some((key) => containsUnknownValues(map[key]));
    }
}

/** @internal */
export function unwrapSecretValues(value: unknown): [unknown, boolean] {
    if (isPrimitive(value)) {
        return [value, false];
    } else if (isRpcSecret(value)) {
        return [unwrapRpcSecret(value), true];
    } else if (value instanceof Array) {
        let hadSecret = false;
        const result = [];
        for (const elem of value) {
            const [unwrapped, isSecret] = unwrapSecretValues(elem);
            hadSecret = hadSecret || isSecret;
            result.push(unwrapped);
        }
        return [result, hadSecret];
    } else {
        let hadSecret = false;
        const result: Record<string, unknown> = {};
        const map = value as Record<string, unknown>;
        for (const key of Object.keys(map)) {
            const [unwrapped, isSecret] = unwrapSecretValues(map[key]);
            hadSecret = hadSecret || isSecret;
            result[key] = unwrapped;
        }
        return [result, hadSecret];
    }
}

/**
 * Unpacks some special types, reversing the process undertaken by
 * {@link serializeProperty}.
 */
export function deserializeProperty(prop: any, keepUnknowns?: boolean): any {
    if (prop === undefined) {
        throw new Error("unexpected undefined property value during deserialization");
    } else if (prop === unknownValue) {
        return isDryRun() || keepUnknowns ? unknown : undefined;
    } else if (prop === null || typeof prop === "boolean" || typeof prop === "number" || typeof prop === "string") {
        return prop;
    } else if (prop instanceof Array) {
        // We can just deserialize all the elements of the underlying array and return it.
        // However, we want to push secretness up to the top level (since we can't set sub-properties to secret)
        // values since they are not typed as Output<T>.
        let hadSecret = false;
        const elems: any[] = [];
        for (const e of prop) {
            prop = deserializeProperty(e, keepUnknowns);
            hadSecret = hadSecret || isRpcSecret(prop);
            elems.push(unwrapRpcSecret(prop));
        }

        if (hadSecret) {
            return {
                [specialSigKey]: specialSecretSig,
                value: elems,
            };
        }

        return elems;
    } else {
        // We need to recognize assets and archives specially, so we can produce the right runtime objects.
        const sig: any = prop[specialSigKey];
        if (sig) {
            switch (sig) {
                case specialAssetSig:
                    if (prop["path"]) {
                        return new asset.FileAsset(<string>prop["path"]);
                    } else if (prop["text"]) {
                        return new asset.StringAsset(<string>prop["text"]);
                    } else if (prop["uri"]) {
                        return new asset.RemoteAsset(<string>prop["uri"]);
                    } else {
                        throw new Error("Invalid asset encountered when unmarshaling resource property");
                    }
                case specialArchiveSig:
                    if (prop["assets"]) {
                        const assets: asset.AssetMap = {};
                        for (const name of Object.keys(prop["assets"])) {
                            const a = deserializeProperty(prop["assets"][name], keepUnknowns);
                            if (!asset.Asset.isInstance(a) && !asset.Archive.isInstance(a)) {
                                throw new Error(
                                    "Expected an AssetArchive's assets to be unmarshaled Asset or Archive objects",
                                );
                            }
                            assets[name] = a;
                        }
                        return new asset.AssetArchive(assets);
                    } else if (prop["path"]) {
                        return new asset.FileArchive(<string>prop["path"]);
                    } else if (prop["uri"]) {
                        return new asset.RemoteArchive(<string>prop["uri"]);
                    } else {
                        throw new Error("Invalid archive encountered when unmarshaling resource property");
                    }
                case specialSecretSig:
                    return {
                        [specialSigKey]: specialSecretSig,
                        value: deserializeProperty(prop["value"], keepUnknowns),
                    };
                case specialResourceSig:
                    // Deserialize the resource into a live Resource reference
                    const urn = prop["urn"];
                    const version = prop["packageVersion"];

                    const urnParts = urn.split("::");
                    const qualifiedType = urnParts[2];
                    const urnName = urnParts[3];

                    const type = qualifiedType.split("$").pop()!;
                    const typeParts = type.split(":");
                    const pkgName = typeParts[0];
                    const modName = typeParts.length > 1 ? typeParts[1] : "";
                    const typName = typeParts.length > 2 ? typeParts[2] : "";
                    const isProvider = pkgName === "pulumi" && modName === "providers";

                    if (isProvider) {
                        const resourcePackage = getResourcePackage(typName, version);
                        if (resourcePackage) {
                            return resourcePackage.constructProvider(urnName, type, urn);
                        }
                    } else {
                        const resourceModule = getResourceModule(pkgName, modName, version);
                        if (resourceModule) {
                            return resourceModule.construct(urnName, type, urn);
                        }
                    }

                    // If we've made it here, deserialize the reference as either a URN or an ID (if present).
                    if (prop["id"]) {
                        const id = prop["id"];
                        return deserializeProperty(id === "" ? unknownValue : id, keepUnknowns);
                    }
                    return urn;

                case specialOutputValueSig:
                    let value = prop["value"];
                    const isKnown = value !== undefined;
                    if (isKnown) {
                        value = deserializeProperty(value, keepUnknowns);
                    }

                    const isSecret = prop["secret"] === true;

                    const dependencies = prop["dependencies"];
                    const resources = Array.isArray(dependencies)
                        ? dependencies.map((d) => new DependencyResource(d))
                        : [];

                    return new Output(
                        resources,
                        Promise.resolve(value),
                        Promise.resolve(isKnown),
                        Promise.resolve(isSecret),
                        Promise.resolve([]),
                    );

                default:
                    throw new Error(`Unrecognized signature '${sig}' when unmarshaling resource property`);
            }
        }

        // If there isn't a signature, it's not a special type, and we can simply return the object as a map.
        // However, we want to push secretness up to the top level (since we can't set sub-properties to secret)
        // values since they are not typed as Output<T>.
        const obj: any = {};
        let hadSecrets = false;

        for (const k of Object.keys(prop)) {
            const o = deserializeProperty(prop[k], keepUnknowns);
            hadSecrets = hadSecrets || isRpcSecret(o);
            obj[k] = unwrapRpcSecret(o);
        }

        if (hadSecrets) {
            return {
                [specialSigKey]: specialSecretSig,
                value: obj,
            };
        }
        return obj;
    }
}

/**
 * Silences any unhandled promise rejections that occur due to gRPC errors. The
 * input promise may still be rejected.
 */
export function suppressUnhandledGrpcRejections<T>(p: Promise<T>): Promise<T> {
    p.catch((err) => {
        if (!isGrpcError(err)) {
            throw err;
        }
    });
    return p;
}

function sameVersion(a?: string, b?: string): boolean {
    // We treat undefined as a wildcard, so it always equals every other version.
    return a === undefined || b === undefined || semver.eq(a, b);
}

function checkVersion(want?: semver.SemVer, have?: semver.SemVer): boolean {
    if (want === undefined || have === undefined) {
        return true;
    }
    return have.major === want.major && have.minor >= want.minor && have.patch >= want.patch;
}

/**
 * @internal
 */
export function register<T extends { readonly version?: string }>(
    source: Map<string, T[]>,
    registrationType: string,
    key: string,
    item: T,
): boolean {
    let items = source.get(key);
    if (items) {
        for (const existing of items) {
            if (sameVersion(existing.version, item.version)) {
                // It is possible for the same version of the same provider SDK to be loaded multiple times in Node.js.
                // In this case, we might legitimately get multiple registrations of the same resource.  It should not
                // matter which we use, so we can just skip re-registering.  De-serialized resources will always be
                // instances of classes from the first registered package.
                if (excessiveDebugOutput) {
                    log.debug(`skip re-registering already registered ${registrationType} ${key}@${item.version}.`);
                }
                return false;
            }
        }
    } else {
        items = [];
        source.set(key, items);
    }

    if (excessiveDebugOutput) {
        log.debug(`registering ${registrationType} ${key}@${item.version}`);
    }
    items.push(item);
    return true;
}

/**
 * @internal
 */
export function getRegistration<T extends { readonly version?: string }>(
    source: Map<string, T[]>,
    key: string,
    version: string | undefined,
): T | undefined {
    const ver = version ? new semver.SemVer(version) : undefined;

    let bestMatch: T | undefined = undefined;
    let bestMatchVersion: semver.SemVer | undefined = undefined;
    for (const existing of source.get(key) ?? []) {
        const existingVersion = existing.version !== undefined ? new semver.SemVer(existing.version) : undefined;
        if (!checkVersion(ver, existingVersion)) {
            continue;
        }
        if (!bestMatch || (existingVersion && bestMatchVersion && semver.gt(existingVersion, bestMatchVersion))) {
            bestMatch = existing;
            bestMatchVersion = existingVersion;
        }
    }
    return bestMatch;
}

/**
 * A {@link ResourcePackage} is a type that understands how to construct
 * resource providers given a name, type, args, and URN.
 */
export interface ResourcePackage {
    readonly version?: string;
    constructProvider(name: string, type: string, urn: string): ProviderResource;
}

/**
 * @internal
 *  Used only for testing purposes.
 */
export function _resetResourcePackages() {
    const resourcePackages = getResourcePackages();
    resourcePackages.clear();
}

/**
 * Registers a resource package that will be used to construct providers for any
 * URNs matching the package name and version that are deserialized by the
 * current instance of the Pulumi JavaScript SDK.
 */
export function registerResourcePackage(pkg: string, resourcePackage: ResourcePackage) {
    const resourcePackages = getResourcePackages();
    register(resourcePackages, "package", pkg, resourcePackage);
}

export function getResourcePackage(pkg: string, version: string | undefined): ResourcePackage | undefined {
    const resourcePackages = getResourcePackages();
    return getRegistration(resourcePackages, pkg, version);
}

/**
 * A {@link ResourceModule} is a type that understands how to construct
 * resources given a name, type, args, and URN.
 */
export interface ResourceModule {
    readonly version?: string;
    construct(name: string, type: string, urn: string): Resource;
}

function moduleKey(pkg: string, mod: string): string {
    return `${pkg}:${mod}`;
}

/**
 * @internal
 *  Used only for testing purposes.
 */
export function _resetResourceModules() {
    const resourceModules = getResourceModules();
    resourceModules.clear();
}

/**
 * Registers a resource module that will be used to construct resources for any
 * URNs matching the module name and version that are deserialized by the
 * current instance of the Pulumi JavaScript SDK.
 */
export function registerResourceModule(pkg: string, mod: string, module: ResourceModule) {
    const key = moduleKey(pkg, mod);
    const resourceModules = getResourceModules();
    register(resourceModules, "module", key, module);
}

export function getResourceModule(pkg: string, mod: string, version: string | undefined): ResourceModule | undefined {
    const key = moduleKey(pkg, mod);
    const resourceModules = getResourceModules();
    return getRegistration(resourceModules, key, version);
}
