import asyncio
import hashlib
from collections.abc import Iterable
from contextlib import AbstractContextManager, nullcontext
from datetime import UTC, datetime, timedelta
from pathlib import Path

import polars as pl
import pyarrow.compute as pc
import pytest
from pyiceberg.catalog import Catalog
from pyiceberg.catalog.sql import SqlCatalog
from scintille_ingest.glm.ingest import IngestedFile
from scintille_ingest.glm.parse import FLASH_SCHEMA
from scintille_ingest.ingest_log import IngestLogRecord
from scintille_ingest.runtime.lake_commit import LakeCommit, committed_batches
from scintille_ingest.runtime.lake_writer import LakeWriter
from scintille_ingest.runtime.service import IngestLive
from scintille_ingest.runtime.sources import Product
from scintille_ingest.runtime.spool import Spool
from scintille_ingest.runtime.state import MemoryState
from scintille_lake.migrate import migrate
from scintille_lake.tables import FLASHES, INGEST_LOG

HOUR = datetime(2026, 7, 15, 18, tzinfo=UTC)


class Source:
    """Twelve files over one hour, five flashes each; the last file is unreadable."""

    name = "glm-east"
    cadence = 1.0

    def __init__(self) -> None:
        self.products = [
            Product(f"glm/{i:02d}.nc", HOUR + timedelta(minutes=5 * i)) for i in range(12)
        ]

    async def list_recent(self, now: datetime) -> list[Product]:
        return self.products

    async def fetch(self, product: Product) -> bytes:
        return product.key.encode()

    def parse(self, product: Product, data: bytes, received_at: datetime) -> IngestedFile:
        n = 0 if product.key.endswith("11.nc") else 5
        rows: list[dict[str, object]] = [
            {
                "flash_id": hashlib.sha256(f"{product.key}|{i}".encode()).hexdigest()[:32],
                "source": "glm-east",
                "product_file": product.key.rsplit("/", 1)[-1],
                "native_flash_id": i,
                "event_time": product.start + timedelta(seconds=i),
                "ingest_time": received_at,
                "lat": 1.0,
                "lon": 2.0,
                "energy_raw": 1e-14,
                "energy_unit": "J",
                "intensity": None,
                "area_km2": 80.0,
                "duration_ms": 250.0,
                "quality": [],
            }
            for i in range(n)
        ]
        log = IngestLogRecord(
            product.key,
            "glm-east",
            "G19",
            product.start,
            product.start + timedelta(seconds=20),
            received_at,
            n,
            "sha256:x",
            "ok" if n else "failed",
            1.0,
            None if n else "OSError",
        )
        return IngestedFile(pl.DataFrame(rows, schema=FLASH_SCHEMA), log)


@pytest.fixture
def catalog(tmp_path: Path) -> Catalog:
    catalog = SqlCatalog("t", uri=f"sqlite:///{tmp_path}/c.db", warehouse=f"file://{tmp_path}/w")
    migrate(catalog)
    return catalog


def spool_hour(tmp_path: Path, state: MemoryState | None = None) -> Spool:
    spool = Spool(tmp_path / "spool")
    asyncio.run(
        IngestLive([Source()], state or MemoryState(), spool, clock=lambda: HOUR).poll(Source())
    )
    return spool


def counts(catalog: Catalog) -> tuple[int, int]:
    silver = catalog.load_table(FLASHES.identifier).scan().to_arrow().num_rows
    bronze = catalog.load_table(INGEST_LOG.identifier).scan().to_arrow().num_rows
    return silver, bronze


def test_commits_every_batch_then_empties_the_spool(tmp_path: Path, catalog: Catalog) -> None:
    spool = spool_hour(tmp_path)
    LakeCommit(lambda: catalog)(spool, spool.pending())
    assert spool.pending() == []
    assert counts(catalog) == (55, 12)


def test_hourly_silver_counts_match_the_ingest_log(tmp_path: Path, catalog: Catalog) -> None:
    spool = spool_hour(tmp_path)
    LakeCommit(lambda: catalog)(spool, spool.pending())
    silver = pl.from_arrow(catalog.load_table(FLASHES.identifier).scan().to_arrow())
    bronze = pl.from_arrow(catalog.load_table(INGEST_LOG.identifier).scan().to_arrow())
    assert isinstance(silver, pl.DataFrame) and isinstance(bronze, pl.DataFrame)
    by_hour = silver.group_by(pl.col("event_time").dt.truncate("1h")).len().sort("event_time")
    logged = bronze.group_by(pl.col("product_start").dt.truncate("1h")).agg(
        pl.col("row_count").sum()
    )
    assert by_hour["len"].to_list() == logged.sort("product_start")["row_count"].to_list() == [55]


def test_crash_after_commit_before_spool_delete_appends_nothing_more(
    tmp_path: Path, catalog: Catalog
) -> None:
    spool = spool_hour(tmp_path)

    def crash(table: str) -> None:
        if table == "bronze":
            raise SystemExit("killed")

    with pytest.raises(SystemExit):
        LakeCommit(lambda: catalog, after_commit=crash)(spool, spool.pending())
    assert len(spool.pending()) == 12
    LakeCommit(lambda: catalog)(spool, spool.pending())
    assert counts(catalog) == (55, 12)
    assert spool.pending() == []


def test_crash_between_silver_and_bronze_completes_bronze_only(
    tmp_path: Path, catalog: Catalog
) -> None:
    spool = spool_hour(tmp_path)

    def crash(table: str) -> None:
        if table == "silver":
            raise SystemExit("killed")

    with pytest.raises(SystemExit):
        LakeCommit(lambda: catalog, after_commit=crash)(spool, spool.pending())
    assert counts(catalog) == (55, 0)
    LakeCommit(lambda: catalog)(spool, spool.pending())
    assert counts(catalog) == (55, 12)


def test_reingesting_an_hour_creates_no_duplicates(tmp_path: Path, catalog: Catalog) -> None:
    spool = spool_hour(tmp_path)
    LakeCommit(lambda: catalog)(spool, spool.pending())
    again = spool_hour(tmp_path, MemoryState())
    LakeCommit(lambda: catalog)(again, again.pending())
    silver = catalog.load_table(FLASHES.identifier).scan().to_arrow()
    assert silver.num_rows == 55
    assert len(pc.unique(silver["flash_id"])) == 55


def test_catalog_outage_loses_nothing(tmp_path: Path, catalog: Catalog) -> None:
    spool = spool_hour(tmp_path)
    up = {"value": False}

    def flaky() -> Catalog:
        if not up["value"]:
            raise ConnectionError("catalog unavailable")
        return catalog

    writer = LakeWriter(spool, commit=LakeCommit(flaky), interval=0.01)
    for _ in range(3):
        with pytest.raises(ConnectionError):
            writer.drain_once()
    assert len(spool.pending()) == 12
    up["value"] = True
    writer.drain_once()
    assert counts(catalog) == (55, 12)


def test_takes_the_partition_locks_it_writes(tmp_path: Path, catalog: Catalog) -> None:
    taken: list[set[str]] = []

    def locker(keys: Iterable[str]) -> AbstractContextManager[object]:
        taken.append(set(keys))
        return nullcontext()

    spool = spool_hour(tmp_path)
    LakeCommit(lambda: catalog, locker=locker)(spool, spool.pending())
    assert taken == [{"silver.flashes/2026-07-15/glm-east"}]


def test_batches_are_recorded_in_snapshot_properties(tmp_path: Path, catalog: Catalog) -> None:
    spool = spool_hour(tmp_path)
    batches = set(spool.pending())
    LakeCommit(lambda: catalog, max_batches=5)(spool, sorted(batches))
    assert committed_batches(catalog.load_table(FLASHES.identifier)) == batches
    assert len(catalog.load_table(FLASHES.identifier).metadata.snapshots) == 3
