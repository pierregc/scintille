"""Hourly GFS wind at 10 m and 250 hPa, published beside the cloud frames (ADR 0039)."""

import asyncio
import contextlib
import io
import logging
import random
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

import numpy as np
import obstore
from numpy.typing import NDArray
from obstore.store import ObjectStore
from PIL import Image
from scintille_contract.wind import WIND_HEIGHT, WIND_SCALES, WIND_WIDTH

from scintille_ingest.runtime.metrics import Metrics

from . import gfs
from .wind_publish import WindPublisher

Array = NDArray[np.float32]

FIELDS = {
    "10m": (":UGRD:10 m above ground:", ":VGRD:10 m above ground:"),
    "250hPa": (":UGRD:250 mb:", ":VGRD:250 mb:"),
}
"""GRIB index patterns of u and v per level."""

log = logging.getLogger("scintille_ingest.wind")


@dataclass(frozen=True)
class WindField:
    """u (eastward) and v (northward) in m/s per level, on the 0.5° grid: rows 90° N to 90° S,
    columns 0° to 359.5° E."""

    levels: dict[str, tuple[Array, Array]]
    cycle: datetime
    forecast_hour: int

    @property
    def valid_time(self) -> datetime:
        return self.cycle + timedelta(hours=self.forecast_hour)

    @property
    def label(self) -> str:
        return f"gfs {self.cycle:%Y%m%d%H} f{self.forecast_hour:03d}"


def subsample(values: Array) -> Array:
    """0.25° to 0.5°, keeping the poles and the 0° E column."""
    out = values[::2, ::2]
    if out.shape != (WIND_HEIGHT, WIND_WIDTH):
        raise ValueError(f"unexpected GFS grid {values.shape}")
    return out


def read_wind(store: ObjectStore, cycle: datetime, hours: int) -> WindField:
    """The four fields by byte range from one `.idx` read; adjacent ranges share a request."""
    key = gfs.grib_key(cycle, hours)
    index = obstore.get(store, key + ".idx").bytes().to_bytes().decode()
    ranges = [gfs.field_range(index, field) for pair in FIELDS.values() for field in pair]
    size = obstore.head(store, key)["size"] if any(end is None for _, end in ranges) else 0
    parts = obstore.get_ranges(
        store,
        key,
        starts=[start for start, _ in ranges],
        ends=[size if end is None else end for _, end in ranges],
    )
    grids = [subsample(gfs.decode_field(bytes(part))) for part in parts]
    levels = {level: (grids[2 * i], grids[2 * i + 1]) for i, level in enumerate(FIELDS)}
    return WindField(levels, cycle, hours)


def newest_wind(store: ObjectStore, valid: datetime) -> WindField | None:
    """From the newest cycle that has `valid`; None while no cycle has it."""
    for cycle, hours in gfs.candidates(valid):
        try:
            return read_wind(store, cycle, hours)
        except FileNotFoundError:
            continue
    return None


def component_bytes(values: Array, scale: float) -> NDArray[np.uint8]:
    """`encode_component` of every texel."""
    unit = np.clip(np.nan_to_num(values.astype(np.float64)) / scale, -1, 1)
    return (np.rint(unit * 127) + 128).astype(np.uint8)


def encode_level(u: Array, v: Array, scale: float) -> bytes:
    """Lossless RGB WebP: red is u, green is v, blue is 0."""
    red, green = component_bytes(u, scale), component_bytes(v, scale)
    image = Image.fromarray(np.stack([red, green, np.zeros_like(red)], axis=-1))
    buffer = io.BytesIO()
    image.save(buffer, "WEBP", lossless=True)
    return buffer.getvalue()


def encode(field: WindField) -> dict[str, bytes]:
    return {level: encode_level(u, v, WIND_SCALES[level]) for level, (u, v) in field.levels.items()}


def valid_hours(now: datetime, window: timedelta) -> list[datetime]:
    """Whole hours of `window` ending with the next hour, oldest first."""
    newest = now.astimezone(UTC).replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    count = int(window / timedelta(hours=1))
    return [newest - timedelta(hours=h) for h in range(count - 1, -1, -1)]


class WindCollector:
    def __init__(
        self,
        source: ObjectStore,
        publisher: WindPublisher,
        *,
        metrics: Metrics | None = None,
        cadence: float = 300.0,
        max_backoff: float = 1800.0,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.source = source
        self.publisher = publisher
        self.metrics = metrics or Metrics()
        self.cadence = cadence
        self.max_backoff = max_backoff
        self._clock = clock
        self._stop = asyncio.Event()

    async def poll(self) -> int:
        """Publishes the window's hours not published yet, oldest first; an hour GFS does not have
        yet waits for the next poll. Returns how many."""
        published = self.publisher.published()
        done = failed = 0
        for valid in valid_hours(self._clock(), self.publisher.window):
            if self._stop.is_set():
                break
            if valid in published:
                continue
            try:
                if await self.process(valid):
                    done += 1
            except Exception:
                failed += 1
                log.exception("wind frame failed", extra={"fields": {"valid": valid.isoformat()}})
        if newest := max(self.publisher.published(), default=None):
            # Negative while the next hour is ahead of the clock.
            self.metrics.set("wind_frame_age_seconds", (self._clock() - newest).total_seconds())
        if failed:
            raise RuntimeError(f"{failed} wind frames failed")
        return done

    async def process(self, valid: datetime) -> bool:
        started = self._clock()
        field = await asyncio.to_thread(newest_wind, self.source, valid)
        if field is None:
            return False
        textures = await asyncio.to_thread(encode, field)
        now = self._clock()
        await self.publisher.publish(valid, field.label, textures, now)
        self.metrics.inc("wind_frames_total")
        log.info(
            "wind frame published",
            extra={
                "fields": {
                    "valid": valid.isoformat(),
                    "reference": field.label,
                    "bytes": {level: len(b) for level, b in textures.items()},
                    "seconds": round((now - started).total_seconds(), 1),
                }
            },
        )
        return True

    async def run(self) -> None:
        try:
            await self.publisher.restore()
        except Exception:
            log.exception("wind manifest unreadable; starting from an empty window")
        failures = 0
        while not self._stop.is_set():
            try:
                await self.poll()
                failures = 0
                delay = self.cadence
            except Exception:
                failures += 1
                self.metrics.inc("wind_errors_total")
                delay = min(self.max_backoff, self.cadence * 2 ** (failures - 1))
                delay *= 0.5 + random.random() / 2
                log.exception(
                    "wind poll failed",
                    extra={"fields": {"failures": failures, "retry_in_s": round(delay, 1)}},
                )
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=delay)

    async def start(self) -> None:
        """Never raises: the wind runs beside the cloud frames and must not stop them."""
        try:
            await self.run()
        except Exception:
            self.metrics.inc("wind_errors_total")
            log.exception("wind collector stopped")

    def stop(self) -> None:
        self._stop.set()


async def backfill(
    source: ObjectStore,
    publisher: WindPublisher,
    days: list[date],
    clock: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> int:
    """Archive frames and daily indexes of past days from the cycle of each hour (f000 to f005),
    leaving the live manifest alone; hours already indexed are skipped. Returns how many."""
    total = 0
    for day in days:
        frames = await publisher.day_frames(day)
        if frames is None:
            continue
        indexed = {f.time for f in frames}
        written = 0
        for hour in range(24):
            valid = datetime(day.year, day.month, day.day, hour, tzinfo=UTC)
            if valid in indexed or valid > clock():
                continue
            field = await asyncio.to_thread(newest_wind, source, valid)
            if field is None:
                log.warning(
                    "no gfs wind for this hour", extra={"fields": {"valid": valid.isoformat()}}
                )
                continue
            textures = await asyncio.to_thread(encode, field)
            await publisher.archive_frame(valid, field.label, textures, clock())
            written += 1
        total += written
        log.info("wind day backfilled", extra={"fields": {"day": str(day), "frames": written}})
    return total
