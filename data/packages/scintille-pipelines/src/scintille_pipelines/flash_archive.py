"""Hourly flash archive for travel in time (ADR 0025): silver flashes as immutable SCNT chunks,
one index per UTC day and a small index of the days kept."""

import hashlib
import json
from collections.abc import Callable, Iterable
from datetime import UTC, date, datetime, timedelta

import obstore
import polars as pl
from dagster import (
    AssetExecutionContext,
    AssetKey,
    BackfillPolicy,
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
from pydantic import AwareDatetime, BaseModel, Field
from pyiceberg.table import Table
from scintille_contract.chunk import Chunk, compress, encode
from scintille_contract.flash_archive import (
    FLASH_ARCHIVE_CHUNK_FLASHES,
    FLASH_ARCHIVE_MAX_HOUR_CHUNKS,
    FLASH_ARCHIVE_SCHEMA_VERSION,
)
from scintille_ingest.runtime.live_feed import columns
from scintille_lake.maintenance import MaintenancePolicy
from scintille_lake.tables import FLASHES

from .resources import FeedResource, LakeResource
from .storm_catalog import CHUNK_HEADERS, JSON_HEADERS, CatalogStore, ObjectCatalogStore
from .storm_cells import hourly
from .tracking import HOUR

PREFIX = "archive/flashes/"
INDEX_PATH = f"{PREFIX}index.json"
RUN_HOURS = 24
FIELDS = (
    "flash_id",
    "event_time",
    "lat",
    "lon",
    "area_km2",
    "duration_ms",
    "intensity",
    "source",
    "quality",
)


class ArchiveChunk(BaseModel):
    path: str
    """Relative to the day index."""
    flash_count: int = Field(ge=1)
    size_bytes: int = Field(ge=1)
    event_min: AwareDatetime
    event_max: AwareDatetime


class ArchiveHour(BaseModel):
    start: AwareDatetime
    """Chunk origin: event offsets are relative to this hour."""
    flash_count: int = Field(ge=1)
    chunks: list[ArchiveChunk] = Field(min_length=1, max_length=FLASH_ARCHIVE_MAX_HOUR_CHUNKS)


class ArchiveDay(BaseModel):
    schema_version: int = FLASH_ARCHIVE_SCHEMA_VERSION
    day: date
    generated_at: AwareDatetime
    hours: list[ArchiveHour]
    """Oldest first; an hour without flashes in silver is absent, never empty."""


class ArchiveIndex(BaseModel):
    schema_version: int = FLASH_ARCHIVE_SCHEMA_VERSION
    generated_at: AwareDatetime
    retention_days: int
    first_day: date
    last_hour: AwareDatetime


def day_path(day: date) -> str:
    return f"{PREFIX}manifests/{day.isoformat()}.json"


def hour_chunks(
    flashes: pl.DataFrame, hour: datetime
) -> tuple[ArchiveHour | None, dict[str, bytes]]:
    """Flashes of one hour, sorted by event time, in chunks named by their content."""
    if flashes.is_empty():
        return None, {}
    ordered = flashes.unique("flash_id").sort("event_time", "flash_id")
    refs, objects = [], {}
    for part in ordered.iter_slices(FLASH_ARCHIVE_CHUNK_FLASHES):
        body = compress(encode(Chunk(hour, columns(part, hour))))
        name = f"chunks/{hashlib.sha256(body).hexdigest()}.bin.gz"
        objects[PREFIX + name] = body
        first, last = part["event_time"].min(), part["event_time"].max()
        assert isinstance(first, datetime) and isinstance(last, datetime)
        refs.append(
            ArchiveChunk(
                path=f"../{name}",
                flash_count=part.height,
                size_bytes=len(body),
                event_min=first,
                event_max=last,
            )
        )
    return ArchiveHour(start=hour, flash_count=ordered.height, chunks=refs), objects


def read_day(store: CatalogStore, day: date) -> ArchiveDay | None:
    body = store.get(day_path(day))
    if body is None:
        return None
    payload = json.loads(body)
    if payload.get("schema_version") != FLASH_ARCHIVE_SCHEMA_VERSION:
        raise ValueError(f"unsupported flash archive version: {payload.get('schema_version')}")
    return ArchiveDay.model_validate(payload)


def read_index(store: CatalogStore) -> ArchiveIndex | None:
    body = store.get(INDEX_PATH)
    return ArchiveIndex.model_validate_json(body) if body is not None else None


def with_hour(day: ArchiveDay, start: datetime, hour: ArchiveHour | None) -> ArchiveDay:
    kept = [h for h in day.hours if h.start != start]
    hours = sorted([*kept, hour] if hour else kept, key=lambda h: h.start)
    return day.model_copy(update={"hours": hours})


def next_index(
    previous: ArchiveIndex | None,
    days: Iterable[ArchiveDay],
    today: date,
    retention_days: int,
    now: datetime,
) -> ArchiveIndex | None:
    """Days with at least one archived hour, trimmed to the retention."""
    starts = [hour.start for day in days for hour in day.hours]
    if previous is not None:
        starts += [
            datetime.combine(previous.first_day, datetime.min.time(), UTC),
            previous.last_hour,
        ]
    oldest = today - timedelta(days=retention_days - 1)
    if not starts or max(starts).date() < oldest:
        return None
    return ArchiveIndex(
        generated_at=now,
        retention_days=retention_days,
        first_day=max(min(starts).date(), oldest),
        last_hour=max(starts),
    )


def publish_hours(
    store: CatalogStore,
    read_hour: Callable[[datetime], pl.DataFrame],
    hours: list[datetime],
    now: datetime,
    retention_days: int,
    delete: Callable[[str], None],
) -> dict[str, int]:
    """Rewrites only the hours whose flashes changed, then deletes the chunks they replaced, and
    drops the days leaving the retention."""
    metrics = {"hours": len(hours), "changed_hours": 0, "flashes": 0, "chunks_written": 0}
    days: dict[date, ArchiveDay] = {}
    changed_days: set[date] = set()
    replaced: set[str] = set()
    for start in hours:
        hour, objects = hour_chunks(read_hour(start), start)
        day = start.date()
        if day not in days:
            days[day] = read_day(store, day) or ArchiveDay(day=day, generated_at=now, hours=[])
        current = next((h for h in days[day].hours if h.start == start), None)
        metrics["flashes"] += hour.flash_count if hour else 0
        if current == hour:
            continue
        for path, body in objects.items():
            store.put(path, body, CHUNK_HEADERS)
        metrics["chunks_written"] += len(objects)
        metrics["changed_hours"] += 1
        if current is not None:
            replaced |= {PREFIX + c.path.removeprefix("../") for c in current.chunks} - set(objects)
        days[day] = with_hour(days[day], start, hour)
        changed_days.add(day)
    for day in sorted(changed_days):
        manifest = days[day].model_copy(update={"generated_at": now})
        store.put(day_path(day), manifest.model_dump_json().encode(), JSON_HEADERS)
    for path in sorted(replaced):
        delete(path)
    metrics["chunks_deleted"] = len(replaced)
    previous = read_index(store)
    index = next_index(previous, days.values(), now.date(), retention_days, now)
    if index is not None and (
        previous is None
        or index.model_dump(exclude={"generated_at"})
        != previous.model_dump(exclude={"generated_at"})
    ):
        store.put(INDEX_PATH, index.model_dump_json().encode(), JSON_HEADERS)
    if previous is not None and index is not None and index.first_day > previous.first_day:
        metrics["expired_days"] = expire_days(store, previous.first_day, index.first_day, delete)
    return metrics


def expire_days(
    store: CatalogStore, first: date, until: date, delete: Callable[[str], None]
) -> int:
    """Deletes the chunks and indexes of days [first, until); the lifecycle rule is the backstop."""
    expired = 0
    day = first
    while day < until:
        manifest = read_day(store, day)
        if manifest is not None:
            for hour in manifest.hours:
                for chunk in hour.chunks:
                    delete(PREFIX + chunk.path.removeprefix("../"))
            delete(day_path(day))
            expired += 1
        day += timedelta(days=1)
    return expired


def scan_hour(table: Table, start: datetime) -> pl.DataFrame:
    end = start + HOUR
    row_filter = f"event_time >= '{start.isoformat()}' AND event_time < '{end.isoformat()}'"
    df = pl.from_arrow(table.scan(row_filter=row_filter, selected_fields=FIELDS).to_arrow())
    assert isinstance(df, pl.DataFrame)
    return df


def window_hours(start: datetime, end: datetime) -> list[datetime]:
    hours, hour = [], start
    while hour < end:
        hours.append(hour)
        hour += HOUR
    return hours


@asset(
    key=["feeds", "flash_archive"],
    partitions_def=hourly,
    deps=[AssetKey(["silver", "flashes"])],
    backfill_policy=BackfillPolicy.multi_run(RUN_HOURS),
    group_name="feeds",
    pool="flash-archive",
    description="Silver flashes by UTC hour for travel in time, kept as long as silver.",
)
def flash_archive(
    context: AssetExecutionContext, lake: LakeResource, feed_bucket: FeedResource
) -> MaterializeResult:  # type: ignore[type-arg]
    start, end = context.partition_time_window
    table = lake.catalog().load_table(FLASHES.identifier)
    feed = feed_bucket.store()

    def delete(path: str) -> None:
        obstore.delete(feed, path)

    metrics = publish_hours(
        ObjectCatalogStore(feed),
        lambda hour: scan_hour(table, hour),
        window_hours(start, end),
        datetime.now(UTC),
        MaintenancePolicy.from_env().silver_retention_days,
        delete,
    )
    return MaterializeResult(metadata=metrics)


hourly_flash_archive = define_asset_job(
    "hourly_flash_archive",
    selection=[flash_archive],
    op_retry_policy=RetryPolicy(max_retries=3, delay=30, backoff=Backoff.EXPONENTIAL),
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


def planned_hours(
    last: datetime | None, target: datetime, retention_days: int
) -> tuple[datetime, datetime]:
    """The two newest archived hours again, for late rows, then what follows, one run at a time.
    Without history, starts where silver starts to be kept."""
    oldest = (target - timedelta(days=retention_days - 1)).replace(hour=0)
    first = oldest if last is None else max(oldest, min(last, target) - HOUR)
    return first, min(target, first + (RUN_HOURS - 1) * HOUR)


def _range(hours: tuple[datetime, datetime]) -> RunRequest:
    start, end = (hourly.get_partition_key_for_timestamp(t.timestamp()) for t in hours)
    return RunRequest(
        tags={ASSET_PARTITION_RANGE_START_TAG: start, ASSET_PARTITION_RANGE_END_TAG: end}
    )


@schedule(
    job=hourly_flash_archive,
    cron_schedule="2,32 * * * *",
    execution_timezone="UTC",
    default_status=DefaultScheduleStatus.RUNNING,
)
def flash_archive_schedule(context: ScheduleEvaluationContext) -> RunRequest | SkipReason:
    """Every half hour, so an hour is complete before it leaves the live window."""
    now = context.scheduled_execution_time or datetime.now(UTC)
    instance = context.instance
    if instance.get_runs(RunsFilter(job_name=hourly_flash_archive.name, statuses=ACTIVE), limit=1):
        return SkipReason("An archive run is still queued or running")
    target = hour_of(hourly.get_partition_key_for_timestamp((now - HOUR).timestamp()))
    published = instance.get_materialized_partitions(flash_archive.key)
    last = hour_of(max(published)) if published else None
    return _range(planned_hours(last, target, MaintenancePolicy.from_env().silver_retention_days))


@schedule(
    job=hourly_flash_archive,
    cron_schedule="45 2 * * *",
    execution_timezone="UTC",
    default_status=DefaultScheduleStatus.RUNNING,
)
def flash_archive_repair_schedule(context: ScheduleEvaluationContext) -> RunRequest:
    """Yesterday again, for rows that reached silver hours late."""
    now = context.scheduled_execution_time or datetime.now(UTC)
    midnight = now.astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    return _range((midnight - timedelta(days=1), midnight - HOUR))
