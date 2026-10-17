from datetime import UTC, datetime
from pathlib import Path

import pyarrow as pa
import pytest
import yaml  # type: ignore[import-untyped]
from dagster import (
    DefaultScheduleStatus,
    DefaultSensorStatus,
    EnvVar,
    RunRequest,
    build_schedule_context,
    build_sensor_context,
)
from pyiceberg.catalog import Catalog
from pyiceberg.catalog.sql import SqlCatalog
from scintille_lake.migrate import migrate
from scintille_lake.tables import FLASHES
from scintille_pipelines import automation
from scintille_pipelines.alerts import failure_payload
from scintille_pipelines.definitions import defs
from scintille_pipelines.gold.assets import daily
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
        "storm_catalog_schedule",
        "silver_hourly_checks_schedule",
        "silver_daily_checks_schedule",
        "lake_weekly_maintenance_schedule",
    }
    assert {s.name for s in repo.sensor_defs} == {
        "silver_changed",
        "alert_on_failure",
        "ops_status",
    }


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


def test_schedules_and_sensors_start_running() -> None:
    repo = defs.get_repository_def()
    assert {
        s.name for s in repo.schedule_defs if s.default_status != DefaultScheduleStatus.RUNNING
    } == {"storm_catalog_schedule"}
    assert {
        s.name for s in repo.sensor_defs if s.default_status != DefaultSensorStatus.RUNNING
    } == set()


def test_dagster_storage_uses_psycopg2_on_the_vps() -> None:
    compose = Path(__file__).parents[4] / "infra/compose/compose.yaml"
    env = yaml.safe_load(compose.read_text())["x-pipelines"]["environment"]
    assert env["DAGSTER_POSTGRES_URL"].startswith("postgresql+psycopg2://")
    assert env["SCINTILLE_POSTGRES_DSN"].startswith("postgresql://")
