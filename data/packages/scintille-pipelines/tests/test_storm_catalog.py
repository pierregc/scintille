import json
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from pathlib import Path
from xml.etree import ElementTree as ET

import numpy as np
import polars as pl
import pytest
from scintille_contract.chunk import decode
from scintille_contract.models import StormDetail, StormSearchRecord, StormSummary
from scintille_pipelines.storm_catalog import (
    DETAIL_MAX_BYTES,
    PUBLISHED_PATH,
    PURGE_PATH,
    XMLNS,
    index_pages,
    publish_catalog,
    replay_chunks,
    selected_flashes,
    sitemaps,
)
from scintille_pipelines.storm_publication import (
    BOOTSTRAP_STORMS,
    FLASH_WINDOW,
    PUBLISHED_MIN_LEVEL,
    export_candidates,
    flash_windows,
    publishable,
    storm_catalog_schedule,
)
from scintille_pipelines.storm_search import publish_search, search_records, selector_key, words

ROOT = Path(__file__).parents[4]
NOW = datetime(2026, 7, 15, 20, tzinfo=UTC)


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


@pytest.mark.parametrize("after", range(12))
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


def test_recent_first_stable_pages() -> None:
    base = detail().storm
    storms = [
        base.model_copy(update={"storm_id": f"{n:03}", "slug": f"storm-{n}"}) for n in range(101)
    ]
    pages = index_pages(storms, NOW)
    assert [len(page.storms) for page in pages] == [50, 50, 1]
    assert pages[0].storms[0].storm_id == "100"
    assert len({s.slug for p in pages for s in p.storms}) == 101


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


def test_schedule_targets_latest_closed_hour() -> None:
    from dagster import RunRequest, build_schedule_context

    request = storm_catalog_schedule(build_schedule_context(scheduled_execution_time=NOW))
    assert isinstance(request, RunRequest)
    assert request.partition_key == "2026-07-15-19:00"


def records(count: int = 140) -> list[StormSearchRecord]:
    storm = detail().storm
    summaries = [
        storm.model_copy(
            update={
                "slug": f"storm-{i}",
                "storm_id": str(i),
                "t_start": storm.t_start - timedelta(days=i),
            }
        )
        for i in range(count)
    ]
    names = pl.DataFrame(
        {
            "storm_id": [str(i) for i in range(count)],
            "lat": [10.0] * count,
            "lon": [179.0] * count,
            "country_name": ["France"] * count,
        }
    )
    return search_records(summaries, names)


def test_shared_normalization() -> None:
    for case in json.loads((ROOT / "fixtures/storms/search/normalization.json").read_text()):
        assert words(case["input"]) == case["words"]


def test_postings_are_complete_bounded_and_deterministic() -> None:
    store = Store()
    result = publish_search(store, records(), NOW)
    pointer = json.loads(store.files["storms/search/latest.json"])
    generation = pointer["generation"]
    prefix = f"storms/search/{generation}/lists/{selector_key('all')}"
    meta = json.loads(store.files[f"{prefix}/meta.json"])
    found: list[str] = []
    for i in range(meta["page_count"]):
        body = store.files[f"{prefix}/{i}.json"]
        assert len(body) <= 65536
        page = json.loads(body)["storms"]
        assert len(page) <= 64
        found.extend(r["slug"] for r in page)
    assert len(found) == len(set(found)) == 140
    manifest = store.files[f"storms/search/{generation}/manifest.json"]
    publish_search(store, list(reversed(records())), NOW + timedelta(hours=1))
    assert json.loads(store.files["storms/search/latest.json"])["generation"] == generation
    assert store.files[f"storms/search/{generation}/manifest.json"] == manifest
    assert result["search_records"] == 140
    assert result["search_unassigned"] == 0


def test_incomplete_naming_fails_instead_of_omitting_records() -> None:
    with pytest.raises(ValueError, match="unresolved"):
        search_records([detail().storm], pl.DataFrame({"storm_id": [], "lat": [], "lon": []}))


def test_duplicate_and_oversized_records_preserve_pointer() -> None:
    store = Store()
    publish_search(store, records(1), NOW)
    pointer = store.files["storms/search/latest.json"]
    with pytest.raises(ValueError, match="duplicate"):
        publish_search(store, records(2) * 2, NOW)
    oversized = records(1)[0].model_copy(update={"words": ["x" * 256] * 100})
    with pytest.raises(ValueError, match="oversized"):
        publish_search(store, [oversized], NOW)
    assert store.files["storms/search/latest.json"] == pointer
    with pytest.raises(ValueError, match="backwards"):
        publish_search(store, records(1), NOW - timedelta(hours=1))


def test_interrupted_generation_never_replaces_pointer() -> None:
    baseline = Store()
    publish_search(baseline, records(1), NOW)
    pointer = baseline.files["storms/search/latest.json"]
    for after in range(15):
        store = Store(after)
        store.files = baseline.files.copy()
        with pytest.raises(OSError):
            publish_search(store, records(2), NOW + timedelta(hours=1))
        assert store.files["storms/search/latest.json"] == pointer


def test_effective_snapshot_retains_previous_summary() -> None:
    store, document = Store(), detail()
    publish_catalog(store, [document], chunks(document), [document.storm], NOW, lambda _: True)
    oversized = document.model_copy(
        update={
            "storm": document.storm.model_copy(
                update={"label": "x" * DETAIL_MAX_BYTES, "flashes": 999}
            )
        }
    )
    snapshots: list[StormSummary] = []
    publish_catalog(
        store,
        [oversized],
        {},
        [oversized.storm],
        NOW,
        lambda _: True,
        on_snapshot=lambda storms: snapshots.extend(storms),
    )
    assert snapshots == [document.storm]


def test_previous_minor_publication_remains_readable() -> None:
    from scintille_contract.models import SCHEMA_VERSION
    from scintille_pipelines.storm_catalog import read_published_detail

    body = detail().model_dump_json().replace(SCHEMA_VERSION, "2.4.0").encode()
    assert read_published_detail(body).storm == detail().storm
    with pytest.raises(ValueError, match="unsupported"):
        read_published_detail(body.replace(b"2.4.0", b"1.4.0"))
