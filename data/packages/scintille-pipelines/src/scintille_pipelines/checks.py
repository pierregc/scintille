"""Asset checks on `silver.flashes`: hourly on the last closed hour, daily on yesterday."""

from collections import Counter
from datetime import UTC, date, datetime, timedelta

import polars as pl
from dagster import (
    AssetCheckResult,
    AssetCheckSeverity,
    AssetKey,
    AssetSpec,
    MetadataValue,
    asset_check,
)
from pyiceberg.catalog import Catalog
from scintille_lake.tables import FLASHES, FLASHES_QUARANTINE, INGEST_LOG

from . import quality
from .resources import LakeResource, PostgresResource

SILVER = AssetSpec(
    key=AssetKey(["silver", "flashes"]),
    group_name="silver",
    description="Written by lake-writer (hot path) and backfills; checked here.",
)
SOURCES = ["glm-east", "glm-west"]
BASELINE_DAYS = 7


def clock() -> datetime:
    return datetime.now(UTC)


def last_closed_hour(now: datetime) -> datetime:
    return now.replace(minute=0, second=0, microsecond=0) - timedelta(hours=1)


def _scan(
    catalog: Catalog, identifier: tuple[str, str], column: str, start: datetime, end: datetime
) -> pl.DataFrame:
    table = catalog.load_table(identifier)
    rows = table.scan(
        row_filter=f"{column} >= '{start.isoformat()}' AND {column} < '{end.isoformat()}'"
    )
    frame = pl.from_arrow(rows.to_arrow())
    assert isinstance(frame, pl.DataFrame)
    return frame


def _metadata(values: dict[str, object]) -> dict[str, MetadataValue]:
    def convert(value: object) -> MetadataValue:
        if isinstance(value, bool):
            return MetadataValue.bool(value)
        if isinstance(value, int):
            return MetadataValue.int(value)
        if isinstance(value, float):
            return MetadataValue.float(value)
        if isinstance(value, dict | list):
            return MetadataValue.json(value)
        return MetadataValue.text(str(value))

    return {k: convert(v) for k, v in values.items()}


def _result(
    outcome: quality.Outcome, severity: AssetCheckSeverity = AssetCheckSeverity.ERROR
) -> AssetCheckResult:
    return AssetCheckResult(
        passed=outcome.passed, severity=severity, metadata=_metadata(outcome.metadata)
    )


@asset_check(
    asset=SILVER.key, description="Each source has recent flashes in silver (lag < 20 min)."
)
def silver_freshness(lake: LakeResource) -> AssetCheckResult:
    now = clock()
    flashes = _scan(lake.catalog(), FLASHES.identifier, "event_time", now - timedelta(hours=6), now)
    latest = {s: flashes.filter(pl.col("source") == s)["event_time"].max() for s in SOURCES}
    return _result(
        quality.freshness(
            {s: t if isinstance(t, datetime) else None for s, t in latest.items()}, now
        )
    )


@asset_check(
    asset=SILVER.key, description="≥ 99 % of the expected product files in the last closed hour."
)
def silver_completeness(lake: LakeResource) -> AssetCheckResult:
    hour = last_closed_hour(clock())
    log = _scan(
        lake.catalog(), INGEST_LOG.identifier, "product_start", hour, hour + timedelta(hours=1)
    )
    files = Counter(log["source"].to_list())
    return _result(quality.completeness(files, SOURCES))


@asset_check(
    asset=SILVER.key, description="Coordinates, energy and event times in range, last closed hour."
)
def silver_ranges(lake: LakeResource) -> AssetCheckResult:
    hour = last_closed_hour(clock())
    catalog = lake.catalog()
    flashes = _scan(catalog, FLASHES.identifier, "event_time", hour, hour + timedelta(hours=1))
    log = _scan(
        catalog,
        INGEST_LOG.identifier,
        "product_start",
        hour - timedelta(hours=1),
        hour + timedelta(hours=2),
    )
    return _result(quality.ranges(flashes, log))


@asset_check(
    asset=SILVER.key, description="Flash count within 0.2x to 5x the same hour of the last 7 days."
)
def silver_volume(lake: LakeResource) -> AssetCheckResult:
    hour = last_closed_hour(clock())
    catalog = lake.catalog()
    count = _scan(catalog, FLASHES.identifier, "event_time", hour, hour + timedelta(hours=1)).height
    baseline = [
        _scan(
            catalog,
            FLASHES.identifier,
            "event_time",
            hour - timedelta(days=d),
            hour - timedelta(days=d, hours=-1),
        ).height
        for d in range(1, BASELINE_DAYS + 1)
    ]
    return _result(
        quality.volume_anomaly(count, [b for b in baseline if b]), AssetCheckSeverity.WARN
    )


def closed_day(now: datetime) -> date:
    return (now - timedelta(days=1)).date()


@asset_check(asset=SILVER.key, description="No flash_id twice in yesterday's partitions.")
def silver_uniqueness(lake: LakeResource) -> AssetCheckResult:
    day = closed_day(clock())
    start = datetime(day.year, day.month, day.day, tzinfo=UTC)
    table = lake.catalog().load_table(FLASHES.identifier)
    end = start + timedelta(days=1)
    ids = table.scan(
        row_filter=f"event_time >= '{start.isoformat()}' AND event_time < '{end.isoformat()}'",
        selected_fields=("flash_id",),
    ).to_arrow()
    return _result(quality.uniqueness(pl.Series(ids["flash_id"])))


@asset_check(
    asset=SILVER.key,
    description="Postgres file states, bronze and silver agree per source and hour (yesterday).",
)
def silver_reconciliation(lake: LakeResource, postgres: PostgresResource) -> AssetCheckResult:
    day = closed_day(clock())
    start = datetime(day.year, day.month, day.day, tzinfo=UTC)
    end = start + timedelta(days=1)
    catalog = lake.catalog()
    log = _scan(catalog, INGEST_LOG.identifier, "product_start", start, end)
    flashes = _scan(
        catalog,
        FLASHES.identifier,
        "event_time",
        start - timedelta(hours=1),
        end + timedelta(hours=1),
    )
    rejected = _scan(
        catalog, FLASHES_QUARANTINE.identifier, "ingest_time", start, end + timedelta(hours=2)
    )
    hour_of = {
        k.rsplit("/", 1)[-1]: (s, t.hour)
        for k, s, t in log.select("key", "source", "product_start").iter_rows()
    }
    logged = Counter(hour_of.values())
    log_rows = Counter[tuple[str, int]]()
    for source, t, n in log.select("source", "product_start", "row_count").iter_rows():
        log_rows[(source, t.hour)] += n
    parsed = Counter[tuple[str, int]]()
    for frame in (flashes, rejected):
        for product_file in frame["product_file"].to_list():
            if product_file in hour_of:
                parsed[hour_of[product_file]] += 1
    keys = log["key"].to_list()
    with postgres.connect() as conn:
        rows = conn.execute(
            "SELECT key FROM ingest_files WHERE state = 'spooled' AND key = ANY(%s)", [keys]
        ).fetchall()
    known = {r[0] for r in rows}
    spooled = Counter(hour_of[k.rsplit("/", 1)[-1]] for k in keys if k in known)
    return _result(quality.reconciliation(spooled, logged, log_rows, parsed))


HOURLY = [silver_freshness, silver_completeness, silver_ranges, silver_volume]
DAILY = [silver_uniqueness, silver_reconciliation]
