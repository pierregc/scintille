import hashlib
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pyarrow as pa
import pytest
from dagster import AssetCheckResult
from pyiceberg.catalog import Catalog
from pyiceberg.catalog.sql import SqlCatalog
from scintille_lake.migrate import migrate
from scintille_lake.tables import FLASHES, INGEST_LOG
from scintille_pipelines import checks, quality
from scintille_pipelines.resources import LakeResource, PostgresResource

DAY = datetime(2026, 7, 15, tzinfo=UTC)


class SqliteLake(LakeResource):
    path: str

    def catalog(self) -> Catalog:
        return SqlCatalog("t", uri=f"sqlite:///{self.path}/c.db", warehouse=f"file://{self.path}")


class FakePostgres(PostgresResource):
    spooled: list[str]

    @contextmanager
    def connect(self) -> Iterator[Any]:
        keys = self.spooled

        class Conn:
            def execute(self, sql: str, params: list[list[str]]) -> Any:
                class Rows:
                    def fetchall(self) -> list[tuple[str]]:
                        return [(k,) for k in params[0] if k in keys]

                return Rows()

        yield Conn()


def flash_rows(source: str, hour: int, files: int, per_file: int) -> list[dict[str, object]]:
    start = DAY + timedelta(hours=hour)
    return [
        {
            "flash_id": hashlib.sha256(f"{source}|{hour}|{f}|{i}".encode()).hexdigest()[:32],
            "source": source,
            "product_file": f"{source}-{hour:02d}-{f:04d}.nc",
            "native_flash_id": i,
            "event_time": start + timedelta(seconds=20 * f + i),
            "ingest_time": start,
            "lat": 1.0,
            "lon": 2.0,
            "energy_raw": 1.0,
            "energy_unit": "J",
            "intensity": None,
            "area_km2": 1.0,
            "duration_ms": 1.0,
            "quality": [],
            "parser_version": "t",
            "calibration_version": "t",
        }
        for f in range(files)
        for i in range(per_file)
    ]


def log_rows(source: str, hour: int, files: int, per_file: int) -> list[dict[str, object]]:
    start = DAY + timedelta(hours=hour)
    return [
        {
            "key": f"GLM/{source}-{hour:02d}-{f:04d}.nc",
            "source": source,
            "satellite": "G19",
            "product_start": start + timedelta(seconds=20 * f),
            "product_end": start + timedelta(seconds=20 * f + 20),
            "received_at": start,
            "row_count": per_file,
            "checksum": "sha256:x",
            "status": "ok",
            "parse_duration_ms": 1.0,
            "error": None,
        }
        for f in range(files)
    ]


@pytest.fixture
def lake(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> SqliteLake:
    resource = SqliteLake(path=str(tmp_path))
    catalog = resource.catalog()
    migrate(catalog)
    for identifier, rows in (
        (
            FLASHES.identifier,
            flash_rows("glm-east", 18, 180, 2) + flash_rows("glm-west", 18, 180, 1),
        ),
        (
            INGEST_LOG.identifier,
            log_rows("glm-east", 18, 180, 2) + log_rows("glm-west", 18, 180, 1),
        ),
    ):
        table = catalog.load_table(identifier)
        table.append(pa.Table.from_pylist(rows, schema=table.schema().as_arrow()))
    monkeypatch.setattr(checks, "clock", lambda: DAY + timedelta(hours=19, minutes=10))
    return resource


def run(check: object, **resources: object) -> AssetCheckResult:
    result = check(**resources)  # type: ignore[operator]
    assert isinstance(result, AssetCheckResult)
    return result


def append(lake: SqliteLake, identifier: tuple[str, str], rows: list[dict[str, object]]) -> None:
    table = lake.catalog().load_table(identifier)
    table.append(pa.Table.from_pylist(rows, schema=table.schema().as_arrow()))


def test_a_complete_hour_passes_every_hourly_check(lake: SqliteLake) -> None:
    assert run(checks.silver_completeness, lake=lake).passed
    assert run(checks.silver_ranges, lake=lake).passed
    assert run(checks.silver_volume, lake=lake).passed


def test_missing_files_fail_completeness(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    lake = SqliteLake(path=str(tmp_path))
    migrate(lake.catalog())
    append(
        lake,
        INGEST_LOG.identifier,
        log_rows("glm-east", 18, 170, 1) + log_rows("glm-west", 18, 180, 1),
    )
    monkeypatch.setattr(checks, "clock", lambda: DAY + timedelta(hours=19, minutes=10))
    result = run(checks.silver_completeness, lake=lake)
    assert not result.passed
    assert "glm-east" in str(result.metadata["short"].value)


def test_a_duplicated_batch_in_a_closed_partition_fails_uniqueness(
    lake: SqliteLake, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(checks, "clock", lambda: DAY + timedelta(days=1, hours=2))
    assert run(checks.silver_uniqueness, lake=lake).passed
    append(lake, FLASHES.identifier, flash_rows("glm-east", 18, 3, 2))
    result = run(checks.silver_uniqueness, lake=lake)
    assert not result.passed
    assert result.metadata["duplicates"].value == 6


def test_reconciliation_catches_a_mismatch(
    lake: SqliteLake, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(checks, "clock", lambda: DAY + timedelta(days=1, hours=2))
    keys = [
        str(r["key"]) for r in log_rows("glm-east", 18, 180, 2) + log_rows("glm-west", 18, 180, 1)
    ]
    assert run(checks.silver_reconciliation, lake=lake, postgres=FakePostgres(spooled=keys)).passed
    assert not run(
        checks.silver_reconciliation, lake=lake, postgres=FakePostgres(spooled=keys[1:])
    ).passed
    append(
        lake, FLASHES.identifier, [{**flash_rows("glm-west", 18, 1, 1)[0], "flash_id": "f" * 32}]
    )
    assert not run(
        checks.silver_reconciliation, lake=lake, postgres=FakePostgres(spooled=keys)
    ).passed


def test_freshness_and_volume_rules() -> None:
    now = DAY + timedelta(hours=12)
    assert quality.freshness({"glm-east": now - timedelta(minutes=5)}, now).passed
    assert not quality.freshness(
        {"glm-east": now - timedelta(hours=1), "glm-west": None}, now
    ).passed
    assert quality.volume_anomaly(100, [90, 110, 100]).passed
    assert not quality.volume_anomaly(5, [90, 110, 100]).passed
    assert quality.volume_anomaly(5, []).passed


def test_ranges_rule_flags_each_kind() -> None:
    import polars as pl

    flashes = pl.DataFrame(
        {
            "product_file": ["a.nc"] * 4,
            "lat": [0.0, 95.0, 0.0, 0.0],
            "lon": [0.0, 0.0, 0.0, 0.0],
            "energy_raw": [1.0, 1.0, 0.0, 1.0],
            "event_time": [DAY, DAY, DAY, DAY + timedelta(hours=1)],
        }
    )
    log = pl.DataFrame(
        {"key": ["x/a.nc"], "product_start": [DAY], "product_end": [DAY + timedelta(seconds=20)]}
    )
    outcome = quality.ranges(flashes, log)
    assert not outcome.passed
    assert outcome.metadata["violations"] == {"lat": 1, "lon": 0, "energy": 1, "event_time": 1}
