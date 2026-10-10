from datetime import UTC, date, datetime
from pathlib import Path

import pyarrow as pa
import pytest
from dagster import EnvVar, RunRequest, build_schedule_context, build_sensor_context, materialize
from pyiceberg.catalog import Catalog
from pyiceberg.catalog.sql import SqlCatalog
from scintille_lake.migrate import migrate
from scintille_lake.tables import FLASHES
from scintille_pipelines import automation
from scintille_pipelines.alerts import failure_payload
from scintille_pipelines.assets import (
    DAILY_FLASH_COUNTS,
    check_counts,
    count_by_source,
    daily,
    daily_flash_counts,
    day_bounds,
)
from scintille_pipelines.definitions import defs
from scintille_pipelines.resources import LakeResource, env_or


class SqliteLake(LakeResource):
    """The lake resource on a throwaway SQLite catalog."""

    path: str

    def catalog(self) -> Catalog:
        return SqlCatalog(
            "test", uri=f"sqlite:///{self.path}/catalog.db", warehouse=f"file://{self.path}"
        )


def add_flashes(catalog: Catalog, sources: list[str], when: datetime) -> None:
    table = catalog.load_table(FLASHES.identifier)
    rows = [
        {
            "flash_id": f"{i:032x}",
            "source": source,
            "product_file": "test.nc",
            "native_flash_id": i,
            "event_time": when,
            "ingest_time": when,
            "lat": 0.0,
            "lon": 0.0,
            "energy_raw": 1.0,
            "energy_unit": "J",
            "intensity": 0.5,
            "area_km2": 100.0,
            "duration_ms": 200.0,
            "quality": [],
            "parser_version": "test",
            "calibration_version": "test",
        }
        for i, source in enumerate(sources)
    ]
    table.append(pa.Table.from_pylist(rows, schema=table.schema().as_arrow()))


@pytest.fixture
def lake(tmp_path: Path) -> SqliteLake:
    resource = SqliteLake(path=str(tmp_path))
    catalog = resource.catalog()
    migrate(catalog)
    day = datetime(2026, 7, 15, 18, tzinfo=UTC)
    add_flashes(catalog, ["glm-east", "glm-east", "mtg-li"], day)
    add_flashes(catalog, ["glm-west"], datetime(2026, 7, 16, 1, tzinfo=UTC))
    return resource


def test_code_location_loads() -> None:
    repo = defs.get_repository_def()
    assert repo.get_job("daily_gold")
    assert {s.name for s in repo.schedule_defs} == {
        "daily_gold_schedule",
        "silver_hourly_checks_schedule",
        "silver_daily_checks_schedule",
        "lake_weekly_maintenance_schedule",
    }
    assert {s.name for s in repo.sensor_defs} == {"silver_changed", "alert_on_failure"}


def test_day_bounds_are_utc() -> None:
    assert day_bounds("2026-07-15") == (
        date(2026, 7, 15),
        "2026-07-15T00:00:00+00:00",
        "2026-07-16T00:00:00+00:00",
    )


def test_check_flags_duplicates_and_negatives() -> None:
    schema = DAILY_FLASH_COUNTS.schema.as_arrow()
    ok = count_by_source(pa.table({"source": ["a", "b", "a"]}), date(2026, 7, 15), schema)
    assert ok["flash_count"].to_pylist() == [2, 1]
    assert check_counts(ok).passed
    rows = [{"day": date(2026, 7, 15), "source": "a", "flash_count": n} for n in (1, -1)]
    assert not check_counts(pa.Table.from_pylist(rows, schema=schema)).passed


def test_materializes_a_day(lake: SqliteLake) -> None:
    result = materialize([daily_flash_counts], partition_key="2026-07-15", resources={"lake": lake})
    assert result.success
    checks = result.get_asset_check_evaluations()
    assert [c.passed for c in checks] == [True]
    rows = lake.catalog().load_table(DAILY_FLASH_COUNTS.identifier).scan().to_arrow()
    assert sorted(
        zip(rows["source"].to_pylist(), rows["flash_count"].to_pylist(), strict=True)
    ) == [
        ("glm-east", 2),
        ("mtg-li", 1),
    ]
    again = materialize([daily_flash_counts], partition_key="2026-07-15", resources={"lake": lake})
    assert again.success
    assert lake.catalog().load_table(DAILY_FLASH_COUNTS.identifier).scan().to_arrow().num_rows == 2


def test_failure_payload() -> None:
    payload = failure_payload("daily_gold", "0123456789abcdef", "boom")
    assert payload["text"] == "Scintille: run 01234567 of daily_gold failed"
    assert payload["error"] == "boom"


def test_secrets_come_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SCINTILLE_POSTGRES_DSN", "postgresql://secret")
    assert isinstance(env_or("SCINTILLE_POSTGRES_DSN", "x"), EnvVar)
    monkeypatch.delenv("SCINTILLE_POSTGRES_DSN")
    assert env_or("SCINTILLE_POSTGRES_DSN", "x") == "x"


MIDDAY = datetime(2026, 7, 16, 12, tzinfo=UTC)


def test_sensor_requests_the_open_day(lake: SqliteLake, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(automation, "utc_now", lambda: MIDDAY)
    request = automation.silver_changed(build_sensor_context(resources={"lake": lake}))
    assert isinstance(request, RunRequest)
    assert request.partition_key == "2026-07-16"
    assert "2026-07-16" in daily.get_partition_keys(current_time=MIDDAY)


def test_schedule_requests_the_last_closed_day() -> None:
    tick = datetime(2026, 7, 16, 1, 30, tzinfo=UTC)
    request = automation.daily_gold_schedule(build_schedule_context(scheduled_execution_time=tick))
    assert isinstance(request, RunRequest)
    assert request.partition_key == "2026-07-15"
