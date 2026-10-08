"""Find new GLM files by listing the hour prefixes of the public NOAA buckets."""

from collections.abc import Set
from datetime import datetime, timedelta

import obstore
from obstore.store import ObjectStore, S3Store

from scintille_ingest.glm.products import ProductKey, hour_prefix, parse_key

NOAA_REGION = "us-east-1"


def public_store(bucket: str) -> S3Store:
    return S3Store(bucket, region=NOAA_REGION, skip_signature=True)


def list_products(store: ObjectStore, hour: datetime) -> list[ProductKey]:
    """Product files of one hour, oldest first."""
    keys: list[ProductKey] = []
    for batch in obstore.list(store, prefix=hour_prefix(hour), chunk_size=1000):
        keys.extend(parse_key(meta["path"]) for meta in batch if meta["path"].endswith(".nc"))
    return sorted(keys, key=lambda product: (product.start, product.created))


def latest_product(store: ObjectStore, now: datetime) -> ProductKey | None:
    """Most recent file, looking back one hour when the current one is still empty."""
    for hour in (now, now - timedelta(hours=1)):
        products = list_products(store, hour)
        if products:
            return products[-1]
    return None


def new_products(listed: list[ProductKey], seen: Set[str]) -> list[ProductKey]:
    return [product for product in listed if product.key not in seen]


def fetch(store: ObjectStore, key: str) -> bytes:
    return obstore.get(store, key).bytes().to_bytes()
