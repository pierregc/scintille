import asyncio
import contextlib
import gzip
import hashlib
from datetime import UTC, datetime, timedelta

import numpy as np
import polars as pl
import pytest
from scintille_contract.chunk import decode
from scintille_contract.models import LiveManifest
from scintille_ingest.glm.parse import FLASH_SCHEMA
from scintille_ingest.intensity import provisional_intensity
from scintille_ingest.runtime.live_feed import (
    CHUNK_HEADERS,
    MANIFEST_HEADERS,
    LiveFeed,
    source_state,
)

T0 = datetime(2026, 7, 15, 18, 0, tzinfo=UTC)


class FakeStore:
    """In-memory store that can fail on demand and checks the manifest after every write."""

    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, dict[str, str]]] = {}
        self.fail: set[str] = set()

    async def put(self, path: str, data: bytes, headers: dict[str, str]) -> None:
        if any(path.startswith(prefix) for prefix in self.fail):
            raise ConnectionError(f"put {path}")
        self.objects[path] = (data, headers)
        self.check()

    async def get(self, path: str) -> bytes | None:
        item = self.objects.get(path)
        return item[0] if item else None

    async def delete(self, path: str) -> None:
        self.objects.pop(path, None)
        self.check()

    def manifest(self) -> LiveManifest | None:
        data = self.objects.get("manifest.json")
        return LiveManifest.model_validate_json(data[0]) if data else None

    def check(self) -> None:
        manifest = self.manifest()
        if manifest:
            missing = [c.path for c in manifest.chunks if c.path not in self.objects]
            assert not missing, f"manifest references missing chunks {missing}"


def flashes(source: str, at: datetime, n: int, tag: str = "") -> pl.DataFrame:
    rows = [
        {
            "flash_id": hashlib.sha256(f"{source}{at}{tag}{i}".encode()).hexdigest()[:32],
            "source": source,
            "product_file": "f.nc",
            "native_flash_id": i,
            "event_time": at + timedelta(milliseconds=100 * i),
            "ingest_time": at,
            "lat": 10.0 + i,
            "lon": -60.0,
            "energy_raw": 2e-14,
            "energy_unit": "J",
            "intensity": None,
            "area_km2": 150.0,
            "duration_ms": 250.0,
            "quality": ["overlap"] if i == 0 else [],
        }
        for i in range(n)
    ]
    return pl.DataFrame(rows, schema=FLASH_SCHEMA)


class Clock:
    def __init__(self) -> None:
        self.now = T0

    def __call__(self) -> datetime:
        return self.now


def test_publishes_chunks_then_the_manifest() -> None:
    store, clock = FakeStore(), Clock()
    feed = LiveFeed(store, clock=clock)

    async def scenario() -> None:
        for step in range(4):
            await feed.publish(
                "glm-east", flashes("glm-east", clock.now - timedelta(seconds=40), 3, str(step))
            )
            clock.now += timedelta(seconds=30)
            await feed.flush()

    asyncio.run(scenario())
    manifest = store.manifest()
    assert manifest is not None
    assert len(manifest.chunks) == 4
    assert all(a.end == b.start for a, b in zip(manifest.chunks, manifest.chunks[1:], strict=False))
    first = manifest.chunks[0]
    data, headers = store.objects[first.path]
    assert headers == CHUNK_HEADERS
    assert store.objects["manifest.json"][1] == MANIFEST_HEADERS
    chunk = decode(gzip.decompress(data))
    assert chunk.count == first.flash_count == 3
    assert chunk.columns["event_offset_ms"][0] == pytest.approx(-40_000 + 0, abs=1)
    assert chunk.columns["quality"].tolist() == [4, 0, 0]
    assert manifest.sources[0].state == "live"


def test_manifest_never_references_a_missing_chunk() -> None:
    store, clock = FakeStore(), Clock()
    feed = LiveFeed(store, clock=clock, window=timedelta(minutes=5))

    async def scenario() -> None:
        for step in range(12):
            store.fail = (
                {"chunks/"} if step in (3, 4) else {"manifest.json"} if step == 6 else set()
            )
            await feed.publish("mtg-li", flashes("mtg-li", clock.now, 2, str(step)))
            clock.now += timedelta(seconds=30)
            with contextlib.suppress(ConnectionError):
                await feed.flush()

    asyncio.run(scenario())
    manifest = store.manifest()
    assert manifest is not None
    # Steps 3 and 4 could not store a chunk: their flashes went out with step 5. Steps 0 and 1 left
    # the 5-minute window and were deleted once the manifest no longer listed them.
    assert [c.flash_count for c in manifest.chunks] == [2, 6, 2, 2, 2, 2, 2, 2]
    assert {p for p in store.objects if p.startswith("chunks/")} == {
        c.path for c in manifest.chunks
    }


def test_republishing_the_same_file_adds_nothing() -> None:
    store, clock = FakeStore(), Clock()
    feed = LiveFeed(store, clock=clock)
    batch = flashes("glm-west", T0, 5)

    async def scenario() -> None:
        await feed.publish("glm-west", batch)
        await feed.publish("glm-west", batch)
        clock.now += timedelta(seconds=30)
        await feed.flush()

    asyncio.run(scenario())
    manifest = store.manifest()
    assert manifest is not None and manifest.chunks[-1].flash_count == 5


def test_restart_continues_the_published_chunk_list() -> None:
    store, clock = FakeStore(), Clock()

    async def run_once(feed: LiveFeed) -> None:
        await feed.restore()
        await feed.publish("glm-east", flashes("glm-east", clock.now, 1, str(clock.now)))
        clock.now += timedelta(seconds=30)
        await feed.flush()

    asyncio.run(run_once(LiveFeed(store, clock=clock)))
    asyncio.run(run_once(LiveFeed(store, clock=clock)))
    manifest = store.manifest()
    assert manifest is not None and len(manifest.chunks) == 2
    assert manifest.chunks[0].end == manifest.chunks[1].start


def test_source_states_age_out() -> None:
    assert source_state(None, T0) == "offline"
    assert source_state(T0 - timedelta(seconds=90), T0) == "live"
    assert source_state(T0 - timedelta(minutes=5), T0) == "delayed"
    assert source_state(T0 - timedelta(minutes=11), T0) == "offline"


def test_provisional_intensity_is_log_scaled_per_unit() -> None:
    frame = pl.DataFrame(
        {
            "energy_raw": [10**-15.5, 10**-13.5, 10**-11.5, 100.0, 0.0],
            "energy_unit": ["J", "J", "J", "mW m-2 sr-1", "J"],
        }
    )
    assert np.allclose(provisional_intensity(frame), [0, 0.5, 1, 0.5, 0])
