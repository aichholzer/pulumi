// *** WARNING: this file was generated by test. ***
// *** Do not edit by hand unless you're certain you know what you are doing! ***

import * as pulumi from "@pulumi/pulumi";
import * as utilities from "../../utilities";

// Export members:
export { ReleaseArgs } from "./release";
export type Release = import("./release").Release;
export const Release: typeof import("./release").Release = null as any;
utilities.lazyLoad(exports, ["Release"], () => require("./release"));


const _module = {
    version: utilities.getVersion(),
    construct: (name: string, type: string, urn: string): pulumi.Resource => {
        switch (type) {
            case "kubernetes:helm.sh/v3:Release":
                return new Release(name, <any>undefined, { urn })
            default:
                throw new Error(`unknown resource type ${type}`);
        }
    },
};
pulumi.runtime.registerResourceModule("kubernetes", "helm.sh/v3", _module)
