"""Dagster assets for the gold models, their checks, and the daily JSON feed built on them."""

import json
from datetime import UTC, date, datetime
from typing import Any

import duckdb
import obstore
from dagster import (
    AssetCheckResult,
    AssetCheckSeverity,
    AssetCheckSpec,
    AssetExecutionContext,
    AssetKey,
    AssetsDefinition,
    DailyPartitionsDefinition,
    MaterializeResult,
    asset,
)

from ..resources import LakeResource, R2Resource
from .checks import failures
from .models import (
    FLASH_STATS_HOURLY,
    MODELS,
    RELATIONS,
    SOURCE_SLA_DAILY,
    Model,
    compute,
    day_bounds,
    write,
)

# end_offset=1 keeps the open UTC day available to the live sensor.
daily = DailyPartitionsDefinition(start_date="2026-07-01", timezone="UTC", end_offset=1)

FEED_SCHEMA_VERSION = 1
FEED_HEADERS = {"Content-Type": "application/json", "Cache-Control": "public, max-age=300"}


def asset_key(path: str) -> AssetKey:
    return AssetKey(path.split("/"))


def model_key(model: Model) -> AssetKey:
    return AssetKey(list(model.table.identifier))


def gold_asset(model: Model) -> AssetsDefinition:
    """One partitioned asset per model: compute on DuckDB, check, replace the day."""
    key = model_key(model)
    specs = [
        AssetCheckSpec(c.name, asset=key, blocking=True, description=c.description)
        for c in model.checks
    ]

    @asset(
        key=key,
        partitions_def=daily,
        group_name="gold",
        deps=[asset_key(d) for d in model.deps],
        check_specs=specs,
        description=model.description,
    )
    def _gold(context: AssetExecutionContext, lake: LakeResource) -> MaterializeResult:  # type: ignore[type-arg]
        day = date.fromisoformat(context.partition_key)
        start, end = day_bounds(day)
        with lake.duckdb() as con:
            rows = compute(con, model, day)
            failed = {c.name: failures(con, c, rows, RELATIONS, start, end) for c in model.checks}
        write(lake.catalog(), model, day, rows)
        return MaterializeResult(
            metadata={"rows": rows.num_rows},
            check_results=[
                AssetCheckResult(
                    check_name=name,
                    passed=count == 0,
                    severity=AssetCheckSeverity.ERROR,
                    metadata={"failing_rows": count},
                )
                for name, count in failed.items()
            ],
        )

    return _gold


GOLD = [gold_asset(m) for m in MODELS]


def feed_key(day: date) -> str:
    return f"stats/daily/{day.isoformat()}.json"


def daily_stats(
    con: duckdb.DuckDBPyConnection, day: date, published_at: datetime
) -> dict[str, Any]:
    """Per-source totals, hourly counts and delivery SLA for one UTC day."""
    start, end = day_bounds(day)
    hourly = con.execute(
        f"SELECT source, hour(hour) AS h, sum(flashes) AS n FROM {RELATIONS['flash_stats_hourly']}"
        " WHERE hour >= $start AND hour < $end GROUP BY ALL ORDER BY ALL",
        {"start": start, "end": end},
    ).fetchall()
    sla = con.execute(
        "SELECT source, completeness, latency_p50_s, latency_p95_s"
        f" FROM {RELATIONS['source_sla_daily']} WHERE day = $day ORDER BY source",
        {"day": day},
    ).fetchall()
    sources: dict[str, dict[str, Any]] = {}
    for source, h, n in hourly:
        entry = sources.setdefault(source, {"source": source, "flashes": 0, "hourly": [0] * 24})
        entry["flashes"] += n
        entry["hourly"][h] = n
    for source, completeness, p50, p95 in sla:
        entry = sources.setdefault(source, {"source": source, "flashes": 0, "hourly": [0] * 24})
        entry |= {"completeness": completeness, "latency_p50_s": p50, "latency_p95_s": p95}
    return {
        "schema_version": FEED_SCHEMA_VERSION,
        "day": day.isoformat(),
        "published_at": published_at.isoformat().replace("+00:00", "Z"),
        "sources": [sources[s] for s in sorted(sources)],
    }


@asset(
    key=["feeds", "daily_stats"],
    partitions_def=daily,
    group_name="feeds",
    deps=[model_key(FLASH_STATS_HOURLY), model_key(SOURCE_SLA_DAILY)],
    description="Publishes `stats/daily/<day>.json` to R2: flashes per source and hour, and SLA.",
)
def daily_stats_feed(
    context: AssetExecutionContext, lake: LakeResource, r2: R2Resource
) -> MaterializeResult:  # type: ignore[type-arg]
    day = date.fromisoformat(context.partition_key)
    with lake.duckdb() as con:
        con.execute("SET TimeZone = 'UTC'")
        feed = daily_stats(con, day, datetime.now(UTC))
    body = json.dumps(feed, separators=(",", ":")).encode()
    path = feed_key(day)
    obstore.put(r2.store(), path, body, attributes=FEED_HEADERS)
    return MaterializeResult(
        metadata={"path": path, "bytes": len(body), "sources": len(feed["sources"])}
    )
