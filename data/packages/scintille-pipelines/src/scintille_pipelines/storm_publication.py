"""Hourly storm publication; intensity values are read, never chosen here."""

import json
import os
from collections import defaultdict
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import duckdb
import obstore
import polars as pl
from dagster import (
    AssetExecutionContext,
    AssetKey,
    AssetSelection,
    Backoff,
    DagsterRunStatus,
    DefaultScheduleStatus,
    MaterializeResult,
    RetryPolicy,
    RunRequest,
    RunsFilter,
    ScheduleEvaluationContext,
    SkipReason,
    asset,
    define_asset_job,
    schedule,
)
from dagster._core.storage.tags import (
    ASSET_PARTITION_RANGE_END_TAG,
    ASSET_PARTITION_RANGE_START_TAG,
)
from scintille_contract.models import (
    SCHEMA_VERSION,
    StormBounds,
    StormDetail,
    StormHighlights,
    StormSummary,
)
from scintille_lake.tables import FLASHES

from .resources import FeedResource, LakeResource
from .storm_catalog import (
    ObjectCatalogStore,
    publish_catalog,
    published_slugs,
    read_detail,
    replay_chunks,
    selected_flashes,
)
from .storm_cells import BACKFILL, RUN_HOURS, hourly
from .storm_highlights import haversine_km, highlights, storm_metrics
from .storm_levels import STORM_LEVELS
from .storm_names import STORM_NAMES
from .storms import STORM_TRACKS, STORMS, _between, _scan
from .tracking import HOUR

BOOTSTRAP_STORMS = 100
# Strong and above (ADR 0009): about a quarter of storms, nine tenths of the flashes.
PUBLISHED_MIN_LEVEL = 3
FLASH_WINDOW = timedelta(hours=6)


def export_candidates(
    summary: list[StormSummary], published: set[str], touched: set[str]
) -> set[str]:
    historical = sorted(
        (s for s in summary if s.slug not in published and s.storm_id not in touched),
        key=lambda storm: (storm.t_start, storm.storm_id),
    )
    return touched | {storm.storm_id for storm in historical[:BOOTSTRAP_STORMS]}


def flash_windows(
    steps: list[tuple[datetime, datetime]],
) -> list[tuple[tuple[datetime, datetime], list[int]]]:
    """Group track steps, sorted by start, into silver scans of at most FLASH_WINDOW."""
    groups: list[tuple[tuple[datetime, datetime], list[int]]] = []
    for index, (first, last) in enumerate(steps):
        if groups:
            (start, end), members = groups[-1]
            if max(end, last) - start <= FLASH_WINDOW:
                groups[-1] = ((start, max(end, last)), [*members, index])
                continue
        groups.append(((first, last), [index]))
    return groups


def purge_tags(tags: list[str]) -> bool:
    token, zone = os.environ.get("SCINTILLE_PURGE_TOKEN"), os.environ.get("SCINTILLE_CF_ZONE_ID")
    if not token or not zone:
        return False
    request = Request(
        f"https://api.cloudflare.com/client/v4/zones/{zone}/purge_cache",
        data=json.dumps({"tags": tags}).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=10) as response:
            return bool(json.load(response).get("success"))
    except (HTTPError, URLError, TimeoutError, ValueError):
        return False


def publishable(summary: list[StormSummary]) -> list[StormSummary]:
    return [storm for storm in summary if storm.level >= PUBLISHED_MIN_LEVEL]


def distances(storms: pl.DataFrame) -> pl.DataFrame:
    """Kilometres travelled by each storm centroid along its track."""
    points = storms.select("storm_id", "track").explode("track").unnest("track")
    steps = points.sort("storm_id", "time").with_columns(
        haversine_km(
            pl.col("lat").shift().over("storm_id"),
            pl.col("lon").shift().over("storm_id"),
            pl.col("lat"),
            pl.col("lon"),
        ).alias("step_km")
    )
    return steps.group_by("storm_id").agg(pl.col("step_km").sum().round(1).alias("distance_km"))


def summaries(
    storms: pl.DataFrame, names: pl.DataFrame, levels: pl.DataFrame
) -> list[StormSummary]:
    joined = storms.join(distances(storms), on="storm_id", how="left").join(
        names.select("storm_id", "slug", "name", "label", "country_code"), on="storm_id"
    )
    joined = joined.join(
        levels.select("storm_id", "flashes", "peak_rate", "level", "level_name", "level_rule"),
        on="storm_id",
    )
    if joined.height != storms.height or joined["storm_id"].n_unique() != storms.height:
        raise ValueError("every storm needs exactly one stable name and persisted classification")
    fields = tuple(StormSummary.model_fields)
    return [StormSummary.model_validate(row) for row in joined.select(fields).iter_rows(named=True)]


@asset(
    key=["feeds", "storm_catalog"],
    partitions_def=hourly,
    deps=[AssetKey(["gold", key]) for key in ("storms", "storm_names", "storm_levels")],
    backfill_policy=BACKFILL,
    group_name="feeds",
    pool="storm-tracks",
    description="Storm metadata, replay, index, highlights and sitemaps, published in order.",
)
def storm_catalog(
    context: AssetExecutionContext, lake: LakeResource, feed_bucket: FeedResource
) -> MaterializeResult:  # type: ignore[type-arg]
    start, end = context.partition_time_window
    now = datetime.now(UTC)
    catalog = lake.catalog()
    storms = _scan(catalog.load_table(STORMS.identifier), "true")
    names = _scan(catalog.load_table(STORM_NAMES.identifier), "true")
    levels = _scan(catalog.load_table(STORM_LEVELS.identifier), "true")
    classified = summaries(storms, names, levels)
    summary = publishable(classified)
    tracks_table = catalog.load_table(STORM_TRACKS.identifier)
    touched = _scan(tracks_table, _between("window_start", start - timedelta(hours=1), end))
    touched_ids = set(touched["storm_id"].to_list())
    store = ObjectCatalogStore(feed_bucket.store())
    # Bootstrap omitted history too, without exposing references before their details exist.
    published = published_slugs(store)
    ids = export_candidates(summary, published, touched_ids)
    details = []
    rejected: dict[str, StormSummary | None] = {}
    objects: dict[str, bytes] = {}
    flash_table = catalog.load_table(FLASHES.identifier)

    def reject(slug: str) -> None:
        previous = store.get(f"storms/{slug}.json")
        rejected[slug] = read_detail(previous).storm if previous is not None else None

    candidates = {storm.storm_id: storm for storm in summary if storm.storm_id in ids}
    all_tracks = (
        _scan(tracks_table, f"storm_id IN ({', '.join(repr(i) for i in candidates)})")
        if candidates
        else touched.clear()
    )
    valid = []
    for storm in candidates.values():
        tracks = all_tracks.filter(pl.col("storm_id") == storm.storm_id)
        first, last = tracks["window_start"].min(), tracks["window_end"].max()
        if not isinstance(first, datetime) or not isinstance(last, datetime):
            context.log.error("Skipping storm without a valid track: %s", storm.slug)
            reject(storm.slug)
            continue
        valid.append(storm.storm_id)
    steps = (
        all_tracks.filter(pl.col("storm_id").is_in(valid))
        .with_columns(scan_start=pl.min_horizontal("window_start", "t_start"))
        .sort("scan_start")
    )
    selected: dict[str, list[pl.DataFrame]] = defaultdict(list)
    # Bounded silver scans shared by every storm, long ones read piece by piece.
    for (start_window, end_window), rows in flash_windows(
        list(zip(steps["scan_start"], steps["window_end"], strict=True))
    ):
        flashes = _scan(flash_table, _between("event_time", start_window, end_window))
        for (storm_id,), part in steps[rows].partition_by("storm_id", as_dict=True).items():
            selected[str(storm_id)].append(selected_flashes(flashes, part))
        del flashes
    for storm_id in valid:
        storm = candidates[storm_id]
        row = storms.filter(pl.col("storm_id") == storm_id).row(0, named=True)
        flashes = (
            pl.concat(selected.pop(storm_id)).unique("flash_id").sort("event_time", "flash_id")
        )
        try:
            replay, chunks = replay_chunks(flashes)
            detail = StormDetail(
                schema_version=SCHEMA_VERSION,
                published_at=now,
                last_observation_time=storm.t_end,
                storm=storm,
                bounds=StormBounds.model_validate(
                    {key: row[key] for key in ("west", "south", "east", "north")}
                ),
                track=row["track"],
                replay=replay,
            )
        except ValueError:
            context.log.exception("Skipping invalid storm export: %s", storm.slug)
            reject(storm.slug)
            continue
        objects.update(chunks)
        details.append(detail)
    visible = [
        rejected.get(storm.slug) or storm
        for storm in summary
        if (storm.slug in published or storm.storm_id in ids)
        and (storm.slug not in rejected or rejected[storm.slug] is not None)
    ]
    regions: list[str] = []
    for batch in obstore.list(feed_bucket.store(), prefix="regions/", chunk_size=1000):
        regions.extend(
            item["path"].removeprefix("regions/").removesuffix(".json")
            for item in batch
            if item["path"].endswith(".json") and item["path"].count("/") == 1
        )
    storm_stats = storm_metrics(storms, levels, names)

    def pick(effective: Sequence[StormSummary]) -> StormHighlights | None:
        try:
            return highlights(effective, storm_stats, now)
        except (ValueError, duckdb.Error):
            context.log.exception("Highlights failed; the previous file stays published")
            return None

    metrics = publish_catalog(
        store, details, objects, visible, now, purge_tags, regions, highlights=pick
    )
    metrics["detected"] = len(classified)
    metrics["invalid_exports"] = len(rejected)
    metrics["below_level"] = len(classified) - len(summary)
    metrics["bootstrap_remaining"] = sum(
        storm.slug not in published and storm.storm_id not in ids for storm in summary
    )
    context.log.info("Storm catalog published; pending purge tags retry on the next run")
    return MaterializeResult(metadata=metrics)


hourly_storm_catalog = define_asset_job(
    "hourly_storm_catalog",
    selection=AssetSelection.assets(storm_catalog).upstream(),
    # A transient R2 read error must not leave an hour out of the tracking chain.
    op_retry_policy=RetryPolicy(max_retries=3, delay=30, backoff=Backoff.EXPONENTIAL),
    # Run monitoring fails a run orphaned by a daemon restart, which frees its pool.
    run_tags={"dagster/max_runtime": "3600"},
)

ACTIVE = [
    DagsterRunStatus.QUEUED,
    DagsterRunStatus.STARTING,
    DagsterRunStatus.STARTED,
    DagsterRunStatus.CANCELING,
]


def hour_of(key: str) -> datetime:
    return datetime.strptime(key, "%Y-%m-%d-%H:%M").replace(tzinfo=UTC)


def next_hours(last: datetime | None, target: datetime) -> tuple[datetime, datetime] | None:
    """The hours after the last published one, up to `target`, at most one run's worth."""
    if last is None or last >= target:
        return None
    start = last + HOUR
    return start, min(target, start + (RUN_HOURS - 1) * HOUR)


@schedule(
    job=hourly_storm_catalog,
    cron_schedule="20 * * * *",
    execution_timezone="UTC",
    default_status=DefaultScheduleStatus.STOPPED,
)
def storm_catalog_schedule(context: ScheduleEvaluationContext) -> RunRequest | SkipReason:
    """Publishes up to the previous hour, starting from the first hour not published yet."""
    now = context.scheduled_execution_time or datetime.now(UTC)
    instance = context.instance
    if instance.get_runs(RunsFilter(job_name=hourly_storm_catalog.name, statuses=ACTIVE), limit=1):
        return SkipReason("A catalog run is still queued or running")
    target = hour_of(hourly.get_partition_key_for_timestamp((now - HOUR).timestamp()))
    published = instance.get_materialized_partitions(storm_catalog.key)
    last = hour_of(max(published)) if published else None
    hours = next_hours(last, target)
    if hours is None:
        return SkipReason("Up to date" if last else "Nothing published yet: start a chain first")
    start, end = (hourly.get_partition_key_for_timestamp(t.timestamp()) for t in hours)
    return RunRequest(
        tags={ASSET_PARTITION_RANGE_START_TAG: start, ASSET_PARTITION_RANGE_END_TAG: end}
    )
