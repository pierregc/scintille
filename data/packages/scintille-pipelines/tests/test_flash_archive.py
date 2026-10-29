import gzip
import json
from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import obstore
import polars as pl
import pyarrow as pa
import pytest
from dagster import (
    AssetMaterialization,
    DagsterInstance,
    DagsterRunStatus,
    RunRequest,
    SkipReason,
    build_schedule_context,
    materialize,
)
from dagster._core.storage.tags import (
    ASSET_PARTITION_RANGE_END_TAG,
    ASSET_PARTITION_RANGE_START_TAG,
)
from dagster._core.test_utils import create_run_for_test, instance_for_test
from obstore.store import MemoryStore, ObjectStore
from pyiceberg.catalog import Catalog
from pyiceberg.catalog.sql import SqlCatalog
from scintille_contract.chunk import decode
from scintille_lake.migrate import migrate
from scintille_lake.tables import FLASHES
from scintille_pipelines import flash_archive as module
from scintille_pipelines.flash_archive import (
    INDEX_PATH,
    PREFIX,
    ArchiveDay,
    ArchiveIndex,
    day_path,
    flash_archive,
    flash_archive_repair_schedule,
    flash_archive_schedule,
    hour_chunks,
    hourly_flash_archive,
    next_index,
    planned_hours,
    publish_hours,
)
from scintille_pipelines.resources import FeedResource, LakeResource

HOUR = timedelta(hours=1)
H0 = datetime(2026, 10, 15, 18, tzinfo=UTC)
NOW = datetime(2026, 10, 29, 18, 2, tzinfo=UTC)


def frame(times: list[datetime], ids: list[int] | None = None) -> pl.DataFrame:
    ids = ids if ids is not None else list(range(len(times)))
    return pl.DataFrame(
        {
            "flash_id": [f"{i:032x}" for i in ids],
            "event_time": times,
            "lat": [10.0] * len(times),
            "lon": [-60.0] * len(times),
            "area_km2": [100.0] * len(times),
            "duration_ms": [200.0] * len(times),
            "intensity": [0.5] * len(times),
            "source": ["glm-east"] * len(times),
            "quality": [[]] * len(times),
        },
        schema_overrides={"event_time": pl.Datetime("us", "UTC"), "quality": pl.List(pl.String)},
    )


class Store:
    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}
        self.writes: list[str] = []
        self.deleted: list[str] = []

    def put(self, path: str, data: bytes, headers: dict[str, str]) -> None:
        self.writes.append(path)
        self.files[path] = data

    def get(self, path: str) -> bytes | None:
        return self.files.get(path)

    def exists(self, path: str) -> bool:
        return path in self.files

    def delete(self, path: str) -> None:
        self.deleted.append(path)
        self.files.pop(path, None)


def publish(
    store: Store, hours: dict[datetime, pl.DataFrame], now: datetime = NOW
) -> dict[str, int]:
    return publish_hours(
        store,
        lambda hour: hours.get(hour, frame([])),
        sorted(hours),
        now,
        21,
        store.delete,
    )


def day_of(store: Store, day: date) -> ArchiveDay:
    return ArchiveDay.model_validate_json(store.files[day_path(day)])


def test_hour_is_sorted_deduplicated_and_split(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(module, "FLASH_ARCHIVE_CHUNK_FLASHES", 2)
    times = [H0 + timedelta(minutes=m) for m in (30, 5, 50, 5)]
    hour, objects = hour_chunks(frame(times, [1, 2, 3, 2]), H0)
    assert hour is not None
    assert hour.flash_count == 3
    assert [c.flash_count for c in hour.chunks] == [2, 1]
    assert [c.event_min for c in hour.chunks] == [
        H0 + timedelta(minutes=5),
        H0 + timedelta(minutes=50),
    ]
    for ref in hour.chunks:
        name = PREFIX + ref.path.removeprefix("../")
        assert ref.size_bytes == len(objects[name])
        chunk = decode(gzip.decompress(objects[name]))
        assert chunk.start == H0
        assert chunk.count == ref.flash_count
    first = decode(gzip.decompress(objects[PREFIX + hour.chunks[0].path.removeprefix("../")]))
    assert list(first.columns["event_offset_ms"]) == [300_000, 1_800_000]


def test_empty_hour_is_not_archived() -> None:
    assert hour_chunks(frame([]), H0) == (None, {})


def test_publish_writes_chunks_day_and_index() -> None:
    store = Store()
    metrics = publish(store, {H0: frame([H0 + timedelta(minutes=1)]), H0 + HOUR: frame([])})
    assert metrics["changed_hours"] == 1
    day = day_of(store, H0.date())
    assert [h.start for h in day.hours] == [H0]
    assert all(PREFIX + c.path.removeprefix("../") in store.files for c in day.hours[0].chunks)
    index = ArchiveIndex.model_validate_json(store.files[INDEX_PATH])
    assert (index.first_day, index.last_hour, index.retention_days) == (H0.date(), H0, 21)


def test_unchanged_hours_write_nothing() -> None:
    store = Store()
    hours = {H0: frame([H0 + timedelta(minutes=1)])}
    publish(store, hours)
    store.writes.clear()
    assert publish(store, hours)["changed_hours"] == 0
    assert store.writes == []


def test_late_rows_replace_the_hour_and_delete_its_old_chunks() -> None:
    store = Store()
    publish(store, {H0: frame([H0 + timedelta(minutes=1)], [1])})
    old = day_of(store, H0.date()).hours[0].chunks[0].path
    publish(store, {H0: frame([H0 + timedelta(minutes=1), H0 + timedelta(minutes=2)], [1, 2])})
    hour = day_of(store, H0.date()).hours[0]
    assert hour.flash_count == 2
    assert store.deleted == [PREFIX + old.removeprefix("../")]
    assert PREFIX + hour.chunks[0].path.removeprefix("../") in store.files


def test_hour_emptied_in_silver_leaves_the_day() -> None:
    store = Store()
    publish(store, {H0: frame([H0]), H0 + HOUR: frame([H0 + HOUR])})
    publish(store, {H0 + HOUR: frame([])})
    assert [h.start for h in day_of(store, H0.date()).hours] == [H0]


def test_index_keeps_the_retention_and_expires_older_days() -> None:
    store = Store()
    old = datetime(2026, 10, 1, 12, tzinfo=UTC)
    publish(store, {old: frame([old])}, now=datetime(2026, 10, 2, tzinfo=UTC))
    publish(store, {H0: frame([H0])}, now=NOW)
    index = ArchiveIndex.model_validate_json(store.files[INDEX_PATH])
    assert index.first_day == date(2026, 10, 9)
    assert day_path(old.date()) not in store.files
    assert not any(
        p.startswith(PREFIX + "chunks/") and p not in _referenced(store) for p in store.files
    )


def _referenced(store: Store) -> set[str]:
    day = day_of(store, H0.date())
    return {PREFIX + c.path.removeprefix("../") for h in day.hours for c in h.chunks}


def test_index_needs_an_hour_inside_the_retention() -> None:
    old = ArchiveDay(day=date(2026, 9, 1), generated_at=NOW, hours=[])
    assert next_index(None, [old], NOW.date(), 21, NOW) is None


def test_plan_starts_where_silver_is_kept() -> None:
    target = datetime(2026, 10, 29, 17, tzinfo=UTC)
    assert planned_hours(None, target, 21) == (
        datetime(2026, 10, 9, tzinfo=UTC),
        datetime(2026, 10, 9, 23, tzinfo=UTC),
    )


def test_plan_rereads_the_two_newest_hours() -> None:
    target = datetime(2026, 10, 29, 17, tzinfo=UTC)
    assert planned_hours(target, target, 21) == (target - HOUR, target)
    assert planned_hours(target - HOUR, target, 21) == (target - 2 * HOUR, target)


def test_plan_catches_up_a_day_at_a_time() -> None:
    target = datetime(2026, 10, 29, 17, tzinfo=UTC)
    last = datetime(2026, 10, 20, 5, tzinfo=UTC)
    assert planned_hours(last, target, 21) == (last - HOUR, last + 22 * HOUR)


@pytest.fixture
def instance() -> Iterator[DagsterInstance]:
    with instance_for_test() as persistent:
        yield persistent


def requested(result: object) -> tuple[str, str]:
    assert isinstance(result, RunRequest)
    return result.tags[ASSET_PARTITION_RANGE_START_TAG], result.tags[ASSET_PARTITION_RANGE_END_TAG]


def test_schedule_follows_the_last_archived_hour(instance: DagsterInstance) -> None:
    for key in ("2026-10-29-15:00", "2026-10-29-16:00"):
        instance.report_runless_asset_event(AssetMaterialization(flash_archive.key, partition=key))
    context = build_schedule_context(instance=instance, scheduled_execution_time=NOW)
    assert requested(flash_archive_schedule(context)) == ("2026-10-29-15:00", "2026-10-29-17:00")


def test_schedule_waits_for_the_running_archive(instance: DagsterInstance) -> None:
    create_run_for_test(
        instance, job_name=hourly_flash_archive.name, status=DagsterRunStatus.STARTED
    )
    context = build_schedule_context(instance=instance, scheduled_execution_time=NOW)
    assert isinstance(flash_archive_schedule(context), SkipReason)


def test_repair_rereads_yesterday() -> None:
    tick = datetime(2026, 10, 30, 2, 45, tzinfo=UTC)
    result = flash_archive_repair_schedule(build_schedule_context(scheduled_execution_time=tick))
    assert requested(result) == ("2026-10-29-00:00", "2026-10-29-23:00")


class SqliteLake(LakeResource):
    path: str

    def catalog(self) -> Catalog:
        return SqlCatalog(
            "test", uri=f"sqlite:///{self.path}/catalog.db", warehouse=f"file://{self.path}"
        )


FEED: list[ObjectStore] = []


class MemoryFeed(FeedResource):
    def store(self) -> ObjectStore:
        return FEED[0]


def test_asset_archives_silver_by_hour(tmp_path: Path) -> None:
    lake = SqliteLake(path=str(tmp_path))
    catalog = lake.catalog()
    migrate(catalog)
    rows = [
        {
            "flash_id": f"{i:032x}",
            "source": "mtg-li" if i else "glm-west",
            "product_file": "test.nc",
            "native_flash_id": i,
            "event_time": H0 + timedelta(minutes=10 * i),
            "ingest_time": H0 + timedelta(minutes=10 * i),
            "lat": 45.0,
            "lon": 5.0,
            "energy_raw": 1.0,
            "energy_unit": "J",
            "intensity": 0.5,
            "area_km2": 100.0,
            "duration_ms": 200.0,
            "quality": ["overlap"],
            "parser_version": "test",
            "calibration_version": "test",
        }
        for i in range(8)
    ]
    table = catalog.load_table(FLASHES.identifier)
    table.append(pa.Table.from_pylist(rows, schema=table.schema().as_arrow()))
    FEED[:] = [MemoryStore()]
    result = materialize(
        [flash_archive],
        partition_key="2026-10-15-18:00",
        resources={"lake": lake, "feed_bucket": MemoryFeed()},
    )
    assert result.success
    feed = FEED[0]
    manifest = json.loads(bytes(obstore.get(feed, day_path(H0.date())).bytes()))
    assert [h["flash_count"] for h in manifest["hours"]] == [6]
    chunk = manifest["hours"][0]["chunks"][0]
    body = bytes(obstore.get(feed, PREFIX + chunk["path"].removeprefix("../")).bytes())
    decoded = decode(gzip.decompress(body))
    assert list(decoded.columns["source"]) == [1, 2, 2, 2, 2, 2]
