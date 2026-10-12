"""Hourly storm publication; intensity values are read, never chosen here."""

import json
import os
from datetime import UTC, datetime, timedelta
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import obstore
import polars as pl
from dagster import (
    AssetExecutionContext,
    AssetKey,
    AssetSelection,
    DefaultScheduleStatus,
    MaterializeResult,
    RunRequest,
    ScheduleEvaluationContext,
    asset,
    define_asset_job,
    schedule,
)
from scintille_contract.models import SCHEMA_VERSION, StormBounds, StormDetail, StormSummary
from scintille_lake.tables import FLASHES

from .resources import FeedResource, LakeResource
from .storm_catalog import (
    ObjectCatalogStore,
    publish_catalog,
    published_slugs,
    replay_chunks,
    selected_flashes,
)
from .storm_cells import hourly
from .storm_names import STORM_NAMES
from .storms import STORM_TRACKS, STORMS, _between, _scan


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


def summaries(
    storms: pl.DataFrame, names: pl.DataFrame, levels: pl.DataFrame
) -> list[StormSummary]:
    joined = storms.join(
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
    group_name="feeds",
    pool="storm-tracks",
    description="Bounded storm metadata, replay, paginated index and sitemaps published in order.",
)
def storm_catalog(
    context: AssetExecutionContext, lake: LakeResource, feed_bucket: FeedResource
) -> MaterializeResult:  # type: ignore[type-arg]
    start, end = context.partition_time_window
    now = datetime.now(UTC)
    catalog = lake.catalog()
    storms = _scan(catalog.load_table(STORMS.identifier), "true")
    names = _scan(catalog.load_table(STORM_NAMES.identifier), "true")
    levels = _scan(catalog.load_table(("gold", "storm_levels")), "true")
    summary = summaries(storms, names, levels)
    tracks_table = catalog.load_table(STORM_TRACKS.identifier)
    touched = _scan(tracks_table, _between("window_start", start - timedelta(hours=1), end))
    ids = set(touched["storm_id"].to_list())
    store = ObjectCatalogStore(feed_bucket.store())
    # Bootstrap omitted history too, without exposing references before their details exist.
    published = published_slugs(store)
    ids.update(s.storm_id for s in summary if s.slug not in published)
    details = []
    objects: dict[str, bytes] = {}
    flash_table = catalog.load_table(FLASHES.identifier)
    for storm in summary:
        if storm.storm_id not in ids:
            continue
        row = storms.filter(pl.col("storm_id") == storm.storm_id).row(0, named=True)
        tracks = _scan(tracks_table, f"storm_id == '{storm.storm_id}'")
        first, last = tracks["window_start"].min(), tracks["window_end"].max()
        assert isinstance(first, datetime) and isinstance(last, datetime)
        flashes = _scan(flash_table, _between("event_time", first, last))
        replay, chunks = replay_chunks(selected_flashes(flashes, tracks))
        objects.update(chunks)
        details.append(
            StormDetail(
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
        )
    regions: list[str] = []
    for batch in obstore.list(feed_bucket.store(), prefix="regions/", chunk_size=1000):
        regions.extend(
            item["path"].removeprefix("regions/").removesuffix(".json")
            for item in batch
            if item["path"].endswith(".json") and item["path"].count("/") == 1
        )
    metrics = publish_catalog(store, details, objects, summary, now, purge_tags, regions)
    context.log.info("Storm catalog published; pending purge tags retry on the next run")
    return MaterializeResult(metadata=metrics)


hourly_storm_catalog = define_asset_job(
    "hourly_storm_catalog",
    selection=AssetSelection.assets(storm_catalog).upstream(),
)


@schedule(
    job=hourly_storm_catalog,
    cron_schedule="20 * * * *",
    execution_timezone="UTC",
    default_status=DefaultScheduleStatus.STOPPED,
)
def storm_catalog_schedule(context: ScheduleEvaluationContext) -> RunRequest:
    now = context.scheduled_execution_time or datetime.now(UTC)
    key = hourly.get_partition_key_for_timestamp((now - timedelta(hours=1)).timestamp())
    return RunRequest(run_key=key, partition_key=key)
