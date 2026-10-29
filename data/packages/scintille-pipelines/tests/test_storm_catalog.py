import json
from collections.abc import Iterator, Sequence
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from pathlib import Path
from xml.etree import ElementTree as ET

import numpy as np
import polars as pl
import pytest
from dagster import (
    AssetMaterialization,
    DagsterInstance,
    DagsterRunStatus,
    RunRequest,
    SkipReason,
    build_schedule_context,
)
from dagster._core.storage.tags import (
    ASSET_PARTITION_RANGE_END_TAG,
    ASSET_PARTITION_RANGE_START_TAG,
)
from dagster._core.test_utils import create_run_for_test, instance_for_test
from scintille_contract.chunk import decode
from scintille_contract.models import (
    SCHEMA_VERSION,
    StormDetail,
    StormHighlight,
    StormHighlights,
    StormSummary,
)
from scintille_pipelines.definitions import defs
from scintille_pipelines.storm_catalog import (
    DETAIL_MAX_BYTES,
    HIGHLIGHTS_PATH,
    LATEST_INDEX_PATH,
    PUBLISHED_PATH,
    PURGE_PATH,
    XMLNS,
    index_pages,
    publish_catalog,
    read_detail,
    replay_chunks,
    selected_flashes,
    sitemaps,
)
from scintille_pipelines.storm_cells import BACKFILL
from scintille_pipelines.storm_publication import (
    BOOTSTRAP_STORMS,
    FLASH_WINDOW,
    PUBLISHED_MIN_LEVEL,
    export_candidates,
    flash_windows,
    publishable,
    storm_catalog,
    storm_catalog_schedule,
)

ROOT = Path(__file__).parents[4]
NOW = datetime(2026, 7, 15, 20, tzinfo=UTC)
CATALOG = storm_catalog.key


def detail() -> StormDetail:
    return StormDetail.model_validate_json(
        (ROOT / "fixtures/storms/2026-07-15-orlando.json").read_bytes()
    )


class Store:
    def __init__(self, fail_after: int | None = None) -> None:
        self.files: dict[str, bytes] = {}
        self.writes = 0
        self.fail_after = fail_after

    def put(self, path: str, data: bytes, headers: dict[str, str]) -> None:
        if self.writes == self.fail_after:
            raise OSError("interrupted")
        self.writes += 1
        self.files[path] = data

    def get(self, path: str) -> bytes | None:
        return self.files.get(path)

    def exists(self, path: str) -> bool:
        return path in self.files


def chunks(document: StormDetail) -> dict[str, bytes]:
    return {ref.path: (ROOT / "fixtures" / ref.path).read_bytes() for ref in document.replay.chunks}


@pytest.mark.parametrize("after", range(14))
def test_interruption_keeps_references_valid(after: int) -> None:
    store, document = Store(after), detail()
    with suppress(OSError):
        publish_catalog(store, [document], chunks(document), [document.storm], NOW, lambda _: True)
    for path, body in store.files.items():
        if path.startswith("storms/index/"):
            for summary in json.loads(body)["storms"]:
                assert f"storms/{summary['slug']}.json" in store.files
        elif path.startswith("sitemaps/"):
            for element in ET.fromstring(body).iter(f"{{{XMLNS}}}loc"):
                assert element.text is not None
                suffix = element.text.removeprefix("https://scintille.app/")
                if suffix.startswith("storms/"):
                    assert f"{suffix}.json" in store.files
                elif suffix.startswith("sitemaps/"):
                    assert suffix in store.files
        elif path.endswith(".json") and path.startswith("storms/"):
            for ref in json.loads(body)["replay"]["chunks"]:
                assert ref["path"] in store.files


def test_idempotent_details_and_retryable_purge() -> None:
    store, document = Store(), detail()
    publish_catalog(store, [document], chunks(document), [document.storm], NOW, lambda _: True)
    original = store.get(f"storms/{document.storm.slug}.json")
    rerun = document.model_copy(update={"published_at": NOW})
    result = publish_catalog(
        store, [rerun], chunks(document), [document.storm], NOW, lambda _: True
    )
    assert result["changed"] == 0
    assert store.get(f"storms/{document.storm.slug}.json") == original
    changed = document.model_copy(
        update={"storm": document.storm.model_copy(update={"flashes": 4})}
    )
    calls: list[list[str]] = []

    def failed(tags: list[str]) -> bool:
        calls.append(tags)
        raise OSError("purge unavailable")

    result = publish_catalog(store, [changed], chunks(document), [changed.storm], NOW, failed)
    assert result["pending_purge_tags"] == 3
    assert calls == [["region:US", f"storm:{document.storm.slug}", "storms-index"]]
    publish_catalog(store, [changed], chunks(document), [changed.storm], NOW, lambda _: True)
    assert json.loads(store.get(PURGE_PATH) or b"[]") == []


def test_highlights_follow_the_effective_snapshot_and_keep_the_previous_file() -> None:
    store, document = Store(), detail()
    seen: list[list[str]] = []

    def pick(storms: Sequence[StormSummary]) -> StormHighlights:
        seen.append([storm.slug for storm in storms])
        return StormHighlights(
            schema_version=SCHEMA_VERSION,
            published_at=NOW,
            last_observation_time=None,
            highlights=[StormHighlight(kind="day", area=None, storm=storms[0])],
        )

    result = publish_catalog(
        store, [document], chunks(document), [document.storm], NOW, lambda _: True, highlights=pick
    )
    assert seen == [[document.storm.slug]] and result["highlights"] == 1
    written = store.get(HIGHLIGHTS_PATH)
    publish_catalog(
        store,
        [document],
        chunks(document),
        [document.storm],
        NOW,
        lambda _: True,
        highlights=lambda _: None,
    )
    assert store.get(HIGHLIGHTS_PATH) == written


def test_details_published_by_an_earlier_minor_version_are_still_read() -> None:
    store, document = Store(), detail()
    path = f"storms/{document.storm.slug}.json"
    older = json.loads(document.model_dump_json()) | {"schema_version": "2.4.0"}
    store.files[path] = json.dumps(older).encode()
    store.files[PUBLISHED_PATH] = json.dumps([document.storm.slug]).encode()
    assert read_detail(store.files[path]).storm == document.storm
    changed = document.model_copy(
        update={"storm": document.storm.model_copy(update={"flashes": 4})}
    )
    result = publish_catalog(
        store, [changed], chunks(document), [changed.storm], NOW, lambda _: True
    )
    assert result["changed"] == 1
    assert StormDetail.model_validate_json(store.files[path]).storm.flashes == 4
    with pytest.raises(ValueError, match="unsupported"):
        read_detail(json.dumps(older | {"schema_version": "1.9.0"}).encode())


def test_missing_references_abort_before_writes() -> None:
    store, document = Store(), detail()
    with pytest.raises(ValueError, match="missing replay"):
        publish_catalog(store, [document], {}, [document.storm], NOW, lambda _: True)
    assert not store.files


def test_oversized_storm_does_not_block_new_storm(caplog: pytest.LogCaptureFixture) -> None:
    store, document = Store(), detail()
    oversized = document.model_copy(
        update={"storm": document.storm.model_copy(update={"label": "x" * DETAIL_MAX_BYTES})}
    )
    fresh = document.model_copy(
        update={"storm": document.storm.model_copy(update={"slug": "new-storm", "storm_id": "new"})}
    )
    result = publish_catalog(
        store,
        [oversized, fresh],
        chunks(document),
        [oversized.storm, fresh.storm],
        NOW,
        lambda _: True,
    )
    assert result["skipped_storms"] == 1
    assert "Skipping oversized" in caplog.text
    assert store.get(f"storms/{oversized.storm.slug}.json") is None
    assert json.loads(store.files[PUBLISHED_PATH]) == [fresh.storm.slug]
    assert [s["slug"] for s in json.loads(store.files["storms/index/0.json"])["storms"]] == [
        fresh.storm.slug
    ]
    assert oversized.storm.slug.encode() not in store.files["sitemaps/pages-0.xml"]


def test_oversized_update_keeps_previous_detail_and_index() -> None:
    store, document = Store(), detail()
    publish_catalog(store, [document], chunks(document), [document.storm], NOW, lambda _: True)
    original = store.files[f"storms/{document.storm.slug}.json"]
    oversized = document.model_copy(
        update={"storm": document.storm.model_copy(update={"label": "x" * DETAIL_MAX_BYTES})}
    )
    publish_catalog(store, [oversized], chunks(document), [oversized.storm], NOW, lambda _: True)
    assert store.files[f"storms/{document.storm.slug}.json"] == original
    assert (
        json.loads(store.files["storms/index/0.json"])["storms"][0]["label"] == document.storm.label
    )


def test_bootstrap_is_bounded_but_current_storms_are_always_selected() -> None:
    base = detail().storm
    storms = [
        base.model_copy(update={"storm_id": str(n), "slug": f"storm-{n}"})
        for n in range(BOOTSTRAP_STORMS + 20)
    ]
    touched = {storms[-1].storm_id}
    candidates = export_candidates(storms, {storms[0].slug}, touched)
    assert len(candidates) == BOOTSTRAP_STORMS + 1
    assert touched <= candidates
    assert storms[0].storm_id not in candidates


def test_track_steps_share_bounded_flash_scans() -> None:
    hour = timedelta(hours=1)
    steps = [(NOW + n * hour, NOW + (n + 1.5) * hour) for n in (0, 1, 3, 4, 5, 9)]
    groups = flash_windows(steps)
    assert [members for _, members in groups] == [[0, 1, 2, 3], [4, 5]]
    for (start, end), members in groups:
        assert end - start <= FLASH_WINDOW
        assert all(start <= steps[m][0] and steps[m][1] <= end for m in members)
    assert flash_windows([]) == []


def test_only_strong_storms_are_published() -> None:
    base = detail().storm
    storms = [
        base.model_copy(update={"storm_id": str(level), "slug": f"storm-{level}", "level": level})
        for level in range(1, 6)
    ]
    assert [s.level for s in publishable(storms)] == list(range(PUBLISHED_MIN_LEVEL, 6))


def test_regions_use_existence_checks_without_downloading_bodies() -> None:
    class HeadStore(Store):
        def get(self, path: str) -> bytes | None:
            assert not path.startswith("regions/")
            return super().get(path)

    store = HeadStore()
    store.files["regions/FR.json"] = b"{}"
    publish_catalog(store, [], {}, [], NOW, lambda _: True, ["FR", "US"])
    body = store.files["sitemaps/pages-0.xml"]
    assert b"https://scintille.app/live/fr" in body
    assert b"https://scintille.app/live/us" not in body


def test_purge_programming_errors_are_not_hidden() -> None:
    store, document = Store(), detail()
    publish_catalog(store, [document], chunks(document), [document.storm], NOW, lambda _: True)
    changed = document.model_copy(
        update={"storm": document.storm.model_copy(update={"flashes": 4})}
    )

    def broken(tags: list[str]) -> bool:
        raise TypeError("incorrect callback")

    with pytest.raises(TypeError, match="incorrect callback"):
        publish_catalog(store, [changed], chunks(document), [changed.storm], NOW, broken)
    assert json.loads(store.files[PURGE_PATH])


def test_hourly_job_materializes_classification_before_publication() -> None:
    from dagster import AssetKey
    from scintille_pipelines.definitions import defs

    job = defs.get_repository_def().get_job("hourly_storm_catalog")
    assert AssetKey(["gold", "storm_levels"]) in job.asset_layer.executable_asset_keys
    assert AssetKey(["feeds", "storm_catalog"]) in job.asset_layer.executable_asset_keys


def numbered(count: int, start: int = 0) -> list[StormSummary]:
    base = detail().storm
    return [
        base.model_copy(
            update={
                "storm_id": f"{n:03}",
                "slug": f"storm-{n}",
                "t_start": base.t_start + timedelta(minutes=n),
            }
        )
        for n in range(start, start + count)
    ]


def test_pages_count_from_the_oldest_storm_and_list_recent_first() -> None:
    pages = index_pages(numbered(101), NOW)
    assert [len(page.storms) for page in pages] == [50, 50, 1]
    assert [page.storms[0].storm_id for page in pages] == ["049", "099", "100"]
    assert len({s.slug for p in pages for s in p.storms}) == 101


def test_only_changed_index_pages_are_rewritten() -> None:
    store, document = Store(), detail()
    storms = numbered(120)
    store.files[PUBLISHED_PATH] = json.dumps([s.slug for s in storms]).encode()
    first = publish_catalog(store, [], {}, storms, NOW, lambda _: True)
    assert first["index_pages_written"] == 3
    newer = numbered(1, start=200)
    store.files[f"storms/{newer[0].slug}.json"] = document.model_dump_json().encode()
    page_zero = store.files["storms/index/0.json"]
    second = publish_catalog(store, [], {}, storms + newer, NOW, lambda _: True)
    assert second["index_pages_written"] == 1
    assert store.files["storms/index/0.json"] == page_zero
    latest = json.loads(store.files[LATEST_INDEX_PATH])
    assert latest["page"] == 2 and latest["total_pages"] == 3
    assert latest["storms"][0]["slug"] == newer[0].slug
    older = numbered(1, start=-200)
    store.files[f"storms/{older[0].slug}.json"] = document.model_dump_json().encode()
    third = publish_catalog(store, [], {}, storms + newer + older, NOW, lambda _: True)
    assert third["index_pages_written"] == 3


def test_published_replay_chunks_are_not_sent_again() -> None:
    store, document = Store(), detail()
    publish_catalog(store, [document], chunks(document), [document.storm], NOW, lambda _: True)
    store.files = {k: v for k, v in store.files.items() if not k.startswith("storms/chunks/")}
    changed = document.model_copy(
        update={"storm": document.storm.model_copy(update={"flashes": 4})}
    )
    publish_catalog(store, [changed], chunks(document), [changed.storm], NOW, lambda _: True)
    assert not any(path.startswith("storms/chunks/") for path in store.files)


def test_sitemap_splits_and_metadata(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("scintille_pipelines.storm_catalog.SITEMAP_URLS", 2)
    base = detail().storm
    maps = sitemaps([base.model_copy(update={"slug": f"storm-{n}"}) for n in range(5)], NOW)
    assert len(maps) == 4
    assert all(b"published_at=" in body and b"schema_version=" in body for body in maps.values())
    assert len(list(ET.fromstring(maps["sitemaps/pages-0.xml"]))) == 2


def test_track_bounds_cross_antimeridian_without_double_counting() -> None:
    flashes = pl.DataFrame(
        {
            "flash_id": ["a", "b", "c"],
            "event_time": [NOW] * 3,
            "lat": [0.0] * 3,
            "lon": [179.0, -179.0, 0.0],
        }
    )
    step = dict(
        window_start=NOW,
        window_end=NOW + timedelta(hours=1),
        west=178.0,
        east=-178.0,
        south=-1.0,
        north=1.0,
    )
    selected = selected_flashes(flashes, pl.DataFrame([step, step]))
    assert set(selected["flash_id"]) == {"a", "b"}


def test_chunks_preserve_event_time_and_partition_hours() -> None:
    import gzip

    flashes = pl.DataFrame(
        {
            "flash_id": ["a", "b"],
            "event_time": [NOW, NOW + timedelta(days=30)],
            "lat": [0.0, 1.0],
            "lon": [2.0, 3.0],
            "source": ["glm-east"] * 2,
            "quality": [[], []],
            "intensity": [0.4, 0.8],
            "area_km2": [1.0, 2.0],
            "duration_ms": [10.0, 20.0],
        }
    )
    replay, objects = replay_chunks(flashes)
    assert len(replay.chunks) == 2
    for ref in replay.chunks:
        decoded = decode(gzip.decompress(objects[ref.path]))
        assert decoded.start == ref.start
        assert np.array_equal(decoded.columns["event_offset_ms"], [0])
    assert replay.selection == "track-bounds"


def tick(instance: DagsterInstance, published: Sequence[str] = ()) -> RunRequest | SkipReason:
    for key in published:
        instance.report_runless_asset_event(AssetMaterialization(CATALOG, partition=key))
    context = build_schedule_context(instance=instance, scheduled_execution_time=NOW)
    result = storm_catalog_schedule(context)
    assert isinstance(result, RunRequest | SkipReason)
    return result


def requested_range(result: RunRequest | SkipReason) -> tuple[str, str]:
    assert isinstance(result, RunRequest)
    return result.tags[ASSET_PARTITION_RANGE_START_TAG], result.tags[ASSET_PARTITION_RANGE_END_TAG]


@pytest.fixture
def instance() -> Iterator[DagsterInstance]:
    with instance_for_test() as persistent:
        yield persistent


def test_schedule_targets_latest_closed_hour(instance: DagsterInstance) -> None:
    result = tick(instance, ["2026-07-15-17:00", "2026-07-15-18:00"])
    assert requested_range(result) == ("2026-07-15-19:00", "2026-07-15-19:00")


def test_schedule_catches_up_missed_hours_six_at_a_time(instance: DagsterInstance) -> None:
    result = tick(instance, ["2026-07-15-09:00", "2026-07-15-10:00"])
    assert requested_range(result) == ("2026-07-15-11:00", "2026-07-15-16:00")


def test_schedule_skips_when_never_started(instance: DagsterInstance) -> None:
    assert isinstance(tick(instance), SkipReason)


def test_schedule_skips_when_up_to_date(instance: DagsterInstance) -> None:
    assert isinstance(tick(instance, ["2026-07-15-19:00"]), SkipReason)


def test_schedule_waits_for_a_catalog_run_in_progress(instance: DagsterInstance) -> None:
    create_run_for_test(instance, job_name="daily_gold", status=DagsterRunStatus.STARTED)
    assert isinstance(tick(instance, ["2026-07-15-10:00"]), RunRequest)
    create_run_for_test(instance, job_name="hourly_storm_catalog", status=DagsterRunStatus.STARTED)
    assert isinstance(tick(instance), SkipReason)


def test_catalog_job_retries_and_has_a_runtime_limit() -> None:
    job = defs.get_job_def("hourly_storm_catalog")
    assert job.run_tags["dagster/max_runtime"] == "3600"
    assert job.op_retry_policy is not None and job.op_retry_policy.max_retries == 3
    keys = job.asset_layer.executable_asset_keys
    assert {job.asset_layer.get(key).assets_def.backfill_policy for key in keys} == {BACKFILL}
