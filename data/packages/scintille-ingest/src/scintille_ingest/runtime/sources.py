"""What the runtime needs from a satellite source."""

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Protocol

from obstore.store import ObjectStore

from scintille_ingest.glm.discovery import fetch, list_products, public_store
from scintille_ingest.glm.ingest import IngestedFile, ingest_glm_file
from scintille_ingest.glm.products import Satellite
from scintille_ingest.mtg.discovery import DataStore, chunks
from scintille_ingest.mtg.ingest import ingest_li_file
from scintille_ingest.mtg.products import parse_key


@dataclass(frozen=True)
class Product:
    key: str
    start: datetime
    """Upstream object version; a new ETag under a known key is fetched again."""
    etag: str | None = None


class Source(Protocol):
    name: str
    """Seconds between two listings."""
    cadence: float

    async def list_recent(self, now: datetime) -> list[Product]: ...

    async def fetch(self, product: Product) -> bytes: ...

    def parse(self, product: Product, data: bytes, received_at: datetime) -> IngestedFile:
        """Normalized flashes and the `bronze.ingest_log` row; an unreadable file gives no
        flashes and a failed status instead of raising."""
        ...


class GlmSource:
    """GOES-East or GOES-West, from the public NOAA bucket."""

    cadence = 10.0

    def __init__(self, satellite: Satellite, store: ObjectStore | None = None) -> None:
        self.name: str = satellite.source
        self._source = satellite.source
        self._store = store or public_store(satellite.bucket)

    async def list_recent(self, now: datetime) -> list[Product]:
        hours = (now - timedelta(hours=1), now)
        listed = await asyncio.gather(
            *(asyncio.to_thread(list_products, self._store, h) for h in hours)
        )
        return [Product(p.key, p.start, p.etag) for batch in listed for p in batch]

    async def fetch(self, product: Product) -> bytes:
        return await asyncio.to_thread(fetch, self._store, product.key)

    def parse(self, product: Product, data: bytes, received_at: datetime) -> IngestedFile:
        return ingest_glm_file(data, product.key, self._source, received_at)


class MtgSource:
    """MTG-I1 Lightning Imager, from the EUMETSAT Data Store."""

    name = "mtg-li"
    cadence = 30.0
    lookback = timedelta(minutes=30)

    def __init__(self, store: DataStore) -> None:
        self._store = store

    async def list_recent(self, now: datetime) -> list[Product]:
        listed = await asyncio.to_thread(self._store.search, now - self.lookback, now)
        return [Product(c.key, c.start) for c in chunks(listed)]

    async def fetch(self, product: Product) -> bytes:
        chunk = parse_key(product.key)
        return await asyncio.to_thread(self._store.fetch, chunk.product_id, chunk.name)

    def parse(self, product: Product, data: bytes, received_at: datetime) -> IngestedFile:
        return ingest_li_file(data, product.key, received_at)
