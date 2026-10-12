"""List and download LI L2 LFL chunks from the EUMETSAT Data Store with `eumdac`."""

import os
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol

from eumdac.datastore import DataStore as EumdacDataStore
from eumdac.token import AccessToken

from scintille_ingest.mtg.products import COLLECTION, ChunkKey, is_flash_chunk, parse_key


@dataclass(frozen=True)
class Listed:
    """A Data Store product, its entries and when the Data Store published it."""

    product_id: str
    entries: tuple[str, ...]
    published: datetime | None = None


class DataStore(Protocol):
    def search(self, start: datetime, end: datetime) -> list[Listed]: ...

    def fetch(self, product_id: str, entry: str) -> bytes: ...


class EumdacStore:
    """The LFL collection, authenticated with the maintainer's API key pair."""

    def __init__(self, key: str, secret: str, collection: str = COLLECTION) -> None:
        self._datastore = EumdacDataStore(AccessToken((key, secret)))
        self._collection_id = collection
        self._entries: dict[str, tuple[str, ...]] = {}

    def search(self, start: datetime, end: datetime) -> list[Listed]:
        """Products sensed between `start` and `end`; entries are cached per product."""
        collection = self._datastore.get_collection(self._collection_id)
        listed: list[Listed] = []
        for product in collection.search(dtstart=_naive(start), dtend=_naive(end)):
            product_id = str(product)
            if product_id not in self._entries:
                self._entries[product_id] = tuple(product.entries)
            published = product.ingested
            listed.append(
                Listed(
                    product_id,
                    self._entries[product_id],
                    published.replace(tzinfo=UTC) if published else None,
                )
            )
        return listed

    def fetch(self, product_id: str, entry: str) -> bytes:
        product = self._datastore.get_product(self._collection_id, product_id)
        with product.open(entry=entry) as stream:
            return stream.read()


def store_from_env() -> EumdacStore | None:
    """`SCINTILLE_EUMETSAT_CONSUMER_KEY` / `_SECRET`; None when either is missing."""
    key = os.environ.get("SCINTILLE_EUMETSAT_CONSUMER_KEY")
    secret = os.environ.get("SCINTILLE_EUMETSAT_CONSUMER_SECRET")
    return EumdacStore(key, secret) if key and secret else None


def chunks(listed: list[Listed]) -> list[ChunkKey]:
    """Flash chunks of every product, oldest first."""
    keys = [
        parse_key(f"{product.product_id}/{entry}")
        for product in listed
        for entry in product.entries
        if is_flash_chunk(entry)
    ]
    return sorted(keys, key=lambda chunk: (chunk.start, chunk.created, chunk.key))


def _naive(at: datetime) -> datetime:
    return at.astimezone(UTC).replace(tzinfo=None)
