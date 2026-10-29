from datetime import UTC, datetime, timedelta
from pathlib import Path

import pyarrow as pa
import pytest
from pyiceberg.catalog import Catalog
from pyiceberg.catalog.sql import SqlCatalog
from pyiceberg.table.snapshots import Operation
from scintille_lake.maintenance import MaintenancePolicy, expire_silver
from scintille_lake.migrate import migrate
from scintille_lake.tables import FLASHES
from scintille_pipelines import checks
from scintille_pipelines.resources import LakeResource
from scintille_pipelines.silver_retention import silver_retention

TODAY = datetime(2026, 11, 20, 4, tzinfo=UTC)


class SqliteLake(LakeResource):
    path: str

    def catalog(self) -> Catalog:
        return SqlCatalog(
            "test", uri=f"sqlite:///{self.path}/catalog.db", warehouse=f"file://{self.path}"
        )


def flash(source: str, when: datetime, i: int) -> dict[str, object]:
    return {
        "flash_id": f"{i:032x}",
        "source": source,
        "product_file": "test.nc",
        "native_flash_id": i,
        "event_time": when,
        "ingest_time": when,
        "lat": 0.0,
        "lon": 0.0,
        "energy_raw": 2.0,
        "energy_unit": "J",
        "intensity": 0.5,
        "area_km2": 100.0,
        "duration_ms": 200.0,
        "quality": [],
        "parser_version": "test",
        "calibration_version": "test",
    }


@pytest.fixture
def lake(tmp_path: Path) -> SqliteLake:
    resource = SqliteLake(path=str(tmp_path))
    catalog = resource.catalog()
    migrate(catalog)
    table = catalog.load_table(FLASHES.identifier)
    for i, days in enumerate((30, 22, 21, 1)):
        when = TODAY - timedelta(days=days)
        rows = [flash(s, when, 10 * i + n) for n, s in enumerate(("glm-east", "mtg-li"))]
        table.append(pa.Table.from_pylist(rows, schema=table.schema().as_arrow()))
    return resource


def test_days_past_retention_leave_silver_without_rewriting_files(lake: SqliteLake) -> None:
    table = lake.catalog().load_table(FLASHES.identifier)
    cutoff = expire_silver(table, TODAY.date(), 21)
    assert cutoff == (TODAY - timedelta(days=21)).date()
    kept = table.scan().to_arrow()["event_time"].to_pylist()
    assert sorted({t.date() for t in kept if t}) == [cutoff, (TODAY - timedelta(days=1)).date()]
    snapshot = table.current_snapshot()
    assert snapshot is not None and snapshot.summary is not None
    assert snapshot.summary["deleted-data-files"] == "4"
    assert snapshot.summary.operation == Operation.DELETE


def test_job_expires_silver_with_the_schedule_clock(
    lake: SqliteLake, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(checks, "clock", lambda: TODAY)
    result = silver_retention.execute_in_process(resources={"lake": lake})
    assert result.success
    assert lake.catalog().load_table(FLASHES.identifier).scan().to_arrow().num_rows == 4


def test_policy_keeps_at_least_a_week_of_silver() -> None:
    assert MaintenancePolicy().silver_retention_days == 21
    with pytest.raises(ValueError):
        MaintenancePolicy(silver_retention_days=3)
