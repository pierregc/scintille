import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import Mock

import pyarrow as pa
import pytest
from obstore.store import MemoryStore, ObjectStore
from pyiceberg.catalog.sql import SqlCatalog
from pyiceberg.partitioning import PartitionField, PartitionSpec
from pyiceberg.schema import Schema
from pyiceberg.transforms import DayTransform, IdentityTransform
from pyiceberg.types import NestedField, StringType, TimestamptzType
from scintille_lake.maintenance import StoredObject, object_key
from scintille_pipelines.retention_collection import collect, main, source_days, stores_from_env

NOW = datetime(2026, 10, 16, 12, tzinfo=UTC)


def partition(day: str, source: str, size: int, rows: int) -> dict[str, object]:
    return {
        "partition": {"event_day": day, "source": source},
        "bytes": size,
        "rows": rows,
        "files": 1,
    }


def test_source_summary_excludes_unsettled_days_and_reports_gaps_without_completeness() -> None:
    measured = source_days(
        [
            partition("2026-10-12", "glm-east", 100, 10),
            partition("2026-10-14", "glm-east", 300, 30),
            partition("2026-10-15", "glm-east", 999, 99),
            partition("2026-10-16", "mtg-li", 999, 99),
            partition("2026-10-14", "glm-west", 50, 0),
        ],
        NOW,
    )
    assert measured == {
        "glm-east": {
            "first_day": "2026-10-12",
            "last_day": "2026-10-14",
            "observed_days": 2,
            "missing_days_in_range": 1,
            "physical_rows": 40,
            "bytes": 400,
            "daily_bytes_min": 100,
            "daily_bytes_median": 200,
            "daily_bytes_max": 300,
            "bytes_per_physical_row": 10,
            "upstream_completeness_verified": False,
        },
        "glm-west": {
            "first_day": "2026-10-14",
            "last_day": "2026-10-14",
            "observed_days": 1,
            "missing_days_in_range": 0,
            "physical_rows": 0,
            "bytes": 50,
            "daily_bytes_min": 50,
            "daily_bytes_median": 50,
            "daily_bytes_max": 50,
            "bytes_per_physical_row": None,
            "upstream_completeness_verified": False,
        },
    }
    assert source_days([], NOW) == {}
    offset = datetime.fromisoformat("2026-10-17T00:30:00+14:00")
    assert source_days([partition("2026-10-15", "glm-east", 1, 1)], offset) == {}


def test_collection_counts_both_copies_and_table_footprint_without_mutating_catalog(
    tmp_path: Path,
) -> None:
    catalog = SqlCatalog("test", uri=f"sqlite:///{tmp_path / 'catalog.db'}")
    catalog.create_namespace("silver")
    schema = Schema(
        NestedField(1, "event_time", TimestamptzType(), required=True),
        NestedField(2, "source", StringType(), required=True),
    )
    table = catalog.create_table(
        "silver.flashes",
        schema,
        location=f"file://{tmp_path / 'table'}",
        partition_spec=PartitionSpec(
            PartitionField(1, 1000, DayTransform(), "event_day"),
            PartitionField(2, 1001, IdentityTransform(), "source"),
        ),
    )
    table.append(
        pa.Table.from_pylist(
            [{"event_time": datetime(2026, 10, 14, tzinfo=UTC), "source": "glm-east"}],
            schema=schema.as_arrow(),
        )
    )
    original_metadata = table.metadata_location
    lake, live = MemoryStore(), MemoryStore()
    calls: list[tuple[ObjectStore, str]] = []
    objects = [
        StoredObject(object_key(table.metadata_location), 10, NOW),
        StoredObject(object_key(table.location()) + "/orphan.bin", 20, NOW),
        StoredObject("raw/glm-east/product.nc", 30, NOW),
    ]

    def listing(store: ObjectStore, prefix: str) -> list[StoredObject]:
        calls.append((store, prefix))
        if store is lake:
            return objects
        return [
            StoredObject("live/clouds/2k/frame.webp", 100, NOW),
            StoredObject("archive/clouds/2k/frame.webp", 100, NOW),
        ]

    report = collect(catalog, {"lake": lake, "live": live}, now=lambda: NOW, listing=listing)
    assert calls == [(lake, ""), (live, "")]
    data = json.loads(json.dumps(report))
    assert data["tables"]["silver.flashes"]["table_location_bytes"] == 30
    assert data["tables"]["silver.flashes"]["inventory_coverage"]["missing_referenced_objects"] > 0
    assert data["source_days"]["glm-east"]["physical_rows"] == 1
    assert data["inventories"]["lake"]["bytes"] == 60
    assert data["inventories"]["live"]["bytes"] == 200
    assert data["inventories"]["live"]["complete_listing"] is True
    assert "product.nc" not in json.dumps(data)
    assert catalog.load_table("silver.flashes").metadata_location == original_metadata


def test_partial_or_duplicate_inventory_fails_instead_of_reporting_zero() -> None:
    catalog = Mock()
    stores: dict[str, ObjectStore] = {"lake": MemoryStore(), "live": MemoryStore()}

    def partial(store: ObjectStore, prefix: str) -> list[StoredObject]:
        raise OSError("incomplete listing")

    with pytest.raises(OSError, match="incomplete"):
        collect(catalog, stores, listing=partial)
    item = StoredObject("raw/file", 10, NOW)
    with pytest.raises(ValueError, match="duplicate"):
        collect(catalog, stores, listing=lambda store, prefix: [item, item])
    with pytest.raises(ValueError, match="both"):
        collect(catalog, {"lake": stores["lake"]})
    catalog.load_table.assert_not_called()


def production_env() -> dict[str, str]:
    return {
        "SCINTILLE_R2_ENDPOINT": "https://example.invalid",
        "SCINTILLE_R2_ACCESS_KEY_ID": "fake-key",
        "SCINTILLE_R2_SECRET_ACCESS_KEY": "fake-secret",
        "SCINTILLE_R2_BUCKET": "lake",
        "SCINTILLE_LIVE_BUCKET": "live",
        "SCINTILLE_LAKE_URI": "https://catalog.invalid",
        "SCINTILLE_LAKE_WAREHOUSE": "warehouse",
        "SCINTILLE_LAKE_TOKEN": "fake-token",
    }


@pytest.mark.parametrize(
    "changes",
    [
        {"SCINTILLE_R2_ENDPOINT": ""},
        {"SCINTILLE_LAKE_TOKEN": ""},
        {"SCINTILLE_R2_ENDPOINT": "http://localhost:9000"},
        {"SCINTILLE_LAKE_URI": "http://localhost:8181"},
        {"SCINTILLE_LIVE_BUCKET": ""},
        {"SCINTILLE_LIVE_BUCKET": "lake"},
    ],
)
def test_no_silent_local_defaults(changes: dict[str, str]) -> None:
    with pytest.raises(ValueError):
        stores_from_env(production_env() | changes)


def test_store_construction_does_not_require_a_network_call() -> None:
    assert set(stores_from_env(production_env())) == {"lake", "live"}


def test_failure_does_not_print_connection_secrets_or_partial_report(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr("scintille_pipelines.retention_collection.stores_from_env", lambda env: {})

    def broken() -> None:
        raise RuntimeError("https://private.invalid?token=do-not-print")

    monkeypatch.setattr("scintille_pipelines.retention_collection.pyiceberg_catalog", broken)
    assert main() == 1
    output = capsys.readouterr()
    assert output.out == ""
    assert output.err == "Retention collection failed (RuntimeError); no report produced.\n"


def test_bundle_loads_reviewed_sources_without_deploying_or_network_access() -> None:
    root = Path(__file__).resolve().parents[4]
    bundle = subprocess.run(
        [sys.executable, str(root / "infra/compose/retention_bundle.py")],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    result = subprocess.run(
        [sys.executable, "-"], input=bundle, capture_output=True, text=True, env={}
    )
    assert result.returncode == 1
    assert result.stdout == ""
    assert result.stderr == "Retention collection failed (ValueError); no report produced.\n"
