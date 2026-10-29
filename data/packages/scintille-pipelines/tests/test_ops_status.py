from datetime import UTC, datetime, timedelta
from pathlib import Path

import pyarrow as pa
import pytest
from dagster import (
    AssetCheckExecutionContext,
    AssetCheckKey,
    AssetCheckResult,
    AssetCheckSeverity,
    AssetKey,
    AssetSelection,
    DagsterInstance,
    Definitions,
    MaterializeResult,
    asset,
    asset_check,
    build_sensor_context,
    define_asset_job,
    materialize,
)
from pyiceberg.catalog import Catalog
from pyiceberg.catalog.sql import SqlCatalog
from scintille_ingest.runtime.ops import LAKE_STATUS, STORMS_STATUS
from scintille_lake.migrate import migrate
from scintille_pipelines import checks, definitions
from scintille_pipelines.ops_status import (
    STORM_CATALOG,
    CheckResult,
    lake_due,
    lake_size,
    latest_checks,
    latest_gold_build,
    latest_storm_counts,
    ops_status,
    summarize,
)
from scintille_pipelines.resources import LakeResource, PostgresResource

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


def test_a_pending_rerun_keeps_the_previous_result() -> None:
    @asset(key=AssetKey(["silver", "example"]))
    def example() -> int:
        return 1

    seen: list[list[CheckResult]] = []

    @asset_check(asset=example)
    def probe(context: AssetCheckExecutionContext) -> AssetCheckResult:
        seen.append(latest_checks(context.instance, [AssetCheckKey(example.key, "probe")]))
        return AssetCheckResult(passed=False, severity=AssetCheckSeverity.ERROR)

    instance = DagsterInstance.ephemeral()
    for _ in range(2):
        materialize([example, probe], instance=instance, raise_on_error=False)
    assert seen[0] == []
    assert [(r.name, r.passed) for r in seen[1]] == [("probe", False)]


def test_reads_the_latest_gold_build() -> None:
    @asset(key=AssetKey(["gold", "example"]))
    def example() -> int:
        return 1

    instance = DagsterInstance.ephemeral()
    assert latest_gold_build(instance, [example.key]) is None
    materialize([example], instance=instance)
    built = latest_gold_build(instance, [example.key])
    assert built is not None and datetime.now(UTC) - built < timedelta(minutes=1)


def test_lake_size_adds_up_current_snapshots(tmp_path: Path) -> None:
    catalog = SqliteLake(path=str(tmp_path)).catalog()
    migrate(catalog)
    empty = lake_size(catalog)
    assert empty["tables"] >= 3 and empty["bytes"] == empty["records"] == 0
    table = catalog.create_table(("gold", "example"), schema=pa.schema([("x", pa.int64())]))
    for n in (3, 4):
        table.append(pa.table({"x": list(range(n))}, schema=pa.schema([("x", pa.int64())])))
    size = lake_size(catalog)
    files = table.inspect.data_files()
    assert size["tables"] == empty["tables"] + 1
    assert size["records"] == 7 and size["data_files"] == files.num_rows == 2
    assert size["bytes"] == pa.compute.sum(files["file_size_in_bytes"]).as_py()


def test_storm_counts_come_from_the_latest_catalog_publication() -> None:
    @asset(key=STORM_CATALOG)
    def storm_catalog() -> MaterializeResult:  # type: ignore[type-arg]
        return MaterializeResult(metadata={"detected": 40, "storms": 12, "highlights": 5})

    instance = DagsterInstance.ephemeral()
    assert latest_storm_counts(instance) is None
    materialize([storm_catalog], instance=instance)
    counts = latest_storm_counts(instance)
    assert counts is not None
    at, value = counts
    assert value == {"detected": 40, "published": 12, "highlighted": 5}
    assert datetime.now(UTC) - at < timedelta(minutes=1)


def test_lake_size_is_measured_once_an_hour() -> None:
    assert lake_due(None, T0)
    assert not lake_due((T0 - timedelta(minutes=59)).isoformat(), T0)
    assert lake_due((T0 - timedelta(hours=1)).isoformat(), T0)


def test_sensor_records_storm_counts_and_lake_size(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lake = SqliteLake(path=str(tmp_path))
    migrate(lake.catalog())
    recorded: dict[str, tuple[datetime, dict[str, object]]] = {}

    class Ops:
        def __init__(self, dsn: str) -> None:
            pass

        def put_status(self, name: str, value: dict[str, object], at: datetime) -> None:
            recorded[name] = (at, dict(value))

        def close(self) -> None:
            pass

    @asset(key=STORM_CATALOG)
    def storm_catalog() -> MaterializeResult:  # type: ignore[type-arg]
        return MaterializeResult(metadata={"detected": 3, "storms": 1, "highlights": 1})

    instance = DagsterInstance.ephemeral()
    materialize([storm_catalog], instance=instance)
    defs = Definitions(assets=[storm_catalog], sensors=[ops_status])
    monkeypatch.setattr("scintille_pipelines.ops_status.PostgresOps", Ops)
    context = build_sensor_context(
        instance=instance,
        definitions=defs,
        resources={"postgres": PostgresResource(), "lake": lake},
    )
    ops_status(context)
    assert recorded[STORMS_STATUS][1] == {"detected": 3, "published": 1, "highlighted": 1}
    assert recorded[LAKE_STATUS][1] == lake_size(lake.catalog())
    assert context.cursor is not None
    recorded.clear()
    ops_status(context)
    assert LAKE_STATUS not in recorded and STORMS_STATUS in recorded


def test_sensor_is_registered_and_running_by_default() -> None:
    assert definitions.defs.resolve_sensor_def("ops_status") is ops_status
    assert ops_status.default_status.value == "RUNNING"
