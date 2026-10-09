"""lake-writer against the local Lakekeeper and Postgres from compose.yaml."""

import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import polars as pl
import pytest
from scintille_ingest.glm.ingest import IngestedFile
from scintille_ingest.glm.parse import FLASH_SCHEMA
from scintille_ingest.ingest_log import IngestLogRecord
from scintille_ingest.runtime.lake_commit import LakeCommit
from scintille_ingest.runtime.service import IngestLive
from scintille_ingest.runtime.sources import Product
from scintille_ingest.runtime.spool import Spool
from scintille_ingest.runtime.state import MemoryState
from scintille_lake.config import LakeConfig
from scintille_lake.connect import pyiceberg_catalog
from scintille_lake.locks import partition_locks
from scintille_lake.migrate import migrate
from scintille_lake.tables import FLASHES, INGEST_LOG

pytestmark = pytest.mark.lake
DSN = "postgresql://postgres:postgres@localhost:55432/scintille"


def test_spool_to_lakekeeper_once(tmp_path: Path) -> None:
    run = uuid4().hex[:8]
    start = datetime(2031, 1, 1, tzinfo=UTC)
    products = [Product(f"stack/{run}-{i}.nc", start + timedelta(minutes=i)) for i in range(3)]

    class Source:
        name = "glm-west"
        cadence = 1.0

        async def list_recent(self, now: datetime) -> list[Product]:
            return products

        async def fetch(self, product: Product) -> bytes:
            return product.key.encode()

        def parse(self, product: Product, data: bytes, received_at: datetime) -> IngestedFile:
            name = product.key.rsplit("/", 1)[-1]
            rows: list[dict[str, object]] = [
                {
                    "flash_id": f"{uuid4().hex}",
                    "source": "glm-west",
                    "product_file": name,
                    "native_flash_id": i,
                    "event_time": product.start,
                    "ingest_time": received_at,
                    "lat": 0.0,
                    "lon": 0.0,
                    "energy_raw": 1.0,
                    "energy_unit": "J",
                    "intensity": None,
                    "area_km2": 1.0,
                    "duration_ms": 1.0,
                    "quality": [],
                }
                for i in range(4)
            ]
            log = IngestLogRecord(
                product.key,
                "glm-west",
                "G18",
                product.start,
                product.start,
                received_at,
                4,
                "sha256:x",
                "ok",
                1.0,
            )
            return IngestedFile(pl.DataFrame(rows, schema=FLASH_SCHEMA), log)

    catalog = pyiceberg_catalog(LakeConfig())
    migrate(catalog)
    spool = Spool(tmp_path)
    asyncio.run(IngestLive([Source()], MemoryState(), spool, clock=lambda: start).poll(Source()))
    commit = LakeCommit(lambda: pyiceberg_catalog(LakeConfig()), lambda k: partition_locks(DSN, k))
    commit(spool, spool.pending())
    # Same files ingested again from scratch: same batch ids, nothing appended.
    spool_rewritten = Spool(tmp_path / "again")
    asyncio.run(
        IngestLive([Source()], MemoryState(), spool_rewritten, clock=lambda: start).poll(Source())
    )
    commit(spool_rewritten, spool_rewritten.pending())

    silver = catalog.load_table(FLASHES.identifier).scan(row_filter=f"product_file == '{run}-0.nc'")
    bronze = catalog.load_table(INGEST_LOG.identifier).scan(
        row_filter=f"key == '{products[0].key}'"
    )
    assert silver.to_arrow().num_rows == 4
    assert bronze.to_arrow().num_rows == 1
