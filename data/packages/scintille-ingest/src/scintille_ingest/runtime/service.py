"""`ingest-live`: one asyncio task per source; each file goes download → live feed → spool."""

import asyncio
import contextlib
import logging
import random
import shutil
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import NamedTuple, Protocol

import polars as pl

from scintille_ingest.validate import quarantine_rows, validate

from .identity import FileIdentity, batch_id
from .metrics import Metrics
from .sources import Product, Source
from .spool import Spool
from .state import ORDER, StateStore

log = logging.getLogger("scintille_ingest.live")


class Publisher(Protocol):
    """Live feed (#36). Idempotent by `flash_id`: after a crash a file can be published twice."""

    async def publish(self, source: str, flashes: pl.DataFrame) -> None: ...


class RawCache(Protocol):
    async def put(self, source: str, identity: FileIdentity, data: bytes) -> None: ...


class Pinger(Protocol):
    async def ping(self, ok: bool = True, message: str = "") -> bool: ...


class NullPublisher:
    async def publish(self, source: str, flashes: pl.DataFrame) -> None:
        pass


class NullRawCache:
    async def put(self, source: str, identity: FileIdentity, data: bytes) -> None:
        pass


class DiskUsage(NamedTuple):
    total: int
    used: int
    free: int


@dataclass(frozen=True)
class Settings:
    parser_version: str = "glm-1"
    calibration_version: str = "none"
    initial_backoff: float = 5.0
    max_backoff: float = 300.0
    disk_warn: tuple[float, ...] = (0.5, 0.8)
    disk_pause_raw: float = 0.9
    heartbeat_every: float = 60.0


class Crash(Exception):
    """Raised by test hooks to stop the process between two steps."""


class IngestLive:
    def __init__(
        self,
        sources: list[Source],
        state: StateStore,
        spool: Spool,
        *,
        publisher: Publisher | None = None,
        raw_cache: RawCache | None = None,
        heartbeat: Pinger | None = None,
        metrics: Metrics | None = None,
        settings: Settings | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        after_step: Callable[[str, FileIdentity], None] = lambda step, identity: None,
        disk_usage: Callable[[Path], DiskUsage] = lambda p: DiskUsage(*shutil.disk_usage(p)),
    ) -> None:
        self.sources = sources
        self.state = state
        self.spool = spool
        self.publisher = publisher or NullPublisher()
        self.raw_cache = raw_cache or NullRawCache()
        self.heartbeat = heartbeat
        self.metrics = metrics or Metrics()
        self.settings = settings or Settings()
        self._clock = clock
        self._after_step = after_step
        self._disk_usage = disk_usage
        self._stop = asyncio.Event()
        self._tasks: list[asyncio.Task[None]] = []
        self.raw_cache_paused = False
        self._disk_level = 0.0

    async def poll(self, source: Source) -> int:
        """One listing of `source`; processes every file not spooled yet. Returns how many."""
        products = await source.list_recent(self._clock())
        done = self.state.spooled_keys(source.name, {p.key: p.etag for p in products})
        todo = sorted((p for p in products if p.key not in done), key=lambda p: (p.start, p.key))
        for product in todo:
            if self._stop.is_set():
                break
            await self.process(source, product)
        return len(todo)

    async def process(self, source: Source, product: Product) -> None:
        data = await source.fetch(product)
        received_at = self._clock()
        identity = FileIdentity.of(product.key, data)
        record = self.state.get(identity)
        if record and record.state == "spooled":
            self.state.advance(identity, source.name, "spooled", etag=product.etag)
            return
        if not self.raw_cache_paused:
            await self._cache_raw(source.name, identity, data)
        self.state.advance(identity, source.name, "downloaded", etag=product.etag)
        self._after_step("downloaded", identity)

        parsed = source.parse(product, data, received_at)
        flashes, rejected = validate(
            parsed.flashes, (parsed.log.product_start, parsed.log.product_end)
        )
        if rejected.height:
            self.metrics.inc("ingest_quarantined_total", rejected.height, source=source.name)
        if parsed.log.status != "ok":
            self.metrics.inc("ingest_unreadable_files_total", source=source.name)
            log.warning(
                "unreadable file",
                extra={
                    "fields": {"source": source.name, "key": product.key, "error": parsed.log.error}
                },
            )
        if flashes.height and (record is None or ORDER[record.state] < ORDER["published_live"]):
            await self.publisher.publish(source.name, flashes)
        self.state.advance(identity, source.name, "published_live", etag=product.etag)
        self._after_step("published_live", identity)

        batch = batch_id([identity])
        self.spool.write(
            batch,
            flashes.with_columns(
                pl.lit(self.settings.parser_version).alias("parser_version"),
                pl.lit(self.settings.calibration_version).alias("calibration_version"),
                pl.lit(product.key).alias("source_key"),
                pl.lit(identity.checksum).alias("source_checksum"),
            ),
            pl.DataFrame([asdict(parsed.log)]),
            quarantine_rows(
                rejected, self.settings.parser_version, self.settings.calibration_version
            ),
        )
        self._after_step("spool_written", identity)
        self.state.advance(identity, source.name, "spooled", batch, etag=product.etag)
        self._after_step("spooled", identity)

        lag = (self._clock() - product.start).total_seconds()
        self.metrics.inc("ingest_files_total", source=source.name)
        self.metrics.inc("ingest_flashes_total", flashes.height, source=source.name)
        self.metrics.set("ingest_lag_seconds", lag, source=source.name)
        log.info(
            "file spooled",
            extra={
                "fields": {
                    "source": source.name,
                    "key": product.key,
                    "flashes": flashes.height,
                    "lag_s": round(lag, 1),
                    "batch_id": batch,
                }
            },
        )

    async def _cache_raw(self, source: str, identity: FileIdentity, data: bytes) -> None:
        """Best effort: an R2 outage must not stop the live feed."""
        try:
            await self.raw_cache.put(source, identity, data)
        except Exception:
            self.metrics.inc("ingest_raw_cache_errors_total", source=source)
            log.exception("raw cache upload failed", extra={"fields": {"key": identity.key}})

    async def source_loop(self, source: Source) -> None:
        """Polls on the source's cadence; on errors backs off exponentially, alone."""
        failures = 0
        while not self._stop.is_set():
            try:
                await self.poll(source)
                failures = 0
                delay = source.cadence
            except Crash:
                raise
            except Exception:
                failures += 1
                self.metrics.inc("ingest_errors_total", source=source.name)
                delay = min(
                    self.settings.max_backoff, self.settings.initial_backoff * 2 ** (failures - 1)
                )
                delay *= 0.5 + random.random() / 2
                log.exception(
                    "source failed",
                    extra={
                        "fields": {
                            "source": source.name,
                            "failures": failures,
                            "retry_in_s": round(delay, 1),
                        }
                    },
                )
            await self._sleep(delay)

    def check_disk(self) -> float:
        """Spool disk usage; warns at each threshold and pauses the raw cache past the last one."""
        usage = self._disk_usage(self.spool.directory)
        ratio = usage.used / usage.total
        self.metrics.set("spool_disk_used_ratio", ratio)
        self.metrics.set("spool_bytes", self.spool.size_bytes())
        level = max(
            [t for t in (*self.settings.disk_warn, self.settings.disk_pause_raw) if ratio >= t],
            default=0.0,
        )
        if level > self._disk_level:
            log.warning("spool disk filling up", extra={"fields": {"used_ratio": round(ratio, 3)}})
        self._disk_level = level
        paused = ratio >= self.settings.disk_pause_raw
        if paused != self.raw_cache_paused:
            log.warning(
                "raw cache upload " + ("paused" if paused else "resumed"),
                extra={"fields": {"used_ratio": round(ratio, 3)}},
            )
        self.raw_cache_paused = paused
        return ratio

    async def disk_loop(self, every: float = 60.0) -> None:
        while not self._stop.is_set():
            self.check_disk()
            await self._sleep(every)

    async def heartbeat_loop(self, heartbeat: Pinger) -> None:
        """Pings while every loop runs, reports the stopped ones otherwise."""
        while not self._stop.is_set():
            stopped = sorted(t.get_name() for t in self._tasks if t.done())
            with contextlib.suppress(Exception):
                await heartbeat.ping(
                    not stopped, "stopped: " + ", ".join(stopped) if stopped else ""
                )
            await self._sleep(self.settings.heartbeat_every)

    def healthy(self) -> bool:
        return bool(self._tasks) and not any(t.done() for t in self._tasks)

    async def run(self, grace: float = 30.0) -> None:
        """Runs until `stop()`; files in progress get `grace` seconds to finish."""
        self._tasks = [asyncio.create_task(self.source_loop(s), name=s.name) for s in self.sources]
        self._tasks.append(asyncio.create_task(self.disk_loop(), name="disk"))
        if self.heartbeat:
            self._tasks.append(
                asyncio.create_task(self.heartbeat_loop(self.heartbeat), name="heartbeat")
            )
        await self._stop.wait()
        _, late = await asyncio.wait(self._tasks, timeout=grace)
        for task in late:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)

    def stop(self) -> None:
        self._stop.set()

    async def _sleep(self, seconds: float) -> None:
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self._stop.wait(), timeout=seconds)
