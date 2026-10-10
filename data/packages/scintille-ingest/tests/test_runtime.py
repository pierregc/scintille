import asyncio
import hashlib
from datetime import UTC, datetime, timedelta
from pathlib import Path

import obstore
import polars as pl
import pytest
from obstore.store import MemoryStore
from scintille_ingest.glm.ingest import IngestedFile
from scintille_ingest.ingest_log import IngestLogRecord
from scintille_ingest.runtime import health
from scintille_ingest.runtime.identity import FileIdentity, batch_id
from scintille_ingest.runtime.lake_writer import LakeWriter
from scintille_ingest.runtime.metrics import Metrics
from scintille_ingest.runtime.raw_cache import ObjectRawCache, raw_key
from scintille_ingest.runtime.service import Crash, DiskUsage, IngestLive, Settings
from scintille_ingest.runtime.sources import Product
from scintille_ingest.runtime.spool import Spool
from scintille_ingest.runtime.state import MemoryState

NOW = datetime(2026, 7, 15, 18, 30, tzinfo=UTC)
STEPS = ("downloaded", "published_live", "spool_written", "spooled")


def ingested(
    product: Product, source: str, flashes: int = 4, error: str | None = None
) -> IngestedFile:
    ids = [hashlib.sha256(f"{product.key}|{i}".encode()).hexdigest()[:32] for i in range(flashes)]
    log = IngestLogRecord(
        key=product.key,
        source=source,  # type: ignore[arg-type]
        satellite="G19",
        product_start=product.start,
        product_end=product.start + timedelta(seconds=20),
        received_at=NOW,
        row_count=flashes,
        checksum="sha256:x",
        status="ok" if error is None else "failed",
        parse_duration_ms=1.0,
        error=error,
    )
    return IngestedFile(pl.DataFrame({"flash_id": ids, "source": [source] * flashes}), log)


class FakeSource:
    def __init__(self, name: str, files: int = 3, failing: bool = False, cadence: float = 0.01):
        self.name = name
        self.cadence = cadence
        self.failing = failing
        self.products = [
            Product(f"{name}/file-{i}.nc", NOW - timedelta(seconds=20 * (files - i)))
            for i in range(files)
        ]
        self.fetches = 0
        self.corrupt: set[str] = set()
        self.content: dict[str, bytes] = {}

    async def list_recent(self, now: datetime) -> list[Product]:
        if self.failing:
            raise ConnectionError("bucket unreachable")
        return list(self.products)

    async def fetch(self, product: Product) -> bytes:
        self.fetches += 1
        return product.key.encode() if product.etag is None else self.content[product.etag]

    def parse(self, product: Product, data: bytes, received_at: datetime) -> IngestedFile:
        if product.key in self.corrupt:
            return ingested(product, self.name, flashes=0, error="OSError: truncated")
        return ingested(product, self.name)


class CountingPublisher:
    def __init__(self) -> None:
        self.flash_ids: list[str] = []

    async def publish(self, source: str, flashes: pl.DataFrame) -> None:
        self.flash_ids += flashes["flash_id"].to_list()


def service(state: MemoryState, spool: Spool, source: FakeSource, **kwargs: object) -> IngestLive:
    return IngestLive([source], state, spool, clock=lambda: NOW, **kwargs)  # type: ignore[arg-type]


def spool_digest(spool: Spool) -> dict[str, str]:
    return {b: hashlib.sha256(spool.path(b).read_bytes()).hexdigest() for b in spool.pending()}


@pytest.mark.parametrize("step", STEPS)
def test_crash_at_any_step_then_restart_skips_nothing_and_repeats_nothing(
    tmp_path: Path, step: str
) -> None:
    state, spool, source = MemoryState(), Spool(tmp_path), FakeSource("glm-east")
    target = FileIdentity.of(source.products[1].key, source.products[1].key.encode())

    def crash(at: str, identity: FileIdentity) -> None:
        if at == step and identity == target:
            raise Crash(at)

    with pytest.raises(Crash):
        asyncio.run(service(state, spool, source, after_step=crash).poll(source))

    restarted = service(state, spool, source)
    asyncio.run(restarted.poll(source))
    assert {r.state for r in state.records.values()} == {"spooled"}
    assert len(spool.pending()) == 3
    assert {r.batch_id for r in state.records.values()} == set(spool.pending())

    before = spool_digest(spool)
    assert asyncio.run(restarted.poll(source)) == 0
    assert spool_digest(spool) == before


def test_crash_between_spool_and_state_reuses_the_batch_id(tmp_path: Path) -> None:
    state, spool, source = MemoryState(), Spool(tmp_path), FakeSource("glm-east", files=1)

    def crash(at: str, identity: FileIdentity) -> None:
        if at == "spool_written":
            raise Crash(at)

    with pytest.raises(Crash):
        asyncio.run(service(state, spool, source, after_step=crash).poll(source))
    first = spool.pending()
    asyncio.run(service(state, spool, source).poll(source))
    assert spool.pending() == first
    assert not list(tmp_path.glob("*.partial"))


def test_publishes_each_file_once_unless_the_crash_came_before_its_state(tmp_path: Path) -> None:
    state, spool, source = MemoryState(), Spool(tmp_path), FakeSource("glm-east")
    publisher = CountingPublisher()
    asyncio.run(service(state, spool, source, publisher=publisher).poll(source))
    asyncio.run(service(state, spool, source, publisher=publisher).poll(source))
    assert len(publisher.flash_ids) == len(set(publisher.flash_ids)) == 12


def test_spool_rows_carry_versions_and_source_file(tmp_path: Path) -> None:
    state, spool, source = MemoryState(), Spool(tmp_path), FakeSource("glm-east", files=1)
    settings = Settings(parser_version="glm-1", calibration_version="cal-0")
    asyncio.run(service(state, spool, source, settings=settings).poll(source))
    rows = spool.read(spool.pending()[0])
    assert rows["parser_version"].unique().to_list() == ["glm-1"]
    assert rows["calibration_version"].unique().to_list() == ["cal-0"]
    assert rows["source_key"].unique().to_list() == [source.products[0].key]


def test_an_unreadable_file_is_logged_as_failed_and_does_not_block(tmp_path: Path) -> None:
    state, spool, source = MemoryState(), Spool(tmp_path), FakeSource("glm-east")
    source.corrupt = {source.products[0].key}
    live = service(state, spool, source)
    asyncio.run(live.poll(source))
    assert len(spool.pending()) == 3
    logs = pl.concat([spool.read_log(b) for b in spool.pending()])
    assert sorted(logs["status"].to_list()) == ["failed", "ok", "ok"]
    assert asyncio.run(live.poll(source)) == 0


def test_catalog_outage_keeps_ingesting_and_loses_nothing(tmp_path: Path) -> None:
    state, spool, source = MemoryState(), Spool(tmp_path), FakeSource("glm-east")

    def unavailable(spool: Spool, batches: list[str]) -> None:
        raise ConnectionError("catalog down")

    writer = LakeWriter(spool, commit=unavailable, interval=0.01)

    async def scenario() -> None:
        live = service(state, spool, source)
        writer_task = asyncio.create_task(writer.run())
        await live.poll(source)
        await asyncio.sleep(0.05)
        writer.stop()
        await writer_task

    asyncio.run(scenario())
    assert len(spool.pending()) == 3
    assert writer.metrics.counters[("lake_writer_errors_total", ())] >= 1


def test_a_failing_source_does_not_delay_the_others(tmp_path: Path) -> None:
    state, spool = MemoryState(), Spool(tmp_path)
    good, bad = FakeSource("glm-east", files=5), FakeSource("glm-west", failing=True)
    live = IngestLive(
        [bad, good],
        state,
        spool,
        clock=lambda: NOW,
        settings=Settings(initial_backoff=0.01, max_backoff=0.02),
    )

    async def scenario() -> None:
        task = asyncio.create_task(live.run(grace=1))
        await asyncio.sleep(0.3)
        live.stop()
        await task

    asyncio.run(scenario())
    assert len(spool.pending()) == 5
    assert live.metrics.counters[("ingest_errors_total", (("source", "glm-west"),))] >= 3


def test_disk_thresholds_warn_then_pause_the_raw_cache(tmp_path: Path) -> None:
    used = {"ratio": 0.4}
    live = IngestLive(
        [],
        MemoryState(),
        Spool(tmp_path),
        disk_usage=lambda p: DiskUsage(100, int(used["ratio"] * 100), 0),
    )
    for ratio, paused in ((0.4, False), (0.85, False), (0.92, True), (0.6, False)):
        used["ratio"] = ratio
        live.check_disk()
        assert live.raw_cache_paused is paused


def test_a_revised_object_under_the_same_key_is_fetched_again(tmp_path: Path) -> None:
    state, spool, source = MemoryState(), Spool(tmp_path), FakeSource("glm-east", files=1)
    first = source.products[0]
    source.content = {"v1": b"first", "v2": b"revised", "v3": b"revised"}
    live = service(state, spool, source)

    source.products = [Product(first.key, first.start, "v1")]
    assert asyncio.run(live.poll(source)) == 1
    assert asyncio.run(live.poll(source)) == 0

    source.products = [Product(first.key, first.start, "v2")]
    assert asyncio.run(live.poll(source)) == 1
    assert len(spool.pending()) == 2
    assert {r.identity.checksum for r in state.records.values()} == {
        FileIdentity.of(first.key, b"first").checksum,
        FileIdentity.of(first.key, b"revised").checksum,
    }

    source.products = [Product(first.key, first.start, "v3")]
    assert asyncio.run(live.poll(source)) == 1
    assert asyncio.run(live.poll(source)) == 0
    assert len(spool.pending()) == 2
    assert source.fetches == 3


class FailingCache:
    async def put(self, source: str, identity: FileIdentity, data: bytes) -> None:
        raise ConnectionError("R2 unreachable")


def test_raw_cache_stores_originals_unless_the_disk_is_almost_full(tmp_path: Path) -> None:
    store = MemoryStore()
    used = {"ratio": 0.4}
    source = FakeSource("glm-east", files=2)
    live = service(
        MemoryState(),
        Spool(tmp_path),
        source,
        raw_cache=ObjectRawCache(store),
        disk_usage=lambda p: DiskUsage(100, int(used["ratio"] * 100), 0),
    )
    cached, skipped = source.products
    live.check_disk()
    asyncio.run(live.process(source, cached))
    used["ratio"] = 0.92
    live.check_disk()
    asyncio.run(live.process(source, skipped))

    key = raw_key("glm-east", FileIdentity.of(cached.key, cached.key.encode()))
    assert key.startswith("raw/glm-east/glm-east/") and key.endswith("_file-0.nc")
    assert obstore.get(store, key).bytes().to_bytes() == cached.key.encode()
    listed = [m["path"] for batch in obstore.list(store, prefix="raw/") for m in batch]
    assert listed == [key]
    assert len(live.spool.pending()) == 2


def test_a_raw_cache_outage_does_not_block_the_spool(tmp_path: Path) -> None:
    source = FakeSource("glm-east")
    live = service(MemoryState(), Spool(tmp_path), source, raw_cache=FailingCache())
    assert asyncio.run(live.poll(source)) == 3
    assert len(live.spool.pending()) == 3
    assert live.metrics.counters[("ingest_raw_cache_errors_total", (("source", "glm-east"),))] == 3


def test_batch_id_ignores_order() -> None:
    a, b = FileIdentity("k1", "sha256:1"), FileIdentity("k2", "sha256:2")
    assert batch_id([a, b]) == batch_id([b, a])
    assert batch_id([a]) != batch_id([FileIdentity("k1", "sha256:other")])


def test_metrics_render_prometheus_text() -> None:
    metrics = Metrics()
    metrics.inc("ingest_files_total", source="glm-east")
    metrics.set("spool_bytes", 42)
    text = metrics.render()
    assert 'ingest_files_total{source="glm-east"} 1' in text
    assert "# TYPE spool_bytes gauge\nspool_bytes 42" in text


def test_health_endpoint() -> None:
    async def scenario() -> tuple[bytes, bytes]:
        server = await health.serve(0, lambda: True, lambda: "m 1\n")
        port = server.sockets[0].getsockname()[1]
        results = []
        for path in ("/healthz", "/metrics"):
            reader, writer = await asyncio.open_connection("127.0.0.1", port)
            writer.write(f"GET {path} HTTP/1.1\r\n\r\n".encode())
            await writer.drain()
            results.append(await reader.read())
            writer.close()
        server.close()
        await server.wait_closed()
        return results[0], results[1]

    healthz, metrics = asyncio.run(scenario())
    assert healthz.startswith(b"HTTP/1.1 200") and healthz.endswith(b"ok\n")
    assert metrics.endswith(b"m 1\n")
