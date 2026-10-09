"""What the runtime needs from a satellite source."""

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Protocol

from obstore.store import ObjectStore

from scintille_ingest.glm.discovery import fetch, list_products, public_store
from scintille_ingest.glm.ingest import IngestedFile, ingest_glm_file
from scintille_ingest.glm.products import Satellite


@dataclass(frozen=True)
class Product:
    key: str
    start: datetime


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
        return [Product(p.key, p.start) for batch in listed for p in batch]

    async def fetch(self, product: Product) -> bytes:
        return await asyncio.to_thread(fetch, self._store, product.key)

    def parse(self, product: Product, data: bytes, received_at: datetime) -> IngestedFile:
        return ingest_glm_file(data, product.key, self._source, received_at)
