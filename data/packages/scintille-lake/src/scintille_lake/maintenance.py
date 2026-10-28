"""Table maintenance: retention policy and orphan file inventory (never deletes)."""

import os
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from urllib.parse import urlparse

from pyiceberg.manifest import ManifestFile
from pyiceberg.table import Table

# R2 Data Catalog accepts compaction targets from 64 to 512 MB.
TARGET_RANGE_MB = (64, 512)


@dataclass(frozen=True)
class MaintenancePolicy:
    """Retention and compaction settings; snapshot and raw values await decision #41."""

    compaction_target_mb: int = 128
    snapshot_retention_days: int = 3
    snapshots_retained_min: int = 5
    raw_retention_days: int = 30
    orphan_min_age_days: int = 7

    def __post_init__(self) -> None:
        low, high = TARGET_RANGE_MB
        if not low <= self.compaction_target_mb <= high:
            raise ValueError(f"compaction target must be within {low} to {high} MB")
        if self.snapshot_retention_days < 1 or self.snapshots_retained_min < 1:
            raise ValueError("snapshot retention must keep at least one day and one snapshot")
        if self.raw_retention_days < 1:
            raise ValueError("raw retention must be at least one day")
        # An orphan candidate must be older than any snapshot we keep.
        if self.orphan_min_age_days <= self.snapshot_retention_days:
            raise ValueError("orphan minimum age must exceed snapshot retention")

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "MaintenancePolicy":
        env = os.environ if env is None else env
        default = cls()

        def read(name: str, value: int) -> int:
            return int(env.get(f"SCINTILLE_{name.upper()}", value))

        return cls(**{k: read(k, v) for k, v in default.__dict__.items()})

    def wrangler_commands(self, bucket: str) -> list[str]:
        """Commands that apply this policy to R2 Data Catalog, run by hand with a catalog token."""
        base = f"npx wrangler basin catalog {{}} enable {bucket} --token $R2_CATALOG_TOKEN"
        return [
            f"{base.format('compaction')} --target-size {self.compaction_target_mb}",
            f"{base.format('snapshot-expiration')}"
            f" --older-than-days {self.snapshot_retention_days}"
            f" --retain-last {self.snapshots_retained_min}",
        ]


def object_key(uri: str) -> str:
    """Object key of a table file: its path without scheme, bucket or leading slash."""
    return urlparse(uri).path.lstrip("/")


def referenced_keys(table: Table) -> set[str]:
    """Every object any retained snapshot or metadata version can still read."""
    io = table.io
    metadata = table.metadata
    uris = {table.metadata_location, *(entry.metadata_file for entry in metadata.metadata_log)}
    uris |= {s.statistics_path for s in metadata.statistics}
    uris |= {s.statistics_path for s in metadata.partition_statistics}
    # Snapshots share most of their manifests: read each one once, not once per snapshot.
    manifests: dict[str, ManifestFile] = {}
    for snapshot in metadata.snapshots:
        uris.add(snapshot.manifest_list)
        manifests.update((m.manifest_path, m) for m in snapshot.manifests(io))
    for path, manifest in manifests.items():
        uris.add(path)
        # Deleted entries too: a file is only safe once no manifest mentions it.
        for entry in manifest.fetch_manifest_entry(io, discard_deleted=False):
            uris.add(entry.data_file.file_path)
    return {object_key(u) for u in uris}


@dataclass(frozen=True)
class StoredObject:
    key: str
    size: int
    last_modified: datetime


def orphan_inventory(
    listed: Iterable[StoredObject], referenced: set[str], now: datetime, min_age: timedelta
) -> list[StoredObject]:
    """Unreferenced objects older than `min_age`, sorted by key. Inventory only."""
    cutoff = now - min_age
    return sorted(
        (o for o in listed if o.key not in referenced and o.last_modified < cutoff),
        key=lambda o: o.key,
    )
