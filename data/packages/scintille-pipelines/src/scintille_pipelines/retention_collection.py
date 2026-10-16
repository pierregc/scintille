"""Read-only storage evidence for the retention decision; no Parquet scans or mutations."""

import json
import os
import sys
from collections import defaultdict
from collections.abc import Callable, Iterable, Mapping
from datetime import UTC, date, datetime, timedelta
from statistics import median
from typing import cast

from obstore.store import ObjectStore, S3Store
from pyiceberg.catalog import Catalog
from scintille_lake.connect import pyiceberg_catalog
from scintille_lake.maintenance import MaintenancePolicy, StoredObject, object_key
from scintille_lake.retention import inventory_measurement, table_measurement

from .maintenance import list_objects


def source_days(partitions: list[dict[str, object]], now: datetime) -> dict[str, object]:
    """Summarize settled UTC day partitions, without assuming upstream completeness."""
    sources: dict[str, list[dict[str, object]]] = defaultdict(list)
    last_day = (now.astimezone(UTC) - timedelta(days=2)).date()
    for row in partitions:
        part = cast(dict[str, str], row["partition"])
        day = date.fromisoformat(part["event_day"])
        if day <= last_day:
            sources[part["source"]].append(row)
    report: dict[str, object] = {}
    for source, rows in sorted(sources.items()):
        daily_bytes = [cast(int, r["bytes"]) for r in rows]
        total_rows = sum(cast(int, r["rows"]) for r in rows)
        days = sorted(cast(dict[str, str], r["partition"])["event_day"] for r in rows)
        report[source] = {
            "first_day": days[0],
            "last_day": days[-1],
            "observed_days": len(days),
            "missing_days_in_range": (
                date.fromisoformat(days[-1]) - date.fromisoformat(days[0])
            ).days
            + 1
            - len(days),
            "physical_rows": total_rows,
            "bytes": sum(daily_bytes),
            "daily_bytes_min": min(daily_bytes),
            "daily_bytes_median": median(daily_bytes),
            "daily_bytes_max": max(daily_bytes),
            "bytes_per_physical_row": sum(daily_bytes) / total_rows if total_rows else None,
            "upstream_completeness_verified": False,
        }
    return report


def stores_from_env(env: Mapping[str, str]) -> dict[str, ObjectStore]:
    required = (
        "SCINTILLE_R2_ENDPOINT",
        "SCINTILLE_R2_ACCESS_KEY_ID",
        "SCINTILLE_R2_SECRET_ACCESS_KEY",
        "SCINTILLE_R2_BUCKET",
        "SCINTILLE_LAKE_URI",
        "SCINTILLE_LAKE_WAREHOUSE",
        "SCINTILLE_LAKE_TOKEN",
    )
    if any(not env.get(name) for name in required):
        raise ValueError("production connection settings are incomplete")
    endpoint = env["SCINTILLE_R2_ENDPOINT"]
    if not endpoint.startswith("https://") or not env["SCINTILLE_LAKE_URI"].startswith("https://"):
        raise ValueError("production collection requires HTTPS endpoints")
    buckets = {"lake": env["SCINTILLE_R2_BUCKET"], "live": env.get("SCINTILLE_LIVE_BUCKET")}
    if not buckets["live"] or buckets["lake"] == buckets["live"]:
        raise ValueError("distinct lake and live buckets must be configured")
    return {
        name: S3Store(
            cast(str, bucket),
            endpoint=endpoint,
            access_key_id=env["SCINTILLE_R2_ACCESS_KEY_ID"],
            secret_access_key=env["SCINTILLE_R2_SECRET_ACCESS_KEY"],
            region="auto",
            virtual_hosted_style_request=False,
        )
        for name, bucket in buckets.items()
    }


def collect(
    catalog: Catalog,
    stores: dict[str, ObjectStore],
    *,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
    listing: Callable[[ObjectStore, str], Iterable[StoredObject]] = list_objects,
) -> dict[str, object]:
    if set(stores) != {"lake", "live"}:
        raise ValueError("both lake and live inventories are required")
    started = now()
    inventories: dict[str, object] = {}
    lake_objects: list[StoredObject] = []
    for name, store in stores.items():
        listing_started = now()
        objects: dict[str, StoredObject] = {}
        for item in listing(store, ""):
            if item.key in objects:
                raise ValueError("duplicate inventory object; recollect after concurrent writes")
            objects[item.key] = item
        values = list(objects.values())
        inventories[name] = {
            "collection_started_at": listing_started.isoformat(),
            "collection_finished_at": now().isoformat(),
            "complete_listing": True,
            "objects": len(values),
            "bytes": sum(o.size for o in values),
            "groups": inventory_measurement(values),
        }
        if name == "lake":
            lake_objects = values
    table = catalog.load_table("silver.flashes")
    measured = table_measurement(table, lake_objects)
    location = object_key(table.location()).rstrip("/") + "/"
    measured["table_location_bytes"] = sum(
        o.size for o in lake_objects if o.key.startswith(location)
    )
    return {
        "schema_version": 1,
        "collection_started_at": started.isoformat(),
        "collection_finished_at": now().isoformat(),
        "tables": {"silver.flashes": measured},
        "source_days": source_days(
            cast(list[dict[str, object]], measured["current_partitions"]), now()
        ),
        "inventories": inventories,
        "limitations": [
            "Listings/catalog reads are not atomic; concurrent writes can change coverage.",
            "Settled partitions do not prove complete ingestion or successful compaction.",
            "Physical rows include flagged/overlapping observations, unlike display counts.",
            "Upload-day cohorts are not source event days or historical ingress.",
            "Environment maintenance settings are not proof of applied provider settings.",
            "Lifecycle, outages, parser/calibration versions and costs need separate evidence.",
        ],
        "scope": "metadata/full bucket listings; no data scan, writes, deletion or policy changes",
    }


def main() -> int:
    try:
        stores = stores_from_env(os.environ)
        report = collect(pyiceberg_catalog(), stores)
        report["configured_maintenance_defaults"] = MaintenancePolicy.from_env().__dict__
        report["provider_policy_verified"] = False
        print(json.dumps(report, indent=2))
    except Exception as error:
        # Storage exceptions can include signed URLs or tokens; keep them out of Actions logs.
        print(
            f"Retention collection failed ({type(error).__name__}); no report produced.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
