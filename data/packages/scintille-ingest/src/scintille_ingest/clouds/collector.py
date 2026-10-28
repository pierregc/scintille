"""`clouds`: publishes each hourly cloud frame, from the GMGSI mosaic or the home-made composite."""

import asyncio
import contextlib
import logging
import random
import resource
import shutil
import sys
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

import obstore
from obstore.store import ObjectStore

from scintille_ingest.runtime.metrics import Metrics

from . import pyramid
from .gfs import GfsSkin, SkinTemperature
from .gmgsi import GmgsiProduct, Mosaic, list_products, read_mosaic
from .publish import CloudPublisher
from .sources import SlotFiles, Sources, decode
from .sun import subsolar_point
from .texture import TIERS, encode_tiers, opacity

log = logging.getLogger("scintille_ingest.clouds")


def render(data: bytes, skin: SkinTemperature) -> dict[str, bytes]:
    """One mosaic to WebP textures per tier."""
    return encode_tiers(opacity(read_mosaic(data), skin, max(TIERS.values())))


class CloudCollector:
    def __init__(
        self,
        source: ObjectStore,
        skin: GfsSkin,
        publisher: CloudPublisher,
        *,
        metrics: Metrics | None = None,
        cadence: float = 60.0,
        max_backoff: float = 600.0,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.source = source
        self.skin = skin
        self.publisher = publisher
        self.metrics = metrics or Metrics()
        self.cadence = cadence
        self.max_backoff = max_backoff
        self._clock = clock
        self._stop = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    async def poll(self) -> int:
        """Publishes the window's mosaics not published yet, oldest first. Returns how many."""
        now = self._clock()
        hours = int(self.publisher.window.total_seconds() // 3600) + 1
        listed = await asyncio.to_thread(list_products, self.source, now, hours)
        published = self.publisher.published()
        todo = [
            p
            for p in listed
            if now - p.time < self.publisher.window and published.get(p.time) != p.name
        ]
        failed = 0
        for product in todo:
            if self._stop.is_set():
                break
            try:
                await self.process(product)
            except Exception:
                failed += 1
                log.exception("cloud frame failed", extra={"fields": {"product": product.name}})
        if failed:
            raise RuntimeError(f"{failed} of {len(todo)} cloud frames failed")
        return len(todo)

    async def process(self, product: GmgsiProduct) -> None:
        data = await asyncio.to_thread(
            lambda: obstore.get(self.source, product.key).bytes().to_bytes()
        )
        skin = await self.skin.at(product.time)
        textures = await asyncio.to_thread(render, data, skin)
        now = self._clock()
        await self.publisher.publish(product.time, product.name, skin.label, textures, now)
        age = (now - product.time).total_seconds()
        delay = (now - product.last_modified).total_seconds() if product.last_modified else None
        self.metrics.inc("cloud_frames_total")
        self.metrics.set("cloud_frame_age_seconds", age)
        if delay is not None:
            self.metrics.set("cloud_publish_delay_seconds", delay)
        log.info(
            "cloud frame published",
            extra={
                "fields": {
                    "time": product.time.isoformat(),
                    "product": product.name,
                    "reference": skin.label,
                    "bytes": {tier: len(b) for tier, b in textures.items()},
                    "age_s": round(age, 1),
                    "upstream_to_r2_s": None if delay is None else round(delay, 1),
                }
            },
        )

    async def run(self) -> None:
        await self.publisher.restore()
        failures = 0
        while not self._stop.is_set():
            try:
                await self.poll()
                failures = 0
                delay = self.cadence
            except Exception:
                failures += 1
                self.metrics.inc("cloud_errors_total")
                delay = min(self.max_backoff, self.cadence * 2 ** (failures - 1))
                delay *= 0.5 + random.random() / 2
                log.exception(
                    "cloud poll failed",
                    extra={"fields": {"failures": failures, "retry_in_s": round(delay, 1)}},
                )
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=delay)

    async def start(self) -> None:
        self._task = asyncio.create_task(self.run(), name="clouds")
        await self._task

    def healthy(self) -> bool:
        return self._task is not None and not self._task.done()

    def stop(self) -> None:
        self._stop.set()


def _max_rss_mb(who: int) -> int:
    """Peak resident memory; Linux reports kilobytes, macOS bytes."""
    peak = resource.getrusage(who).ru_maxrss
    return round(peak / (1 << 20 if sys.platform == "darwin" else 1 << 10))


def hour_slots(now: datetime, window: timedelta) -> list[datetime]:
    """Whole hours within the window, oldest first."""
    newest = now.replace(minute=0, second=0, microsecond=0)
    count = int(window.total_seconds() // 3600)
    return [newest - timedelta(hours=h) for h in range(count - 1, -1, -1)]


class CompositeCollector:
    """Renders each hourly slot once every satellite has delivered it, or once `deadline` has
    passed with what arrived (ADR 0023). Gaps fall back to the latest GMGSI mosaic."""

    def __init__(
        self,
        sources: Sources,
        skin: GfsSkin,
        fallback: ObjectStore | None,
        publisher: CloudPublisher,
        work_dir: Path,
        *,
        workers: int = 2,
        metrics: Metrics | None = None,
        cadence: float = 60.0,
        max_backoff: float = 600.0,
        deadline: timedelta = timedelta(minutes=45),
        download_timeout: timedelta = timedelta(minutes=20),
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.sources = sources
        self.download_timeout = download_timeout
        self.skin = skin
        self.fallback = fallback
        self.publisher = publisher
        self.work_dir = work_dir
        self.workers = workers
        self.metrics = metrics or Metrics()
        self.cadence = cadence
        self.max_backoff = max_backoff
        self.deadline = deadline
        self._clock = clock
        self._stop = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    async def poll(self) -> int:
        """Renders the window's slots that are ready and not published yet, oldest first."""
        now = self._clock()
        published = self.publisher.published()
        done = 0
        for slot in hour_slots(now, self.publisher.window):
            if self._stop.is_set():
                break
            if slot in published:
                continue
            files = await asyncio.to_thread(self.sources.find, slot)
            if not files.complete and now - slot < self.deadline:
                continue
            if not files.complete_satellites:
                log.warning(
                    "no satellite for cloud slot", extra={"fields": {"slot": slot.isoformat()}}
                )
                continue
            await self.process(files)
            done += 1
        return done

    async def process(self, files: SlotFiles) -> None:
        directory = self.work_dir / f"{files.slot:%Y%m%dT%H%M}"
        started = self._clock()
        try:
            downloaded = await asyncio.wait_for(
                asyncio.to_thread(self.sources.download, files, directory / "raw"),
                self.download_timeout.total_seconds(),
            )
            fetched = self._clock()
            skin = await self.skin.at(files.slot)
            fallback = await asyncio.to_thread(self._fallback, files.slot)
            rendered = await asyncio.to_thread(
                self._render, downloaded, directory / "disks", skin, fallback, files.slot
            )
        finally:
            await asyncio.to_thread(shutil.rmtree, directory, True)
        now = self._clock()
        await self.publisher.publish(
            files.slot, files.product, skin.label, rendered.textures, now, rendered.tiles
        )
        self.metrics.inc("cloud_frames_total")
        self.metrics.set("cloud_frame_age_seconds", (now - files.slot).total_seconds())
        self.metrics.set("cloud_render_seconds", (now - fetched).total_seconds())
        log.info(
            "cloud frame published",
            extra={
                "fields": {
                    "time": files.slot.isoformat(),
                    "product": files.product,
                    "reference": skin.label,
                    "satellites": files.complete_satellites,
                    "tiles": len(rendered.tiles),
                    "tile_bytes": sum(len(b) for b in rendered.tiles.values()),
                    "bytes": {tier: len(b) for tier, b in rendered.textures.items()},
                    "max_rss_mb": _max_rss_mb(resource.RUSAGE_SELF),
                    "worker_max_rss_mb": _max_rss_mb(resource.RUSAGE_CHILDREN),
                    "download_s": round((fetched - started).total_seconds(), 1),
                    "render_s": round((now - fetched).total_seconds(), 1),
                    "age_s": round((now - files.slot).total_seconds(), 1),
                }
            },
        )

    def _clear_work(self) -> None:
        """Frames cut short by a restart leave gigabytes behind."""
        for directory in self.work_dir.glob("[0-9]" * 8 + "T" + "[0-9]" * 4):
            shutil.rmtree(directory, ignore_errors=True)

    def _fallback(self, slot: datetime) -> Mosaic | None:
        """The newest GMGSI mosaic at most two hours before the slot, if any."""
        if self.fallback is None:
            return None
        try:
            listed = [p for p in list_products(self.fallback, slot, 3) if p.time <= slot]
        except Exception:
            log.warning("gmgsi listing failed", exc_info=True)
            return None
        if not listed:
            return None
        data = obstore.get(self.fallback, listed[-1].key).bytes().to_bytes()
        return read_mosaic(data)

    def _render(
        self,
        downloaded: dict[str, list[Path]],
        directory: Path,
        skin: SkinTemperature,
        fallback: Mosaic | None,
        slot: datetime,
    ) -> pyramid.Rendered:
        directory.mkdir(parents=True, exist_ok=True)
        base = pyramid.Inputs((), skin.values, subsolar_point(slot), fallback)
        satellites = decode(downloaded, directory, base.skin_at)
        for path in downloaded.values():
            for file in path:
                file.unlink(missing_ok=True)
        inputs = pyramid.Inputs(tuple(satellites), skin.values, subsolar_point(slot), fallback)
        return pyramid.frame(inputs, self.workers)

    async def run(self) -> None:
        await self.publisher.restore()
        await asyncio.to_thread(self._clear_work)
        failures = 0
        while not self._stop.is_set():
            try:
                await self.poll()
                failures = 0
                delay = self.cadence
            except Exception:
                failures += 1
                self.metrics.inc("cloud_errors_total")
                delay = min(self.max_backoff, self.cadence * 2 ** (failures - 1))
                delay *= 0.5 + random.random() / 2
                log.exception(
                    "cloud poll failed",
                    extra={"fields": {"failures": failures, "retry_in_s": round(delay, 1)}},
                )
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=delay)

    async def start(self) -> None:
        self._task = asyncio.create_task(self.run(), name="clouds")
        await self._task

    def healthy(self) -> bool:
        return self._task is not None and not self._task.done()

    def stop(self) -> None:
        self._stop.set()
