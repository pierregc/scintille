from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import polars as pl
import pyarrow as pa
import pytest
from dagster import AssetCheckResult, AssetChecksDefinition
from obstore.store import LocalStore
from pyiceberg.catalog import Catalog
from pyiceberg.catalog.sql import SqlCatalog
from scintille_lake.maintenance import object_key
from scintille_lake.migrate import migrate
from scintille_lake.tables import FLASHES
from scintille_pipelines import checks
from scintille_pipelines.maintenance import (
    MB,
    closed_partitions,
    lake_file_sizes,
    lake_orphan_inventory,
    partition_file_stats,
    uncompacted,
)
from scintille_pipelines.resources import LakeResource, R2Resource

NOW = datetime(2026, 7, 20, 2, tzinfo=UTC)


def add_flashes(catalog: Catalog, sources: list[str], when: datetime) -> None:
    table = catalog.load_table(FLASHES.identifier)
    row = {
        "product_file": "test.nc",
        "event_time": when,
        "ingest_time": when,
        "lat": 0.0,
        "lon": 0.0,
        "energy_raw": 1.0,
        "energy_unit": "J",
        "area_km2": 1.0,
        "duration_ms": 1.0,
        "quality": [],
        "parser_version": "test",
        "calibration_version": "test",
    }
    rows = [
        {**row, "flash_id": f"{i:032x}", "source": s, "native_flash_id": i}
        for i, s in enumerate(sources)
    ]
    table.append(pa.Table.from_pylist(rows, schema=table.schema().as_arrow()))


def run(check: AssetChecksDefinition, **resources: object) -> AssetCheckResult:
    result = check(**resources)
    assert isinstance(result, AssetCheckResult)
    return result


class SqliteLake(LakeResource):
    path: str

    def catalog(self) -> Catalog:
        return SqlCatalog(
            "test", uri=f"sqlite:///{self.path}/catalog.db", warehouse=f"file://{self.path}"
        )


class LocalR2(R2Resource):
    root: str = "/"

    def store(self) -> LocalStore:
        return LocalStore(self.root)


@pytest.fixture
def lake(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> SqliteLake:
    monkeypatch.setattr(checks, "clock", lambda: NOW)
    resource = SqliteLake(path=str(tmp_path))
    migrate(resource.catalog())
    return resource


def stats(rows: list[tuple[date | None, int, float]]) -> pl.DataFrame:
    return pl.DataFrame(
        [
            {"partition": f"p{i}", "day": d, "files": n, "bytes": int(n * mb * MB), "avg_mb": mb}
            for i, (d, n, mb) in enumerate(rows)
        ]
    )


def test_closed_partitions_wait_a_day_after_midnight() -> None:
    frame = stats([(date(2026, 7, d), 1, 100.0) for d in range(10, 20)] + [(None, 1, 1.0)])
    closed = closed_partitions(frame, NOW, 7)
    assert closed["day"].to_list() == [date(2026, 7, d) for d in range(12, 19)]


def test_uncompacted_partitions() -> None:
    frame = stats([(None, 1, 0.01), (None, 288, 0.3), (None, 3, 100.0), (None, 2, 900.0)])
    assert uncompacted(frame)["partition"].to_list() == ["p1", "p3"]


def test_partition_stats_from_a_table(lake: SqliteLake) -> None:
    catalog = lake.catalog()
    for hour in (1, 2):
        add_flashes(catalog, ["glm-east", "glm-west"], datetime(2026, 7, 15, hour, tzinfo=UTC))
    frame = partition_file_stats(catalog.load_table(FLASHES.identifier))
    assert frame["files"].to_list() == [2, 2]
    assert frame["day"].to_list() == [date(2026, 7, 15)] * 2
    assert frame["partition"][0] == "event_day=2026-07-15,source=glm-east"


def test_file_size_check_flags_small_files(lake: SqliteLake) -> None:
    result = run(lake_file_sizes, lake=lake)
    assert result.passed
    add_flashes(lake.catalog(), ["glm-east"], datetime(2026, 7, 18, 1, tzinfo=UTC))
    add_flashes(lake.catalog(), ["glm-east"], datetime(2026, 7, 18, 2, tzinfo=UTC))
    result = run(lake_file_sizes, lake=lake)
    assert not result.passed
    assert result.metadata["count"].value == "1"


def test_orphan_check_lists_only_unreferenced_files(
    lake: SqliteLake, monkeypatch: pytest.MonkeyPatch
) -> None:
    add_flashes(lake.catalog(), ["glm-east"], datetime(2026, 7, 15, 1, tzinfo=UTC))
    monkeypatch.setattr(checks, "clock", lambda: datetime.now(UTC) + timedelta(days=30))
    assert run(lake_orphan_inventory, lake=lake, r2=LocalR2()).passed
    table = lake.catalog().load_table(FLASHES.identifier)
    stray = Path("/" + object_key(table.location())) / "data" / "stray.parquet"
    stray.write_bytes(b"x")
    monkeypatch.setattr(checks, "clock", lambda: datetime.now(UTC))
    assert run(lake_orphan_inventory, lake=lake, r2=LocalR2()).passed
    monkeypatch.setattr(checks, "clock", lambda: datetime.now(UTC) + timedelta(days=30))
    result = run(lake_orphan_inventory, lake=lake, r2=LocalR2())
    assert not result.passed
    assert result.metadata["sample"].value == [object_key(str(stray))]
