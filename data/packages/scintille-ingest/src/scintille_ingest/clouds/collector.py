"""`clouds`: lists GMGSI every minute and publishes each new hourly mosaic as cloud textures."""

import asyncio
import contextlib
import logging
import random
from collections.abc import Callable
from datetime import UTC, datetime

import obstore
from obstore.store import ObjectStore

from scintille_ingest.runtime.metrics import Metrics

from .gfs import GfsSkin, SkinTemperature
from .gmgsi import GmgsiProduct, list_products, read_mosaic
from .publish import CloudPublisher
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
