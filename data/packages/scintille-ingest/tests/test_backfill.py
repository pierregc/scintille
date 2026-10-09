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
from scintille_ingest.backfill import IncompletePartition, backfill_partition
from scintille_ingest.glm.ingest import IngestedFile
from scintille_ingest.glm.parse import FLASH_SCHEMA
from scintille_ingest.ingest_log import IngestLogRecord
from scintille_ingest.runtime.sources import Product
from scintille_lake.migrate import migrate
from scintille_lake.tables import FLASHES, INGEST_LOG

DAY = date(2026, 7, 15)
# A coarse day (one file every 10 minutes) keeps the tests fast; the rules are the same.
FILES = 144
START = datetime(2026, 7, 15, tzinfo=UTC)


class Upstream:
    """A day of files, plus one on each side of it."""

    def __init__(self, missing: int = 0, fail_at: int | None = None) -> None:
        step = timedelta(days=1) / FILES
        self.products = [Product(f"GLM/{i:05d}.nc", START + step * i) for i in range(-1, FILES + 1)]
        self.products = self.products[missing:]
        self.fail_at = fail_at
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
                "lat": 1.0,
                "lon": 2.0,
                "energy_raw": 1e-14,
                "energy_unit": "J",
                "intensity": None,
                "area_km2": 50.0,
                "duration_ms": 200.0,
                "quality": [],
            }
            for i in range(3)
        ]
        log = IngestLogRecord(
            product.key,
            "glm-west",
            "G18",
            product.start,
            product.start + timedelta(seconds=20),
            received_at,
            3,
            "sha256:x",
            "ok",
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
