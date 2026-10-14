"""Read-only retention measurements from Iceberg metadata and exported object listings."""

import json
from collections.abc import Iterable
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import TypedDict, cast

from pyiceberg.manifest import DataFileContent, ManifestEntry, ManifestEntryStatus
from pyiceberg.table import Table
from pyiceberg.transforms import DayTransform

from .maintenance import StoredObject, object_key


def table_measurement(table: Table, objects: list[StoredObject] | None = None) -> dict[str, object]:
    current = table.current_snapshot()
    metadata = table.metadata
    referenced = {table.metadata_location, *(e.metadata_file for e in metadata.metadata_log)}
    referenced |= {s.statistics_path for s in metadata.statistics}
    referenced |= {s.statistics_path for s in metadata.partition_statistics}
    partitions: dict[str, dict[str, object]] = {}
    retained: dict[str, int] = {}
    entries: dict[str, list[ManifestEntry]] = {}
    current_files: set[str] = set()
    for snapshot in metadata.snapshots:
        referenced.add(snapshot.manifest_list)
        for manifest in snapshot.manifests(table.io):
            path = manifest.manifest_path
            referenced.add(path)
            if path not in entries:
                entries[path] = manifest.fetch_manifest_entry(table.io, discard_deleted=False)
                for entry in entries[path]:
                    file = entry.data_file
                    referenced.add(file.file_path)
                    retained[file.file_path] = file.file_size_in_bytes
            if current is None or snapshot.snapshot_id != current.snapshot_id:
                continue
            for entry in entries[path]:
                file = entry.data_file
                if (
                    entry.status == ManifestEntryStatus.DELETED
                    or file.content != DataFileContent.DATA
                    or file.file_path in current_files
                ):
                    continue
                current_files.add(file.file_path)
                partition: dict[str, object] = {}
                for index, field in enumerate(table.specs()[manifest.partition_spec_id].fields):
                    value = file.partition[index]
                    if value is not None and isinstance(field.transform, DayTransform):
                        value = (date(1970, 1, 1) + timedelta(days=value)).isoformat()
                    partition[field.name] = value
                key = ",".join(f"{k}={v}" for k, v in partition.items())
                stats = partitions.setdefault(
                    key, {"partition": partition, "files": 0, "bytes": 0, "rows": 0}
                )
                for target, amount in (
                    ("files", 1),
                    ("bytes", file.file_size_in_bytes),
                    ("rows", file.record_count),
                ):
                    stats[target] = cast(int, stats[target]) + amount
    keys = {object_key(uri) for uri in referenced}
    times = [s.timestamp_ms for s in metadata.snapshots]
    measured: dict[str, object] = {
        "snapshot_id": current.snapshot_id if current else None,
        "snapshots": len(times),
        "oldest_snapshot_at": _timestamp(min(times)) if times else None,
        "newest_snapshot_at": _timestamp(max(times)) if times else None,
        "current_partitions": [partitions[k] for k in sorted(partitions)],
        "retained_manifest_file_count": len(retained),
        "retained_manifest_file_bytes": sum(retained.values()),
        "referenced_object_count": len(keys),
    }
    if objects is not None:
        measured["inventory_coverage"] = inventory_coverage(table.location(), keys, objects)
    return measured


def _timestamp(milliseconds: int) -> str:
    return datetime.fromtimestamp(milliseconds / 1000, UTC).isoformat()


def read_inventory(path: Path) -> list[StoredObject]:
    """Read the complete JSON output of S3 ListObjectsV2 (AWS CLI pagination enabled)."""
    payload = json.loads(path.read_text())
    if not isinstance(payload, dict) or not isinstance(payload.get("Contents", []), list):
        raise ValueError("inventory must be a ListObjectsV2 JSON object")
    if payload.get("IsTruncated") or payload.get("NextToken"):
        raise ValueError("inventory is truncated; export all pages")
    objects: dict[str, StoredObject] = {}
    for row in payload.get("Contents", []):
        key, size = row["Key"], row["Size"]
        modified = datetime.fromisoformat(row["LastModified"].replace("Z", "+00:00"))
        if not isinstance(key, str) or not isinstance(size, int) or size < 0:
            raise ValueError("inventory keys must be strings and sizes nonnegative integers")
        if modified.tzinfo is None:
            raise ValueError("inventory timestamps must include a timezone")
        if key in objects:
            raise ValueError(f"duplicate object key: {key}")
        objects[key] = StoredObject(key, size, modified)
    return list(objects.values())


class InventoryStats(TypedDict):
    objects: int
    bytes: int
    oldest_object_at: str
    newest_object_at: str
    bytes_by_upload_day: dict[str, int]


def inventory_measurement(objects: Iterable[StoredObject]) -> dict[str, InventoryStats]:
    groups: dict[str, list[StoredObject]] = {}
    for item in objects:
        if item.key.startswith("raw/"):
            group = "raw/"
        elif item.key.startswith(("archive/clouds/", "live/clouds/")):
            parts = item.key.split("/")
            group = "/".join(parts[:3] if len(parts) > 3 else parts[:2]) + "/"
        else:
            group = "other/"
        groups.setdefault(group, []).append(item)
    return {
        group: {
            "objects": len(items),
            "bytes": sum(item.size for item in items),
            "oldest_object_at": min(item.last_modified for item in items).isoformat(),
            "newest_object_at": max(item.last_modified for item in items).isoformat(),
            "bytes_by_upload_day": {
                day.isoformat(): sum(
                    i.size for i in items if i.last_modified.astimezone(UTC).date() == day
                )
                for day in sorted({i.last_modified.astimezone(UTC).date() for i in items})
            },
        }
        for group, items in sorted(groups.items())
    }


def inventory_coverage(
    location: str, keys: set[str], objects: list[StoredObject]
) -> dict[str, int]:
    """Match all referenced metadata/manifest/data keys; never classify unmatched files as safe."""
    sizes = {item.key: item.size for item in objects}
    return {
        "matched_referenced_objects": len(keys & sizes.keys()),
        "missing_referenced_objects": len(keys - sizes.keys()),
        "matched_referenced_bytes": sum(sizes[key] for key in keys & sizes.keys()),
        "table_location_objects": sum(
            key.startswith(object_key(location).rstrip("/") + "/") for key in sizes
        ),
    }
