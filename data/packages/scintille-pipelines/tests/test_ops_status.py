from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from dagster import (
    AssetCheckKey,
    AssetKey,
    AssetSelection,
    DagsterInstance,
    Definitions,
    asset,
    define_asset_job,
    materialize,
)
from pyiceberg.catalog import Catalog
from pyiceberg.catalog.sql import SqlCatalog
from scintille_lake.migrate import migrate
from scintille_pipelines import checks, definitions
from scintille_pipelines.ops_status import (
    CheckResult,
    latest_checks,
    latest_gold_build,
    ops_status,
    summarize,
)
from scintille_pipelines.resources import LakeResource

T0 = datetime(2026, 7, 15, 19, 10, tzinfo=UTC)


class SqliteLake(LakeResource):
    path: str

    def catalog(self) -> Catalog:
        return SqlCatalog(
            "test",
            uri=f"sqlite:///{self.path}/catalog.db",
            warehouse=f"file://{self.path}",
        )


def test_summary_is_fail_on_errors_and_warn_on_warnings() -> None:
    ok = CheckResult("silver_ranges", True, True, T0)
    warning = CheckResult("silver_volume", False, False, T0 + timedelta(minutes=1))
    error = CheckResult("silver_completeness", False, True, T0)
    assert summarize([])["status"] == "unknown"
    assert summarize([ok])["status"] == "pass"
    assert summarize([ok, warning]) == {
        "status": "warn",
        "checked_at": (T0 + timedelta(minutes=1)).isoformat(),
        "failed": ["silver_volume"],
    }
    assert summarize([ok, warning, error])["status"] == "fail"


def test_reads_the_latest_check_results(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    lake = SqliteLake(path=str(tmp_path))
    migrate(lake.catalog())
    monkeypatch.setattr(checks, "clock", lambda: T0)
    job = define_asset_job("checks", selection=AssetSelection.checks(checks.silver_completeness))
    defs = Definitions(
        assets=[checks.SILVER],
        asset_checks=[checks.silver_completeness],
        jobs=[job],
        resources={"lake": lake},
    )
    instance = DagsterInstance.ephemeral()
    defs.resolve_job_def("checks").execute_in_process(instance=instance, raise_on_error=False)
    key = AssetCheckKey(checks.SILVER.key, "silver_completeness")
    results = latest_checks(instance, [key])
    assert [(r.name, r.passed, r.error) for r in results] == [("silver_completeness", False, True)]
    assert summarize(results)["failed"] == ["silver_completeness"]


def test_reads_the_latest_gold_build() -> None:
    @asset(key=AssetKey(["gold", "example"]))
    def example() -> int:
        return 1

    instance = DagsterInstance.ephemeral()
    assert latest_gold_build(instance, [example.key]) is None
    materialize([example], instance=instance)
    built = latest_gold_build(instance, [example.key])
    assert built is not None and datetime.now(UTC) - built < timedelta(minutes=1)


def test_sensor_is_registered_and_running_by_default() -> None:
    assert definitions.defs.resolve_sensor_def("ops_status") is ops_status
    assert ops_status.default_status.value == "RUNNING"
