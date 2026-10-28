from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pyarrow as pa
import pytest
from pyiceberg.catalog import Catalog
from pyiceberg.manifest import ManifestFile
from pyiceberg.table import Table
from scintille_lake.cli import main
from scintille_lake.maintenance import (
    MaintenancePolicy,
    StoredObject,
    object_key,
    orphan_inventory,
    referenced_keys,
)
from scintille_lake.migrate import migrate
from scintille_lake.tables import FLASHES

NOW = datetime(2026, 10, 10, tzinfo=UTC)
OLD = NOW - timedelta(days=30)


def test_default_policy_follows_adr_0006() -> None:
    policy = MaintenancePolicy()
    assert (policy.snapshot_retention_days, policy.raw_retention_days) == (3, 30)
    assert policy.wrangler_commands("scintille-lake") == [
        "npx wrangler basin catalog compaction enable scintille-lake"
        " --token $R2_CATALOG_TOKEN --target-size 128",
        "npx wrangler basin catalog snapshot-expiration enable scintille-lake"
        " --token $R2_CATALOG_TOKEN --older-than-days 3 --retain-last 5",
    ]


def test_policy_from_env() -> None:
    env = {"SCINTILLE_SNAPSHOT_RETENTION_DAYS": "5", "SCINTILLE_ORPHAN_MIN_AGE_DAYS": "10"}
    policy = MaintenancePolicy.from_env(env)
    assert (policy.snapshot_retention_days, policy.orphan_min_age_days) == (5, 10)


@pytest.mark.parametrize(
    "values",
    [
        {"compaction_target_mb": 32},
        {"compaction_target_mb": 1024},
        {"snapshot_retention_days": 0},
        {"raw_retention_days": 0},
        {"snapshot_retention_days": 7, "orphan_min_age_days": 7},
    ],
)
def test_policy_rejects_unsafe_values(values: dict[str, int]) -> None:
    with pytest.raises(ValueError):
        MaintenancePolicy(**values)


def test_object_key() -> None:
    assert object_key("s3://scintille-lake/__r2/abc/data/f.parquet") == "__r2/abc/data/f.parquet"
    assert object_key("file:///tmp/w/silver/f.parquet") == "tmp/w/silver/f.parquet"


def _listing(table: Table, modified: datetime) -> list[StoredObject]:
    root = Path("/" + object_key(table.location()))
    return [
        StoredObject(object_key(str(path)), path.stat().st_size, modified)
        for path in root.rglob("*")
        if path.is_file()
    ]


def test_inventory_never_lists_a_retained_file(
    catalog: Catalog, flash_rows: Callable[[str, Table], pa.Table]
) -> None:
    migrate(catalog)
    table = catalog.load_table(FLASHES.identifier)
    for name in ("a.nc", "b.nc", "c.nc"):
        table.append(flash_rows(name, table))
    table.overwrite(flash_rows("d.nc", table))
    table.append(flash_rows("e.nc", table))
    table = catalog.load_table(FLASHES.identifier)
    first = table.metadata.snapshots[0].snapshot_id
    expired_list = object_key(table.metadata.snapshots[0].manifest_list)
    table.maintenance.expire_snapshots().by_id(first).commit()
    table = catalog.load_table(FLASHES.identifier)

    root = Path("/" + object_key(table.location()))
    stray = root / "data" / "stray.parquet"
    stray.write_bytes(b"x")

    referenced = referenced_keys(table)
    orphans = orphan_inventory(_listing(table, OLD), referenced, NOW, timedelta(days=7))
    keys = {o.key for o in orphans}

    assert not keys & referenced
    assert {object_key(str(stray)), expired_list} <= keys
    for snapshot in table.metadata.snapshots:
        for task in table.scan(snapshot_id=snapshot.snapshot_id).plan_files():
            assert object_key(task.file.file_path) not in keys
    assert object_key(table.metadata_location) not in keys


def test_inventory_skips_recent_files() -> None:
    listed = [StoredObject("t/new", 1, NOW - timedelta(days=1)), StoredObject("t/old", 1, OLD)]
    assert [o.key for o in orphan_inventory(listed, set(), NOW, timedelta(days=7))] == ["t/old"]


def test_cli_prints_policy(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["maintenance"]) == 0
    assert "--older-than-days 3" in capsys.readouterr().out


def test_inventory_reads_each_manifest_once(
    catalog: Catalog,
    flash_rows: Callable[[str, Table], pa.Table],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    migrate(catalog)
    table = catalog.load_table(FLASHES.identifier)
    for name in ("a.nc", "b.nc", "c.nc", "d.nc"):
        table.append(flash_rows(name, table))
    table = catalog.load_table(FLASHES.identifier)
    reads: list[str] = []
    fetch = ManifestFile.fetch_manifest_entry

    def counted(self: ManifestFile, *args: object, **kwargs: object) -> object:
        reads.append(self.manifest_path)
        return fetch(self, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(ManifestFile, "fetch_manifest_entry", counted)
    referenced_keys(table)
    assert len(reads) == len(set(reads)) == 4
