# Copyright 2016-2018, Pulumi Corporation.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import base64
import pickle
from typing import (
    TYPE_CHECKING,
    Any,
    ClassVar,
    Dict,
    List,
    Optional,
    cast,
    no_type_check,
)

import dill

import pulumi

from .. import CustomResource, ResourceOptions
from ..runtime._serialization import _serialize
from .config import Config

if TYPE_CHECKING:
    from ..output import Inputs

PROVIDER_KEY = "__provider"


class ConfigureRequest:
    """
    ConfigureRequest is the shape of the configuration data passed to a
    provider's configure method.
    """

    config: Config
    """
    The stack's configuration.
    """

    def __init__(self, config: Config):
        self.config = config


class CheckResult:
    """
    CheckResult represents the results of a call to `ResourceProvider.check`.
    """

    inputs: Dict[str, Any]
    """
    The inputs to use, if any.
    """

    failures: List["CheckFailure"]
    """
    Any validation failures that occurred.
    """

    def __init__(self, inputs: Dict[str, Any], failures: List["CheckFailure"]) -> None:
        self.inputs = inputs
        self.failures = failures


class CheckFailure:
    """
    CheckFailure represents a single failure in the results of a call to `ResourceProvider.check`
    """

    property: str
    """
    The property that failed validation.
    """

    reason: str
    """
    The reason that the property failed validation.
    """

    def __init__(self, property_: str, reason: str) -> None:
        self.property = property_
        self.reason = reason


class DiffResult:
    """
    DiffResult represents the results of a call to `ResourceProvider.diff`.
    """

    changes: Optional[bool]
    """
    If true, this diff detected changes and suggests an update.
    """

    replaces: Optional[List[str]]
    """
    If this update requires a replacement, the set of properties triggering it.
    """

    stables: Optional[List[str]]
    """
    An optional list of properties that will not ever change.
    """

    delete_before_replace: Optional[bool]
    """
    If true, and a replacement occurs, the resource will first be deleted before being recreated.
    This is to void potential side-by-side issues with the default create before delete behavior.
    """

    def __init__(
        self,
        changes: Optional[bool] = None,
        replaces: Optional[List[str]] = None,
        stables: Optional[List[str]] = None,
        delete_before_replace: Optional[bool] = None,
    ) -> None:
        self.changes = changes
        self.replaces = replaces
        self.stables = stables
        self.delete_before_replace = delete_before_replace


class CreateResult:
    """
    CreateResult represents the results of a call to `ResourceProvider.create`.
    """

    id: str
    """
    The ID of the created resource.
    """

    outs: Optional[Dict[str, Any]]
    """
    Any properties that were computed during creation.
    """

    def __init__(self, id_: str, outs: Optional[Dict[str, Any]] = None) -> None:
        self.id = id_
        self.outs = outs


class ReadResult:
    """
    The ID of the resource ready back (or blank if missing).
    """

    id: Optional[str]
    """
    The ID of the resource ready back (or blank if missing).
    """

    outs: Optional[Dict[str, Any]]
    """
    The current property state read from the live environment.
    """

    def __init__(
        self,
        id_: Optional[str] = None,
        outs: Optional[Dict[str, Any]] = None,
    ) -> None:
        self.id = id_
        self.outs = outs


class UpdateResult:
    """
    UpdateResult represents the results of a call to `ResourceProvider.update`.
    """

    outs: Optional[Dict[str, Any]]
    """
    Any properties that were computed during updating.
    """

    def __init__(self, outs: Optional[Dict[str, Any]] = None) -> None:
        self.outs = outs


class ResourceProvider:
    """
    ResourceProvider is a Dynamic Resource Provider which allows defining new kinds of resources
    whose CRUD operations are implemented inside your Python program.
    """

    serialize_as_secret_always: bool = True
    """
    Controls whether the serialized provider is a secret.
    By default it is True which makes the serialized provider a secret always.
    Set to False in a subclass to make the serialized provider a secret only
    if any secret Outputs were captured during serialization of the provider.
    """

    def check(self, _olds: Dict[str, Any], news: Dict[str, Any]) -> CheckResult:
        """
        Check validates that the given property bag is valid for a resource of the given type.
        """
        return CheckResult(news, [])

    def diff(
        self,
        _id: str,
        _olds: Dict[str, Any],
        _news: Dict[str, Any],
    ) -> DiffResult:
        """
        Diff checks what impacts a hypothetical update will have on the resource's properties.
        """
        return DiffResult()

    def create(self, props: Dict[str, Any]) -> CreateResult:
        """
        Create allocates a new instance of the provided resource and returns its unique ID
        afterwards. If this call fails, the resource must not have been created (i.e., it is
        "transactional").
        """
        raise Exception("Subclass of ResourceProvider must implement 'create'")

    def read(self, id_: str, props: Dict[str, Any]) -> ReadResult:
        """
        Reads the current live state associated with a resource.  Enough state must be included in
        the inputs to uniquely identify the resource; this is typically just the resource ID, but it
        may also include some properties.
        """
        return ReadResult(id_, props)

    def update(
        self,
        _id: str,
        _olds: Dict[str, Any],
        _news: Dict[str, Any],
    ) -> UpdateResult:
        """
        Update updates an existing resource with new values.
        """
        return UpdateResult()

    def delete(self, _id: str, _props: Dict[str, Any]) -> None:
        """
        Delete tears down an existing resource with the given ID.  If it fails, the resource is
        assumed to still exist.
        """

    def configure(self, req: ConfigureRequest) -> None:
        """
        Configure sets up the resource provider. Use this to initialize the
        provider and store configuration.
        """

    def __init__(self) -> None:
        pass


# TODO[python/mypy#1102]: mypy doesn't currently support multiline comments
# multiple errors related to the type assignment we're doing in this method eg 'Picker = _Pickler'
@no_type_check
def serialize_provider(provider: ResourceProvider) -> str:
    # We need to customize our Pickler to ensure we sort dictionaries before serializing to try to
    # ensure we get a deterministic result.  Without this we would see changes to our serialized
    # provider even when there are no actual changes.
    old_pickler = pickle.Pickler
    pickle.Pickler = pickle._Pickler

    # See: https://github.com/uqfoundation/dill/issues/481#issuecomment-1133789848
    unsorted_batch_setitems = pickle.Pickler._batch_setitems

    def batch_set_items_sorted(self, items):
        unsorted_batch_setitems(self, sorted(items))

    pickle.Pickler._batch_setitems = batch_set_items_sorted

    def save_dict_sorted(self, obj):
        if self.bin:
            self.write(pickle.EMPTY_DICT)
        else:  # proto 0 -- can't use EMPTY_DICT
            self.write(pickle.MARK + pickle.DICT)

        self.memoize(obj)
        self._batch_setitems(obj.items())

    pickle.Pickler.save_dict = save_dict_sorted

    # Use dill to recursively pickle the provider and store base64 encoded form
    try:
        byts = dill.dumps(provider, protocol=pickle.DEFAULT_PROTOCOL, recurse=True)
        return base64.b64encode(byts).decode("utf-8")
    finally:
        # Restore the original pickler
        pickle.Pickler = old_pickler


class Resource(CustomResource):
    """
    Resource represents a Pulumi Resource that incorporates an inline implementation of the Resource's CRUD operations.
    """

    _resource_type_name: ClassVar[str]

    def __init_subclass__(cls, module: str = "", name: str = "Resource"):
        if module:
            module = f"/{module}"
        cls._resource_type_name = f"dynamic{module}:{name}"

    def __init__(
        self,
        provider: ResourceProvider,
        name: str,
        props: "Inputs",
        opts: Optional[ResourceOptions] = None,
    ) -> None:
        """
        :param str provider: The implementation of the resource's CRUD operations.
        :param str name: The name of this resource.
        :param Optional[dict] props: The arguments to use to populate the new resource. Must not define the reserved
                property "__provider".
        :param Optional[ResourceOptions] opts: A bag of options that control this resource's behavior.
        """

        if PROVIDER_KEY in props:
            raise Exception("A dynamic resource must not define the __provider key")

        props = cast(dict, props)

        # Serialize the provider, allowing secret Outputs to be captured.
        serialized_provider, contains_secrets = _serialize(
            True, serialize_provider, provider
        )

        # serialize_as_secret_always is True by default, which makes the serialized provider
        # a secret always, which is the existing behavior as of v3.75.0.
        # When serialize_as_secret_always is set to False, the serialized provider is made a
        # secret only if any secret Outputs were captured during serialization of the
        # provider.
        serialize_as_secret_always: bool = getattr(
            provider, "serialize_as_secret_always", True
        )
        if serialize_as_secret_always or contains_secrets:
            serialized_provider = pulumi.Output.secret(serialized_provider)

        props[PROVIDER_KEY] = serialized_provider

        super().__init__(f"pulumi-python:{self._resource_type_name}", name, props, opts)
