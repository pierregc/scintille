"""Live feed publisher: chunks by ingest time, then the manifest, then expired chunks."""

import asyncio
import contextlib
import json
import logging
import os
import statistics
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Protocol

import numpy as np
import obstore
import polars as pl
from obstore.store import ObjectStore
from scintille_contract import coverage
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

from .metrics import Metrics
from .ops import LiveStats

log = logging.getLogger("scintille_ingest.live_feed")

CHUNK_HEADERS = {
    "Content-Type": "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
}
MANIFEST_HEADERS = {"Content-Type": "application/json", "Cache-Control": "public, max-age=2"}
COVERAGE_PATH = "coverage.geojson"
COVERAGE_HEADERS = {"Content-Type": "application/geo+json", "Cache-Control": "public, max-age=3600"}


@dataclass(frozen=True)
class StateDelays:
    """Time since a source's last file after which it turns `delayed`, then `offline` (down)."""

    delayed_after: timedelta = timedelta(minutes=2)
    offline_after: timedelta = timedelta(minutes=10)

    def __post_init__(self) -> None:
        if not timedelta(0) < self.delayed_after <= self.offline_after:
            raise ValueError("expected 0 < delayed_after <= offline_after")

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> "StateDelays":
        """`SCINTILLE_SOURCE_DELAYED_AFTER` and `SCINTILLE_SOURCE_OFFLINE_AFTER`, in seconds."""
        default = cls()
        return cls(
            _seconds(env.get("SCINTILLE_SOURCE_DELAYED_AFTER"), default.delayed_after),
            _seconds(env.get("SCINTILLE_SOURCE_OFFLINE_AFTER"), default.offline_after),
        )


PRODUCT_CADENCE: dict[str, timedelta] = {"mtg-li": timedelta(minutes=10)}
"""Time between two product files of a source, added to its state delays."""


@dataclass(frozen=True)
class FlushPolicy:
    """When to publish the next chunk (ADR 0026): once every live source of `wait_for` delivered a
    file, or `timeout` after the first pending flashes; never within `spacing` of the previous
    chunk; an empty chunk after `idle` without data."""

    wait_for: frozenset[str] = frozenset({"glm-east", "glm-west"})
    timeout: timedelta = timedelta(seconds=10)
    spacing: timedelta = timedelta(seconds=15)
    idle: timedelta = timedelta(seconds=30)

    def due(
        self,
        now: datetime,
        previous: datetime,
        first_pending: datetime | None,
        delivered: set[str],
        live: set[str],
    ) -> datetime:
        if first_pending is None:
            return previous + self.idle
        expected = self.wait_for & live
        ready = now if expected and expected <= delivered else first_pending + self.timeout
        return max(ready, previous + self.spacing)


def _seconds(value: str | None, default: timedelta) -> timedelta:
    return timedelta(seconds=float(value)) if value else default


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


class FileLiveStore:
    """A local directory with the bucket layout; headers are dropped."""

    def __init__(self, root: Path, prefix: str = "live/") -> None:
        self._root = root / prefix

    async def put(self, path: str, data: bytes, headers: dict[str, str]) -> None:
        target = self._root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    async def get(self, path: str) -> bytes | None:
        target = self._root / path
        return target.read_bytes() if target.exists() else None

    async def delete(self, path: str) -> None:
        (self._root / path).unlink(missing_ok=True)


class Outbox:
    """Flashes accepted by `publish()` until a manifest lists their chunk; survives restarts.

    `pending/` holds accepted frames, `inflight/` the frames bound to a chunk being written,
    `published/` the flash ids already listed, for deduplication over the live window.
    """

    def __init__(self, directory: Path) -> None:
        self.pending_dir = directory / "pending"
        self.inflight_dir = directory / "inflight"
        self.published_dir = directory / "published"
        for d in (self.pending_dir, self.inflight_dir, self.published_dir):
            d.mkdir(parents=True, exist_ok=True)

    def add(self, frame: pl.DataFrame, now: datetime) -> str:
        name = f"{now.strftime('%Y%m%dT%H%M%S%f')}-{uuid.uuid4().hex}.arrow"
        _write_atomic(self.pending_dir / name, frame.write_ipc)
        return name

    def pending(self) -> list[tuple[str, pl.DataFrame]]:
        return [(p.name, pl.read_ipc(p)) for p in sorted(self.pending_dir.glob("*.arrow"))]

    def published_ids(self, horizon: datetime) -> dict[str, datetime]:
        ids: dict[str, datetime] = {}
        for path in sorted(self.published_dir.glob("*.arrow")):
            at = accepted_at(path.name)
            if at > horizon:
                ids.update(dict.fromkeys(pl.read_ipc(path)["flash_id"].to_list(), at))
        return ids

    def begin(self, chunk: str, names: list[str]) -> None:
        _write_atomic(self._record(chunk), lambda p: Path(p).write_text(json.dumps(names)))

    def ack(self, chunk: str) -> None:
        """The chunk is listed: its frames move to `published/` as flash ids. Idempotent."""
        record = self._record(chunk)
        if not record.exists():
            return
        for name in json.loads(record.read_text()):
            frame_path = self.pending_dir / name
            if frame_path.exists():
                ids = pl.read_ipc(frame_path).select("flash_id")
                _write_atomic(self.published_dir / name, ids.write_ipc)
                frame_path.unlink()
        record.unlink()
        _fsync_directory(self.pending_dir)

    def abort(self, chunk: str) -> None:
        """The chunk is not listed: its frames stay pending."""
        self._record(chunk).unlink(missing_ok=True)

    def inflight(self) -> list[str]:
        return [_chunk_of(p.name) for p in sorted(self.inflight_dir.glob("*.json"))]

    def prune(self, horizon: datetime) -> None:
        for path in self.published_dir.glob("*.arrow"):
            if accepted_at(path.name) <= horizon:
                path.unlink(missing_ok=True)

    def _record(self, chunk: str) -> Path:
        return self.inflight_dir / (chunk.replace("/", "__") + ".json")


def _chunk_of(record_name: str) -> str:
    return record_name.removesuffix(".json").replace("__", "/")


def accepted_at(name: str) -> datetime:
    return datetime.strptime(name.split("-")[0], "%Y%m%dT%H%M%S%f").replace(tzinfo=UTC)


def _write_atomic(final: Path, write: Callable[[Path], object]) -> None:
    partial = final.with_name(final.name + ".partial")
    write(partial)
    with partial.open("rb") as handle:
        os.fsync(handle.fileno())
    partial.replace(final)
    _fsync_directory(final.parent)


def _fsync_directory(directory: Path) -> None:
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


@dataclass
class _SourceTimes:
    last_event: datetime | None = None
    last_ingest: datetime | None = None


class LiveFeed:
    """A `Publisher` for `IngestLive`: `publish()` is durable, `flush()` writes one chunk."""

    def __init__(
        self,
        store: LiveStore,
        *,
        outbox: Path,
        chunk_seconds: int = 20,
        window: timedelta = timedelta(hours=1),
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        metrics: Metrics | None = None,
        delays: StateDelays | None = None,
        policy: FlushPolicy | None = None,
    ) -> None:
        self.store = store
        self.delays = delays or StateDelays()
        self.policy = policy or FlushPolicy()
        self.chunk_seconds = chunk_seconds
        self.window = window
        self._clock = clock
        self.metrics = metrics or Metrics()
        self.chunks: list[ChunkRef] = []
        self.outbox = Outbox(outbox)
        self._pending: list[tuple[str, pl.DataFrame]] = []
        self._unlisted: list[str] = []
        self._recent_ids: dict[str, datetime] = {}
        self._sources: dict[str, _SourceTimes] = {s: _SourceTimes() for s in SOURCE_VALUES}
        self.stats = LiveStats(clock())
        self.manifest_at: datetime | None = None
        self._coverage_published = False
        self._stop = asyncio.Event()
        self._delivered: set[str] = set()
        self._first_pending: datetime | None = None
        self._previous_flush: datetime | None = None
        self._arrival = asyncio.Event()

    async def restore(self) -> None:
        """Continues the published chunk list and reloads the flashes no manifest lists yet."""
        data = await self.store.get("manifest.json")
        manifest = parse_manifest(data) if data else None
        horizon = self._clock() - self.window
        listed = {c.path for c in manifest.chunks} if manifest else set()
        for chunk in self.outbox.inflight():
            if chunk in listed:
                self.outbox.ack(chunk)
            else:
                self.outbox.abort(chunk)
        if manifest:
            self.chunks = [c for c in manifest.chunks if c.end > horizon]
            for status in manifest.sources:
                self._sources[status.source] = _SourceTimes(
                    status.last_event_time, status.last_ingest_time
                )
        self._recent_ids = self.outbox.published_ids(horizon)
        for name, frame in self.outbox.pending():
            at = accepted_at(name)
            self._pending.append((name, frame))
            self._recent_ids.update(dict.fromkeys(frame["flash_id"].to_list(), at))
            for (source,), group in frame.group_by("source"):
                self._seen(str(source), group, at)
        if self._pending:
            self._first_pending = self._clock()
        if manifest:
            self._previous_flush = manifest.generated_at

    async def publish(self, source: str, flashes: pl.DataFrame) -> None:
        """Idempotent by `flash_id` over the live window; an empty frame still counts as ingest."""
        now = self._clock()
        self._delivered.add(source)
        self._arrival.set()
        fresh = flashes.filter(~pl.col("flash_id").is_in(list(self._recent_ids)))
        if fresh.height == 0:
            self._seen(source, fresh, now)
            return
        name = self.outbox.add(fresh, now)
        self._recent_ids.update(dict.fromkeys(fresh["flash_id"].to_list(), now))
        self._pending.append((name, fresh))
        self._first_pending = self._first_pending or now
        self._seen(source, fresh, now)

    def _seen(self, source: str, flashes: pl.DataFrame, at: datetime) -> None:
        times = self._sources[source]
        latest = flashes["event_time"].max()
        if isinstance(latest, datetime) and (times.last_event is None or latest > times.last_event):
            times.last_event = latest
        if times.last_ingest is None or at > times.last_ingest:
            times.last_ingest = at

    def _next_window(self, now: datetime) -> tuple[datetime, datetime]:
        end = now.replace(microsecond=0)
        start = self.chunks[-1].end if self.chunks else end - timedelta(seconds=self.chunk_seconds)
        if start <= end - self.window:
            start = end - timedelta(seconds=self.chunk_seconds)
        return start, end

    async def flush(self) -> ChunkRef | None:
        """Publishes the buffered flashes as one chunk; the manifest lists stored chunks only."""
        now = self._clock()
        self._previous_flush = now
        start, end = self._next_window(now)
        if end <= start:
            return None
        path = chunk_name(start)
        batch, self._pending = self._pending, []
        delivered, self._delivered = self._delivered, set()
        first_pending, self._first_pending = self._first_pending, None
        try:
            frames = [frame for _, frame in batch]
            flashes = pl.concat(frames, how="vertical_relaxed") if frames else None
            body = compress(encode(Chunk(start, columns(flashes, start))))
            self.outbox.begin(path, [name for name, _ in batch])
            await self.store.put(path, body, CHUNK_HEADERS)
        except BaseException:
            self.outbox.abort(path)
            self._pending = batch + self._pending
            self._delivered |= delivered
            self._first_pending = first_pending or self._first_pending
            raise
        self._unlisted.append(path)
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
        for listed in self._unlisted:
            self.outbox.ack(listed)
        self._unlisted = []
        self.outbox.prune(horizon)
        for chunk in expired:
            with contextlib.suppress(Exception):
                await self.store.delete(chunk.path)
        self.manifest_at = now
        self._recent_ids = {k: t for k, t in self._recent_ids.items() if t > horizon}
        self._record_latency(flashes, now)
        if flashes is not None and flashes.height:
            self.stats.record(flashes, now)
        await self.publish_coverage()
        return ref

    async def publish_coverage(self) -> None:
        """Writes `coverage.geojson` once per process when it changed; retried on the next chunk."""
        if self._coverage_published:
            return
        body = (json.dumps(coverage.geojson(), separators=(",", ":")) + "\n").encode()
        try:
            if await self.store.get(COVERAGE_PATH) != body:
                await self.store.put(COVERAGE_PATH, body, COVERAGE_HEADERS)
        except Exception:
            self.metrics.inc("live_feed_errors_total")
            log.exception("coverage map write failed; retrying on the next chunk")
            return
        self._coverage_published = True

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
                    state=source_state(
                        self._sources[source].last_ingest,
                        now,
                        self.delays,
                        PRODUCT_CADENCE.get(source, timedelta(0)),
                    ),
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

    def due(self, now: datetime) -> datetime:
        """When the next chunk is due under the flush policy."""
        live = {
            source
            for source, times in self._sources.items()
            if times.last_ingest and now - times.last_ingest <= self.delays.delayed_after
        }
        previous = self._previous_flush or now - self.policy.spacing
        return self.policy.due(now, previous, self._first_pending, self._delivered, live)

    async def run(self) -> None:
        """Flushes when `due`; a failed write is retried after the policy's spacing."""
        await self.restore()
        while not self._stop.is_set():
            self._arrival.clear()
            now = self._clock()
            wait = (self.due(now) - now).total_seconds()
            if wait > 0:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._arrival.wait(), timeout=wait)
                continue
            try:
                await self.flush()
            except Exception:
                self.metrics.inc("live_feed_errors_total")
                log.exception("live feed write failed; retrying on the next chunk")

    def stop(self) -> None:
        self._stop.set()
        self._arrival.set()


def parse_manifest(data: bytes) -> LiveManifest:
    """Reads a manifest of any minor version of the current major, e.g. after an upgrade."""
    raw = json.loads(data)
    if str(raw.get("schema_version", "")).split(".")[0] == SCHEMA_VERSION.split(".")[0]:
        raw["schema_version"] = SCHEMA_VERSION
    return LiveManifest.model_validate(raw)


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


def source_state(
    last_ingest: datetime | None,
    now: datetime,
    delays: StateDelays | None = None,
    cadence: timedelta = timedelta(0),
) -> SourceState:
    delays = delays or StateDelays()
    if last_ingest is None:
        return "offline"
    age = now - last_ingest - cadence
    if age > delays.offline_after:
        return "offline"
    return "live" if age <= delays.delayed_after else "delayed"


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
        "intensity": frame["intensity"].fill_null(0).to_numpy(),
        "source": sources,
        "quality": quality,
    }
