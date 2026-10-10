import asyncio
import hashlib
import threading
import time
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import polars as pl
import pyarrow as pa
import pytest
from pyiceberg.catalog import Catalog
from pyiceberg.catalog.sql import SqlCatalog
from scintille_ingest.backfill import DayNotClosed, IncompletePartition, backfill_partition
from scintille_ingest.glm.ingest import IngestedFile
from scintille_ingest.glm.parse import FLASH_SCHEMA
from scintille_ingest.ingest_log import IngestLogRecord
from scintille_ingest.runtime.lake_commit import LakeCommit
from scintille_ingest.runtime.service import IngestLive
from scintille_ingest.runtime.sources import Product
from scintille_ingest.runtime.spool import Spool
from scintille_ingest.runtime.state import MemoryState
from scintille_lake.migrate import migrate
from scintille_lake.tables import FLASHES, FLASHES_QUARANTINE, INGEST_LOG

DAY = date(2026, 7, 15)
# A coarse day (one file every 10 minutes) keeps the tests fast; the rules are the same.
FILES = 144
START = datetime(2026, 7, 15, tzinfo=UTC)


class Upstream:
    """A day of files, plus one on each side of it."""

    def __init__(
        self,
        missing: int = 0,
        fail_at: int | None = None,
        unreadable: bool = False,
        bad_lat: bool = False,
    ) -> None:
        step = timedelta(days=1) / FILES
        self.products = [Product(f"GLM/{i:05d}.nc", START + step * i) for i in range(-1, FILES + 1)]
        self.products = self.products[missing:]
        self.fail_at = fail_at
        self.unreadable = unreadable
        self.bad_lat = bad_lat
        self.fetched = 0

    def list_hour(self, hour: datetime) -> list[Product]:
        return [p for p in self.products if hour <= p.start < hour + timedelta(hours=1)]

    def fetch(self, product: Product) -> bytes:
        self.fetched += 1
        if self.fail_at is not None and self.fetched >= self.fail_at:
            raise ConnectionError("network down")
        return product.key.encode()

    def parse(self, product: Product, data: bytes, received_at: datetime) -> IngestedFile:
        rows: list[dict[str, object]] = [
            {
                "flash_id": hashlib.sha256(f"{product.key}|{i}".encode()).hexdigest()[:32],
                "source": "glm-west",
                "product_file": product.key.rsplit("/", 1)[-1],
                "native_flash_id": i,
                "event_time": product.start + timedelta(seconds=7 * i),
                "ingest_time": received_at,
                "lat": 95.0 if self.bad_lat and i == 0 else 1.0,
                "lon": 2.0,
                "energy_raw": 1e-14,
                "energy_unit": "J",
                "intensity": None,
                "area_km2": 50.0,
                "duration_ms": 200.0,
                "quality": [],
            }
            for i in range(0 if self.unreadable else 3)
        ]
        log = IngestLogRecord(
            product.key,
            "glm-west",
            "G18",
            product.start,
            product.start + timedelta(seconds=20),
            received_at,
            len(rows),
            "sha256:x",
            "failed" if self.unreadable else "ok",
            1.0,
        )
        return IngestedFile(pl.DataFrame(rows, schema=FLASH_SCHEMA), log)


@pytest.fixture
def catalog(tmp_path: Path) -> Catalog:
    catalog = SqlCatalog("t", uri=f"sqlite:///{tmp_path}/c.db", warehouse=f"file://{tmp_path}/w")
    migrate(catalog)
    return catalog


def run(upstream: Upstream, catalog: Catalog, **kwargs: object) -> object:
    return backfill_partition(
        DAY,
        "glm-west",
        list_hour=upstream.list_hour,
        fetch=upstream.fetch,
        parse=upstream.parse,
        catalog=catalog,
        parser_version="glm-1",
        workers=4,
        expected_files=FILES,
        **kwargs,  # type: ignore[arg-type]
    )


def silver(catalog: Catalog) -> pa.Table:
    return catalog.load_table(FLASHES.identifier).scan().to_arrow()


def test_rebuilds_the_day_exactly(catalog: Catalog) -> None:
    run(Upstream(), catalog)
    rows = silver(catalog)
    times = sorted(t for t in rows["event_time"].to_pylist() if t is not None)
    assert times[0] >= START and times[-1] < START + timedelta(days=1)
    assert rows.num_rows == FILES * 3
    assert catalog.load_table(INGEST_LOG.identifier).scan().to_arrow().num_rows == FILES


def test_rerunning_a_partition_leaves_counts_unchanged(catalog: Catalog) -> None:
    run(Upstream(), catalog)
    run(Upstream(), catalog)
    assert silver(catalog).num_rows == FILES * 3
    assert catalog.load_table(INGEST_LOG.identifier).scan().to_arrow().num_rows == FILES


def test_missing_files_or_an_interruption_leave_the_partition_untouched(catalog: Catalog) -> None:
    run(Upstream(), catalog)
    snapshot = catalog.load_table(FLASHES.identifier).current_snapshot()
    with pytest.raises(IncompletePartition):
        run(Upstream(missing=10), catalog)
    with pytest.raises(ConnectionError):
        run(Upstream(fail_at=70), catalog)
    assert catalog.load_table(FLASHES.identifier).current_snapshot() == snapshot
    assert silver(catalog).num_rows == FILES * 3


def test_waits_for_lake_writer_on_the_same_partition(catalog: Catalog) -> None:
    lock = threading.Lock()
    held: list[str] = []
    order: list[str] = []

    @contextmanager
    def locker(keys: Iterable[str]) -> Iterator[None]:
        held.extend(keys)
        with lock:
            order.append("backfill writes")
            yield

    def lake_writer() -> None:
        with lock:
            order.append("lake-writer writes")
            time.sleep(0.3)

    other = threading.Thread(target=lake_writer)
    other.start()
    time.sleep(0.05)
    run(Upstream(), catalog, locker=locker)
    other.join()
    assert held == ["silver.flashes/2026-07-15/glm-west"]
    assert order == ["lake-writer writes", "backfill writes"]


def quarantine(catalog: Catalog) -> pa.Table:
    return catalog.load_table(FLASHES_QUARANTINE.identifier).scan().to_arrow()


def test_unreadable_files_leave_the_partition_untouched(catalog: Catalog) -> None:
    run(Upstream(), catalog)
    snapshot = catalog.load_table(FLASHES.identifier).current_snapshot()
    with pytest.raises(IncompletePartition, match="readable"):
        run(Upstream(unreadable=True), catalog)
    assert catalog.load_table(FLASHES.identifier).current_snapshot() == snapshot
    assert silver(catalog).num_rows == FILES * 3


def test_quarantine_is_replaced_not_appended(catalog: Catalog) -> None:
    run(Upstream(bad_lat=True), catalog)
    run(Upstream(bad_lat=True), catalog)
    assert quarantine(catalog).num_rows == FILES
    assert silver(catalog).num_rows == FILES * 2
    run(Upstream(), catalog)
    assert quarantine(catalog).num_rows == 0
    assert silver(catalog).num_rows == FILES * 3


def test_a_reprocessed_upstream_file_is_read_once(catalog: Catalog) -> None:
    upstream = Upstream()
    original = upstream.products[10]
    upstream.products.append(Product(original.key.replace(".nc", "_v2.nc"), original.start))
    run(upstream, catalog)
    rows = silver(catalog)
    assert rows.num_rows == FILES * 3
    assert len(set(rows["flash_id"].to_pylist())) == rows.num_rows
    assert catalog.load_table(INGEST_LOG.identifier).scan().to_arrow().num_rows == FILES


class LiveSource:
    """The hot path's view of the same upstream files."""

    name = "glm-west"
    cadence = 1.0

    def __init__(self, upstream: Upstream, products: list[Product]) -> None:
        self.upstream, self.products = upstream, products

    async def list_recent(self, now: datetime) -> list[Product]:
        return self.products

    async def fetch(self, product: Product) -> bytes:
        return self.upstream.fetch(product)

    def parse(self, product: Product, data: bytes, received_at: datetime) -> IngestedFile:
        return self.upstream.parse(product, data, received_at)


def test_a_live_batch_drained_after_the_rebuild_does_not_duplicate(
    tmp_path: Path, catalog: Catalog
) -> None:
    upstream = Upstream()
    spool = Spool(tmp_path / "spool")
    live = LiveSource(upstream, upstream.products[:3] + upstream.products[-2:])
    service = IngestLive([live], MemoryState(), spool, clock=lambda: START)
    asyncio.run(service.poll(live))
    assert len(spool.pending()) == 5
    run(upstream, catalog)
    LakeCommit(lambda: catalog)(spool, spool.pending())
    rows = silver(catalog)
    times = [t for t in rows["event_time"].to_pylist() if t is not None]
    day_rows = [t for t in times if START <= t < START + timedelta(days=1)]
    assert len(day_rows) == FILES * 3
    assert len(set(rows["flash_id"].to_pylist())) == rows.num_rows
    log = catalog.load_table(INGEST_LOG.identifier).scan().to_arrow()
    assert len(set(log["key"].to_pylist())) == log.num_rows


def test_refuses_a_day_still_being_written(catalog: Catalog) -> None:
    with pytest.raises(DayNotClosed):
        run(Upstream(), catalog, now=lambda: START + timedelta(days=1, minutes=30))
    assert silver(catalog).num_rows == 0
