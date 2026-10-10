import hashlib
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pyarrow as pa
import pytest
from dagster import (
    AssetCheckResult,
    AssetChecksDefinition,
    AssetSelection,
    DagsterInstance,
    Definitions,
    build_run_status_sensor_context,
    define_asset_job,
)
from pyiceberg.catalog import Catalog
from pyiceberg.catalog.sql import SqlCatalog
from scintille_lake.migrate import migrate
from scintille_lake.tables import FLASHES, INGEST_LOG
from scintille_pipelines import alerts, checks, quality
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
            def execute(self, sql: str, params: list[object]) -> Any:
                class Rows:
                    def fetchall(self) -> list[tuple[str, str]]:
                        return [(k, "glm-east" if "_G19_" in k else "glm-west") for k in keys]

                return Rows()

        yield Conn()


PLATFORM = {"glm-east": "G19", "glm-west": "G18"}


def glm_name(source: str, hour: int, f: int) -> str:
    start = DAY + timedelta(hours=hour, seconds=20 * f)
    stamp = f"{start:%Y%j%H%M%S}0"
    return f"OR_GLM-L2-LCFA_{PLATFORM[source]}_s{stamp}_e{stamp}_c{stamp}.nc"


def flash_rows(source: str, hour: int, files: int, per_file: int) -> list[dict[str, object]]:
    start = DAY + timedelta(hours=hour)
    return [
        {
            "flash_id": hashlib.sha256(f"{source}|{hour}|{f}|{i}".encode()).hexdigest()[:32],
            "source": source,
            "product_file": glm_name(source, hour, f),
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
            "key": f"GLM-L2-LCFA/2026/196/{hour:02d}/{glm_name(source, hour, f)}",
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


def all_keys() -> list[str]:
    return [
        str(r["key"]) for r in log_rows("glm-east", 18, 180, 2) + log_rows("glm-west", 18, 180, 1)
    ]


def test_reconciliation_names_spooled_files_missing_from_bronze(
    lake: SqliteLake, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(checks, "clock", lambda: DAY + timedelta(days=1, hours=2))
    lost = f"GLM-L2-LCFA/2026/196/18/{glm_name('glm-east', 18, 180)}"
    result = run(
        checks.silver_reconciliation, lake=lake, postgres=FakePostgres(spooled=[*all_keys(), lost])
    )
    assert not result.passed
    missing = result.metadata["spooled_not_in_bronze"].value
    assert missing == {"count": 1, "files": [lost.rsplit("/", 1)[-1]]}


def test_reconciliation_fails_when_bronze_is_empty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lake = SqliteLake(path=str(tmp_path))
    migrate(lake.catalog())
    monkeypatch.setattr(checks, "clock", lambda: DAY + timedelta(days=1, hours=2))
    result = run(checks.silver_reconciliation, lake=lake, postgres=FakePostgres(spooled=all_keys()))
    assert not result.passed
    missing = result.metadata["spooled_not_in_bronze"].value
    assert isinstance(missing, dict) and missing["count"] == 360


def test_reconciliation_names_silver_files_missing_from_bronze(
    lake: SqliteLake, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(checks, "clock", lambda: DAY + timedelta(days=1, hours=2))
    stray = flash_rows("glm-east", 19, 1, 1)
    append(lake, FLASHES.identifier, stray)
    result = run(checks.silver_reconciliation, lake=lake, postgres=FakePostgres(spooled=all_keys()))
    assert not result.passed
    assert result.metadata["silver_without_bronze"].value == {
        "count": 1,
        "files": [stray[0]["product_file"]],
    }


def test_product_hour_reads_the_goes_start_time() -> None:
    assert quality.product_hour(glm_name("glm-east", 18, 179)) == DAY + timedelta(hours=18)
    assert quality.product_hour("unknown.nc") is None


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


class BrokenLake(LakeResource):
    def catalog(self) -> Catalog:
        raise ConnectionError("catalog unreachable")


def alerts_for(
    check: AssetChecksDefinition, lake: LakeResource, monkeypatch: pytest.MonkeyPatch
) -> tuple[bool, list[dict[str, Any]]]:
    """Runs `check` as a scheduled job would, then feeds a failed run to the alert sensor."""
    sent: list[dict[str, Any]] = []
    monkeypatch.setenv("SCINTILLE_ALERT_WEBHOOK", "https://alerts.test/hook")
    monkeypatch.setattr(alerts, "post_json", lambda url, payload: sent.append(payload))
    job = define_asset_job("checks", selection=AssetSelection.checks(check))
    defs = Definitions(
        assets=[checks.SILVER], asset_checks=[check], jobs=[job], resources={"lake": lake}
    )
    instance = DagsterInstance.ephemeral()
    result = defs.resolve_job_def("checks").execute_in_process(
        instance=instance, raise_on_error=False
    )
    if not result.success:
        context = build_run_status_sensor_context(
            sensor_name="alert_on_failure",
            dagster_event=result.get_run_failure_event(),
            dagster_instance=instance,
            dagster_run=result.dagster_run,
        ).for_run_failure()
        alerts.alert_on_failure(context)
    return result.success, sent


def test_a_failed_error_check_alerts(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    empty = SqliteLake(path=str(tmp_path))
    migrate(empty.catalog())
    monkeypatch.setattr(checks, "clock", lambda: DAY + timedelta(hours=19, minutes=10))
    success, sent = alerts_for(checks.silver_completeness, empty, monkeypatch)
    assert not success
    assert len(sent) == 1 and sent[0]["job"] == "checks"


def test_a_crashing_check_alerts(monkeypatch: pytest.MonkeyPatch) -> None:
    success, sent = alerts_for(checks.silver_freshness, BrokenLake(), monkeypatch)
    assert not success
    assert len(sent) == 1


def test_a_volume_warning_does_not_alert(lake: SqliteLake, monkeypatch: pytest.MonkeyPatch) -> None:
    for d in range(1, 4):
        append(
            lake,
            FLASHES.identifier,
            [
                {**r, "event_time": r["event_time"] - timedelta(days=d)}  # type: ignore[operator]
                for r in flash_rows("glm-east", 18, 180, 20)
            ],
        )
    success, sent = alerts_for(checks.silver_volume, lake, monkeypatch)
    assert success and not sent


def test_every_error_check_is_blocking() -> None:
    blocking = {
        spec.name: spec.blocking for c in checks.HOURLY + checks.DAILY for spec in c.check_specs
    }
    assert blocking == {
        "silver_freshness": True,
        "silver_completeness": True,
        "silver_ranges": True,
        "silver_volume": False,
        "silver_uniqueness": True,
        "silver_reconciliation": True,
    }


@pytest.mark.lake
def test_reconciliation_reads_spooled_files_from_postgres(
    lake: SqliteLake, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(checks, "clock", lambda: DAY + timedelta(days=1, hours=2))
    postgres = PostgresResource()
    lost = f"GLM-L2-LCFA/2026/196/18/{glm_name('glm-west', 18, 180)}"
    other_day = f"GLM-L2-LCFA/2026/197/01/{glm_name('glm-west', 25, 0)}"
    with postgres.connect() as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS ingest_files (key text NOT NULL, checksum text NOT NULL,"
            " source text NOT NULL, state text NOT NULL, batch_id text,"
            " updated_at timestamptz NOT NULL, PRIMARY KEY (key, checksum))"
        )
        conn.execute("DELETE FROM ingest_files WHERE key LIKE 'GLM-L2-LCFA/2026/19%'")
        for key in [*all_keys(), lost, other_day]:
            source = "glm-east" if "_G19_" in key else "glm-west"
            for checksum in ("sha256:a", "sha256:b"):
                conn.execute(
                    "INSERT INTO ingest_files VALUES (%s, %s, %s, 'spooled', NULL, now())",
                    [key, checksum, source],
                )
    result = run(checks.silver_reconciliation, lake=lake, postgres=postgres)
    assert not result.passed
    assert result.metadata["spooled_not_in_bronze"].value == {
        "count": 1,
        "files": [lost.rsplit("/", 1)[-1]],
    }
    assert result.metadata["mismatches"].value == [
        {
            "source": "glm-west",
            "hour": 18,
            "spooled_files": 181,
            "bronze_files": 180,
            "bronze_rows": 180,
            "silver_and_quarantine_rows": 180,
        }
    ]
