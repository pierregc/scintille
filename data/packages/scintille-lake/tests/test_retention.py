import json
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import pyarrow as pa
import pytest
from pyiceberg.catalog import Catalog
from pyiceberg.manifest import ManifestEntry, ManifestFile
from pyiceberg.table import Table
from scintille_lake.cli import main
from scintille_lake.maintenance import StoredObject, object_key
from scintille_lake.migrate import migrate
from scintille_lake.retention import (
    inventory_measurement,
    read_inventory,
    table_measurement,
)
from scintille_lake.tables import FLASHES


def test_current_and_retained_bytes_are_distinct_and_files_deduplicated(
    catalog: Catalog, flash_rows: Callable[[str, Table], pa.Table]
) -> None:
    migrate(catalog)
    table = catalog.load_table(FLASHES.identifier)
    assert table_measurement(table)["current_partitions"] == []
    table.append(flash_rows("a.nc", table))
    table.append(flash_rows("b.nc", table))
    table.overwrite(flash_rows("c.nc", table))
    before = table.metadata_location
    measured = table_measurement(table)
    assert measured["snapshots"] == 4
    assert measured["retained_manifest_file_count"] == 3
    partitions = measured["current_partitions"]
    assert isinstance(partitions, list)
    assert sum(p["rows"] for p in partitions) == 3
    assert sum(p["files"] for p in partitions) == 1
    assert measured["retained_manifest_file_bytes"] > sum(p["bytes"] for p in partitions)
    assert table.metadata_location == before
    coverage = table_measurement(
        table, [StoredObject(object_key(table.metadata_location), 123, datetime.now(UTC))]
    )["inventory_coverage"]
    assert isinstance(coverage, dict)
    assert coverage["matched_referenced_objects"] == 1
    assert coverage["matched_referenced_bytes"] == 123
    assert coverage["missing_referenced_objects"] > 0


def test_inventory_counts_duplicates_between_live_and_archive_and_uses_utc_days() -> None:
    stamp = datetime.fromisoformat("2026-10-12T00:30:00+02:00")
    report = inventory_measurement(
        [
            StoredObject("live/clouds/2k/a.webp", 100, stamp),
            StoredObject("archive/clouds/2k/a.webp", 100, stamp),
            StoredObject("archive/clouds/4k/a.webp", 300, stamp),
            StoredObject("raw/a.nc", 500, stamp),
        ]
    )
    assert sum(group["bytes"] for group in report.values()) == 1000
    assert report["raw/"] == {
        "objects": 1,
        "bytes": 500,
        "oldest_object_at": stamp.isoformat(),
        "newest_object_at": stamp.isoformat(),
        "bytes_by_upload_day": {"2026-10-11": 500},
    }
    assert json.loads(json.dumps(report))["archive/clouds/4k/"]["bytes"] == 300


@pytest.mark.parametrize("extra", [{"IsTruncated": True}, {"NextToken": "next"}])
def test_inventory_rejects_partial_exports(tmp_path: Path, extra: dict[str, object]) -> None:
    path = tmp_path / "inventory.json"
    path.write_text(json.dumps({"Contents": [], **extra}))
    with pytest.raises(ValueError, match="truncated"):
        read_inventory(path)


def test_inventory_rejects_duplicate_keys_and_accepts_empty_bucket(tmp_path: Path) -> None:
    path = tmp_path / "inventory.json"
    path.write_text("{}")
    assert read_inventory(path) == []
    row = {"Key": "raw/a.nc", "Size": 1, "LastModified": "2026-10-12T00:00:00Z"}
    path.write_text(json.dumps({"Contents": [row]}))
    assert read_inventory(path)[0].size == 1
    path.write_text(json.dumps({"Contents": [row, row]}))
    with pytest.raises(ValueError, match="duplicate"):
        read_inventory(path)


def test_cli_reports_without_migration(
    catalog: Catalog, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    migrate(catalog)
    monkeypatch.setattr("scintille_lake.cli.pyiceberg_catalog", lambda: catalog)
    assert main(["retention-report", "--label", "local-empty-test"]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["label"] == "local-empty-test"
    assert report["tables"]["silver.flashes"]["snapshot_id"] is None
    assert report["inventories"] == {}


def test_manifest_entries_read_once_with_inventory(
    catalog: Catalog, flash_rows: Callable[[str, Table], pa.Table], monkeypatch: pytest.MonkeyPatch
) -> None:
    migrate(catalog)
    table = catalog.load_table(FLASHES.identifier)
    for name in ("a.nc", "b.nc", "c.nc"):
        table.append(flash_rows(name, table))
    reads: list[str] = []
    original = ManifestFile.fetch_manifest_entry

    def counted(self: ManifestFile, *args: object, **kwargs: object) -> list[ManifestEntry]:
        reads.append(self.manifest_path)
        return original(self, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(ManifestFile, "fetch_manifest_entry", counted)
    measured = table_measurement(table, [])
    assert len(reads) == len(set(reads)) == 3
    assert measured["retained_manifest_file_count"] == 3
    partitions = measured["current_partitions"]
    assert isinstance(partitions, list)
    assert sum(p["rows"] for p in partitions) == 9
    assert partitions[0]["partition"] == {"event_day": "2026-07-15", "source": "glm-east"}


def test_cloud_manifest_uses_prefix_group() -> None:
    report = inventory_measurement(
        [
            StoredObject("live/clouds/manifest.json", 42, datetime.now(UTC)),
            StoredObject("live/clouds/2k/a.webp", 100, datetime.now(UTC)),
        ]
    )
    assert report["live/clouds/"]["bytes"] == 42
    assert report["live/clouds/2k/"]["bytes"] == 100
    assert "live/clouds/manifest.json/" not in report
