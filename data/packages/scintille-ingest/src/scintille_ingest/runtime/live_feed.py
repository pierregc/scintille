"""Live feed publisher: 30-second chunks by ingest time, then the manifest, then expired chunks."""

import asyncio
import contextlib
import logging
import statistics
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol

import numpy as np
import obstore
import polars as pl
from obstore.store import ObjectStore
from scintille_contract.chunk import Chunk, chunk_name, compress, encode
from scintille_contract.models import (
    QUALITY_FLAG_VALUES,
    SCHEMA_VERSION,
    SOURCE_VALUES,
    ChunkRef,
    LiveManifest,
    SourceState,
    SourceStatus,
)

from scintille_ingest.intensity import provisional_intensity

from .metrics import Metrics

log = logging.getLogger("scintille_ingest.live_feed")

CHUNK_HEADERS = {
    "Content-Type": "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
}
MANIFEST_HEADERS = {"Content-Type": "application/json", "Cache-Control": "public, max-age=10"}
LIVE_AFTER = timedelta(minutes=2)
DELAYED_AFTER = timedelta(minutes=10)


class LiveStore(Protocol):
    async def put(self, path: str, data: bytes, headers: dict[str, str]) -> None: ...

    async def get(self, path: str) -> bytes | None: ...

    async def delete(self, path: str) -> None: ...


class ObjectLiveStore:
    """R2 in production; any obstore store."""

    def __init__(self, store: ObjectStore, prefix: str = "live/") -> None:
        self._store = store
        self._prefix = prefix

    async def put(self, path: str, data: bytes, headers: dict[str, str]) -> None:
        await obstore.put_async(self._store, self._prefix + path, data, attributes=headers)

    async def get(self, path: str) -> bytes | None:
        try:
            result = await obstore.get_async(self._store, self._prefix + path)
        except FileNotFoundError:
            return None
        return (await result.bytes_async()).to_bytes()

    async def delete(self, path: str) -> None:
        await obstore.delete_async(self._store, self._prefix + path)


@dataclass
class _SourceTimes:
    last_event: datetime | None = None
    last_ingest: datetime | None = None


class LiveFeed:
    """A `Publisher` for `IngestLive`: buffers flashes, then `flush()` publishes one chunk."""

    def __init__(
        self,
        store: LiveStore,
        *,
        chunk_seconds: int = 30,
        window: timedelta = timedelta(hours=1),
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        metrics: Metrics | None = None,
    ) -> None:
        self.store = store
        self.chunk_seconds = chunk_seconds
        self.window = window
        self._clock = clock
        self.metrics = metrics or Metrics()
        self.chunks: list[ChunkRef] = []
        self._pending: list[pl.DataFrame] = []
        self._recent_ids: dict[str, datetime] = {}
        self._sources: dict[str, _SourceTimes] = {s: _SourceTimes() for s in SOURCE_VALUES}
        self._stop = asyncio.Event()

    async def restore(self) -> None:
        """Continues the chunk list of the manifest already published, if recent."""
        data = await self.store.get("manifest.json")
        if data is None:
            return
        manifest = LiveManifest.model_validate_json(data)
        horizon = self._clock() - self.window
        self.chunks = [c for c in manifest.chunks if c.end > horizon]
        for status in manifest.sources:
            self._sources[status.source] = _SourceTimes(
                status.last_event_time, status.last_ingest_time
            )

    async def publish(self, source: str, flashes: pl.DataFrame) -> None:
        """Idempotent by `flash_id` over the live window."""
        if flashes.height == 0:
            return
        now = self._clock()
        fresh = flashes.filter(~pl.col("flash_id").is_in(list(self._recent_ids)))
        if fresh.height == 0:
            return
        for flash_id in fresh["flash_id"].to_list():
            self._recent_ids[flash_id] = now
        self._pending.append(fresh)
        times = self._sources[source]
        latest = fresh["event_time"].max()
        if isinstance(latest, datetime) and (times.last_event is None or latest > times.last_event):
            times.last_event = latest
        times.last_ingest = now

    def _next_window(self, now: datetime) -> tuple[datetime, datetime]:
        end = now.replace(microsecond=0)
        start = self.chunks[-1].end if self.chunks else end - timedelta(seconds=self.chunk_seconds)
        if start <= end - self.window:
            start = end - timedelta(seconds=self.chunk_seconds)
        return start, end

    async def flush(self) -> ChunkRef | None:
        """Publishes the buffered flashes as one chunk; the manifest lists stored chunks only."""
        now = self._clock()
        start, end = self._next_window(now)
        if end <= start:
            return None
        flashes = pl.concat(self._pending, how="vertical_relaxed") if self._pending else None
        body = compress(encode(Chunk(start, columns(flashes, start))))
        path = chunk_name(start)
        await self.store.put(path, body, CHUNK_HEADERS)
        self._pending = []
        event_min, event_max = event_span(flashes)
        ref = ChunkRef(
            start=start,
            end=end,
            path=path,
            flash_count=flashes.height if flashes is not None else 0,
            size_bytes=len(body),
            event_min=event_min,
            event_max=event_max,
        )
        self.chunks.append(ref)
        horizon = now - self.window
        expired = [c for c in self.chunks if c.end <= horizon]
        self.chunks = [c for c in self.chunks if c.end > horizon]
        await self.store.put(
            "manifest.json", self.manifest(now).model_dump_json().encode(), MANIFEST_HEADERS
        )
        for chunk in expired:
            with contextlib.suppress(Exception):
                await self.store.delete(chunk.path)
        self._recent_ids = {k: t for k, t in self._recent_ids.items() if t > horizon}
        self._record_latency(flashes, now)
        return ref

    def manifest(self, now: datetime) -> LiveManifest:
        return LiveManifest(
            schema_version=SCHEMA_VERSION,
            generated_at=now,
            chunk_seconds=self.chunk_seconds,
            window_seconds=3600,
            chunks=self.chunks,
            sources=[
                SourceStatus(
                    source=source,
                    state=source_state(self._sources[source].last_ingest, now),
                    last_event_time=self._sources[source].last_event,
                    last_ingest_time=self._sources[source].last_ingest,
                )
                for source in SOURCE_VALUES
            ],
        )

    def _record_latency(self, flashes: pl.DataFrame | None, now: datetime) -> None:
        if flashes is None or flashes.height == 0:
            return
        for (source,), group in flashes.group_by("source"):
            lags = [(now - t).total_seconds() for t in group["event_time"].to_list()]
            median = statistics.median(lags)
            self.metrics.set("live_latency_seconds", median, source=str(source))
            log.info(
                "manifest published",
                extra={
                    "fields": {
                        "source": str(source),
                        "flashes": group.height,
                        "median_latency_s": round(median, 1),
                    }
                },
            )

    async def run(self) -> None:
        """Flushes on whole multiples of `chunk_seconds`; a failed write is retried next time."""
        await self.restore()
        while not self._stop.is_set():
            now = self._clock()
            wait = self.chunk_seconds - now.timestamp() % self.chunk_seconds
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=wait)
            try:
                await self.flush()
            except Exception:
                self.metrics.inc("live_feed_errors_total")
                log.exception("live feed write failed; retrying on the next chunk")

    def stop(self) -> None:
        self._stop.set()


def event_span(flashes: pl.DataFrame | None) -> tuple[datetime | None, datetime | None]:
    if flashes is None or flashes.height == 0:
        return None, None
    low, high = flashes["event_time"].min(), flashes["event_time"].max()
    assert isinstance(low, datetime) and isinstance(high, datetime)
    return low, high


def quality_mask(flags: list[str]) -> int:
    """Bit `i` set for `QualityFlag` number `i`."""
    mask = 0
    for flag in flags:
        mask |= 1 << QUALITY_FLAG_VALUES.index(flag)
    return mask


def source_state(last_ingest: datetime | None, now: datetime) -> SourceState:
    if last_ingest is None or now - last_ingest > DELAYED_AFTER:
        return "offline"
    return "live" if now - last_ingest <= LIVE_AFTER else "delayed"


def columns(flashes: pl.DataFrame | None, start: datetime) -> dict[str, np.ndarray]:
    """Chunk columns, sorted by event time; offsets are relative to the chunk start."""
    if flashes is None or flashes.height == 0:
        empty = np.zeros(0)
        return {
            name: empty
            for name in (
                "event_offset_ms",
                "lat",
                "lon",
                "area_km2",
                "duration_ms",
                "intensity",
                "source",
                "quality",
            )
        }
    frame = flashes.sort("event_time")
    offsets = (frame["event_time"].dt.epoch("ms") - int(start.timestamp() * 1000)).to_numpy()
    sources = (
        frame["source"]
        .cast(pl.String)
        .replace_strict({s: i for i, s in enumerate(SOURCE_VALUES)})
        .to_numpy()
    )
    quality = np.array([quality_mask(flags) for flags in frame["quality"].to_list()])
    return {
        "event_offset_ms": offsets,
        "lat": frame["lat"].to_numpy(),
        "lon": frame["lon"].to_numpy(),
        "area_km2": frame["area_km2"].to_numpy(),
        "duration_ms": frame["duration_ms"].to_numpy(),
        "intensity": provisional_intensity(frame),
        "source": sources,
        "quality": quality,
    }
