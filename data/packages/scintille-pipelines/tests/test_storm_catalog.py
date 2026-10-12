import json
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from pathlib import Path
from xml.etree import ElementTree as ET

import numpy as np
import polars as pl
import pytest
from scintille_contract.chunk import decode
from scintille_contract.models import StormDetail
from scintille_pipelines.storm_catalog import (
    DETAIL_MAX_BYTES,
    PURGE_PATH,
    XMLNS,
    index_pages,
    publish_catalog,
    replay_chunks,
    selected_flashes,
    sitemaps,
)
from scintille_pipelines.storm_publication import storm_catalog_schedule

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


def test_missing_references_and_oversize_abort_before_writes() -> None:
    store, document = Store(), detail()
    with pytest.raises(ValueError, match="missing replay"):
        publish_catalog(store, [document], {}, [document.storm], NOW, lambda _: True)
    assert not store.files
    oversized = document.model_copy(
        update={"storm": document.storm.model_copy(update={"label": "x" * DETAIL_MAX_BYTES})}
    )
    with pytest.raises(ValueError, match="256 KiB"):
        publish_catalog(
            store, [oversized], chunks(document), [oversized.storm], NOW, lambda _: True
        )
    assert not store.files


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
    assert len(list(ET.fromstring(maps["sitemaps/storms-0.xml"]))) == 2


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
