import asyncio
import contextlib
import gzip
import hashlib
from datetime import UTC, datetime, timedelta
from pathlib import Path

import polars as pl
import pytest
from scintille_contract import coverage
from scintille_contract.chunk import decode
from scintille_contract.models import CoverageMap, LiveManifest
from scintille_ingest.glm.ingest import IngestedFile
from scintille_ingest.glm.parse import FLASH_SCHEMA
from scintille_ingest.ingest_log import IngestLogRecord
from scintille_ingest.runtime.live_feed import (
    CHUNK_HEADERS,
    COVERAGE_HEADERS,
    MANIFEST_HEADERS,
    PRODUCT_CADENCE,
    LiveFeed,
    StateDelays,
    source_state,
)
from scintille_ingest.runtime.service import Crash, IngestLive
from scintille_ingest.runtime.sources import Product
from scintille_ingest.runtime.spool import Spool
from scintille_ingest.runtime.state import MemoryState

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


def test_publishes_chunks_then_the_manifest(tmp_path: Path) -> None:
    store, clock = FakeStore(), Clock()
    feed = LiveFeed(store, outbox=tmp_path, clock=clock)

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


def test_manifest_never_references_a_missing_chunk(tmp_path: Path) -> None:
    store, clock = FakeStore(), Clock()
    feed = LiveFeed(store, outbox=tmp_path, clock=clock, window=timedelta(minutes=5))

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


def test_republishing_the_same_file_adds_nothing(tmp_path: Path) -> None:
    store, clock = FakeStore(), Clock()
    feed = LiveFeed(store, outbox=tmp_path, clock=clock)
    batch = flashes("glm-west", T0, 5)

    async def scenario() -> None:
        await feed.publish("glm-west", batch)
        await feed.publish("glm-west", batch)
        clock.now += timedelta(seconds=30)
        await feed.flush()

    asyncio.run(scenario())
    manifest = store.manifest()
    assert manifest is not None and manifest.chunks[-1].flash_count == 5


def test_restart_continues_the_published_chunk_list(tmp_path: Path) -> None:
    store, clock = FakeStore(), Clock()

    async def run_once(feed: LiveFeed) -> None:
        await feed.restore()
        await feed.publish("glm-east", flashes("glm-east", clock.now, 1, str(clock.now)))
        clock.now += timedelta(seconds=30)
        await feed.flush()

    asyncio.run(run_once(LiveFeed(store, outbox=tmp_path, clock=clock)))
    asyncio.run(run_once(LiveFeed(store, outbox=tmp_path, clock=clock)))
    manifest = store.manifest()
    assert manifest is not None and len(manifest.chunks) == 2
    assert manifest.chunks[0].end == manifest.chunks[1].start


def counts(store: FakeStore) -> list[int]:
    manifest = store.manifest()
    return [c.flash_count for c in manifest.chunks] if manifest else []


class PausingStore(FakeStore):
    """Holds the first chunk upload until `release` is set."""

    def __init__(self) -> None:
        super().__init__()
        self.uploading = asyncio.Event()
        self.release = asyncio.Event()

    async def put(self, path: str, data: bytes, headers: dict[str, str]) -> None:
        if path.startswith("chunks/") and not self.release.is_set():
            self.uploading.set()
            await self.release.wait()
        await super().put(path, data, headers)


def test_flashes_arriving_during_a_chunk_upload_go_in_the_next_chunk(tmp_path: Path) -> None:
    store, clock = PausingStore(), Clock()
    feed = LiveFeed(store, outbox=tmp_path, clock=clock)

    async def scenario() -> None:
        await feed.publish("glm-east", flashes("glm-east", T0, 1, "a"))
        clock.now += timedelta(seconds=30)
        flushing = asyncio.create_task(feed.flush())
        await store.uploading.wait()
        await feed.publish("glm-east", flashes("glm-east", T0, 1, "b"))
        store.release.set()
        await flushing
        clock.now += timedelta(seconds=30)
        await feed.flush()

    asyncio.run(scenario())
    assert counts(store) == [1, 1]


def test_flashes_of_a_failed_upload_survive_a_restart(tmp_path: Path) -> None:
    store, clock = FakeStore(), Clock()

    async def first_run() -> None:
        feed = LiveFeed(store, outbox=tmp_path, clock=clock)
        await feed.publish("glm-east", flashes("glm-east", T0, 3))
        clock.now += timedelta(seconds=30)
        store.fail = {"chunks/"}
        with pytest.raises(ConnectionError):
            await feed.flush()

    async def second_run() -> None:
        store.fail = set()
        feed = LiveFeed(store, outbox=tmp_path, clock=clock)
        await feed.restore()
        await feed.publish("glm-east", flashes("glm-east", T0, 3))
        clock.now += timedelta(seconds=30)
        await feed.flush()

    asyncio.run(first_run())
    asyncio.run(second_run())
    assert counts(store) == [3]


@pytest.mark.parametrize("failing", ["manifest", "ack"])
def test_restart_after_a_partial_flush_publishes_each_flash_once(
    tmp_path: Path, failing: str
) -> None:
    store, clock = FakeStore(), Clock()
    batch = flashes("mtg-li", T0, 4)

    async def first_run() -> None:
        feed = LiveFeed(store, outbox=tmp_path, clock=clock)
        await feed.publish("mtg-li", batch)
        clock.now += timedelta(seconds=30)
        if failing == "manifest":
            store.fail = {"manifest.json"}
        else:

            def crash(chunk: str) -> None:
                raise Crash(chunk)

            feed.outbox.ack = crash  # type: ignore[method-assign]
        with pytest.raises((ConnectionError, Crash)):
            await feed.flush()

    async def second_run() -> None:
        store.fail = set()
        feed = LiveFeed(store, outbox=tmp_path, clock=clock)
        await feed.restore()
        await feed.publish("mtg-li", batch)
        clock.now += timedelta(seconds=30)
        await feed.flush()

    asyncio.run(first_run())
    asyncio.run(second_run())
    assert sum(counts(store)) == 4


class FlashSource:
    name = "glm-east"
    cadence = 0.01

    def __init__(self, files: int) -> None:
        self.products = [
            Product(f"glm-east/f{i}.nc", T0 + timedelta(seconds=20 * i)) for i in range(files)
        ]

    async def list_recent(self, now: datetime) -> list[Product]:
        return list(self.products)

    async def fetch(self, product: Product) -> bytes:
        return product.key.encode()

    def parse(self, product: Product, data: bytes, received_at: datetime) -> IngestedFile:
        frame = flashes(self.name, product.start, 5, product.key)
        log = IngestLogRecord(
            key=product.key,
            source="glm-east",
            satellite="G19",
            product_start=product.start,
            product_end=product.start + timedelta(seconds=20),
            received_at=received_at,
            row_count=frame.height,
            checksum="sha256:x",
            status="ok",
            parse_duration_ms=1.0,
            error=None,
        )
        return IngestedFile(frame, log)


def test_ingest_live_restart_before_the_next_chunk_loses_nothing(tmp_path: Path) -> None:
    store, clock, state = FakeStore(), Clock(), MemoryState()
    spool, source = Spool(tmp_path / "spool"), FlashSource(files=11)

    def run_once(flush: bool) -> None:
        feed = LiveFeed(store, outbox=tmp_path / "outbox", clock=clock)
        service = IngestLive([source], state, spool, publisher=feed, clock=clock)

        async def scenario() -> None:
            await feed.restore()
            await service.poll(source)
            if flush:
                clock.now += timedelta(seconds=30)
                await feed.flush()

        asyncio.run(scenario())

    run_once(flush=False)
    assert {r.state for r in state.records.values()} == {"spooled"}
    run_once(flush=True)
    assert sum(counts(store)) == 55


def test_source_states_age_out() -> None:
    assert source_state(None, T0) == "offline"
    assert source_state(T0 - timedelta(seconds=90), T0) == "live"
    assert source_state(T0 - timedelta(minutes=5), T0) == "delayed"
    assert source_state(T0 - timedelta(minutes=11), T0) == "offline"


def test_slow_sources_age_out_after_their_cadence() -> None:
    cadence = PRODUCT_CADENCE["mtg-li"]
    assert source_state(T0 - timedelta(minutes=11), T0, cadence=cadence) == "live"
    assert source_state(T0 - timedelta(minutes=15), T0, cadence=cadence) == "delayed"
    assert source_state(T0 - timedelta(minutes=21), T0, cadence=cadence) == "offline"


def test_state_delays_are_configurable() -> None:
    delays = StateDelays.from_env(
        {"SCINTILLE_SOURCE_DELAYED_AFTER": "30", "SCINTILLE_SOURCE_OFFLINE_AFTER": "90"}
    )
    assert delays == StateDelays(timedelta(seconds=30), timedelta(seconds=90))
    assert StateDelays.from_env({}) == StateDelays()
    assert source_state(T0 - timedelta(seconds=60), T0, delays) == "delayed"
    assert source_state(T0 - timedelta(seconds=91), T0, delays) == "offline"
    with pytest.raises(ValueError, match="delayed_after"):
        StateDelays(timedelta(minutes=5), timedelta(minutes=1))


def test_a_silent_source_turns_offline_after_the_configured_delay(tmp_path: Path) -> None:
    store, clock = FakeStore(), Clock()
    delays = StateDelays(timedelta(seconds=60), timedelta(seconds=120))
    feed = LiveFeed(store, outbox=tmp_path, clock=clock, delays=delays)
    states: list[tuple[str, str]] = []

    async def scenario() -> None:
        for step in range(6):
            await feed.publish("glm-east", flashes("glm-east", clock.now, 2, str(step)))
            if step == 0:
                await feed.publish("glm-west", flashes("glm-west", clock.now, 2))
            clock.now += timedelta(seconds=30)
            await feed.flush()
            manifest = store.manifest()
            assert manifest is not None
            by_source = {s.source: s.state for s in manifest.sources}
            states.append((by_source["glm-east"], by_source["glm-west"]))

    asyncio.run(scenario())
    assert [west for _, west in states] == [
        "live",
        "live",
        "delayed",
        "delayed",
        "offline",
        "offline",
    ]
    assert {east for east, _ in states} == {"live"}


def test_publishes_the_coverage_map_once(tmp_path: Path) -> None:
    store, clock = FakeStore(), Clock()
    store.fail.add("coverage")
    feed = LiveFeed(store, outbox=tmp_path, clock=clock)

    async def flush() -> None:
        clock.now += timedelta(seconds=30)
        await feed.flush()

    asyncio.run(flush())
    assert "coverage.geojson" not in store.objects
    assert store.manifest() is not None
    assert feed.metrics.counters[("live_feed_errors_total", ())] == 1
    store.fail.clear()
    asyncio.run(flush())
    data, headers = store.objects["coverage.geojson"]
    assert headers == COVERAGE_HEADERS
    assert CoverageMap.model_validate_json(data).model_dump(mode="json") == coverage.geojson()
    store.objects["coverage.geojson"] = (b"stale", {})
    asyncio.run(flush())
    assert store.objects["coverage.geojson"][0] == b"stale"
    asyncio.run(LiveFeed(store, outbox=tmp_path, clock=clock).publish_coverage())
    assert store.objects["coverage.geojson"][0] == data
