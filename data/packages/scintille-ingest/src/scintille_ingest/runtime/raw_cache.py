"""30-day cache of original files in R2, for reprocessing (the bucket's `raw/` lifecycle rule)."""

import os
from pathlib import PurePosixPath

import obstore
from obstore.store import ObjectStore, S3Store

from .identity import FileIdentity


def raw_key(source: str, identity: FileIdentity) -> str:
    """`raw/<source>/<key dir>/<checksum prefix>_<name>`: a revised product gets its own object."""
    key = PurePosixPath(identity.key)
    digest = identity.checksum.removeprefix("sha256:")[:16]
    return str(PurePosixPath("raw", source, key.parent, f"{digest}_{key.name}"))


class ObjectRawCache:
    def __init__(self, store: ObjectStore) -> None:
        self._store = store

    async def put(self, source: str, identity: FileIdentity, data: bytes) -> None:
        await obstore.put_async(self._store, raw_key(source, identity), data)


def r2_store_from_env() -> S3Store:
    """`SCINTILLE_R2_*`, as for the pipelines' `r2` resource; defaults to the local store."""
    endpoint = os.environ.get("SCINTILLE_R2_ENDPOINT") or "http://localhost:9000"
    return S3Store(
        os.environ.get("SCINTILLE_R2_BUCKET") or "scintille-lake",
        endpoint=endpoint,
        access_key_id=os.environ.get("SCINTILLE_R2_ACCESS_KEY_ID") or "scintille-local",
        secret_access_key=os.environ.get("SCINTILLE_R2_SECRET_ACCESS_KEY")
        or "scintille-local-secret",
        region="auto",
        virtual_hosted_style_request=False,
        client_options={"allow_http": endpoint.startswith("http://")},
    )
