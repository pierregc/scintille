"""Cloud-top height from infrared brightness temperature and the GFS temperature profile
(ADR 0028): the top sits where the forecast air is as cold as the cloud."""

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import numpy as np
import obstore
from numpy.typing import NDArray
from obstore.store import ObjectStore

from .gfs import MAX_FORECAST_HOURS, decode_field, field_range

Array = NDArray[np.float32]

LEVELS_HPA = (1000, 975, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350,
              300, 250, 200, 150, 100, 70)  # fmt: skip
GRID_DEGREES = 0.5
KNOT_STEP_K = 2.0
KNOTS_K = np.arange(180.0, 320.0 + KNOT_STEP_K, KNOT_STEP_K, dtype=np.float32)
"""Brightness temperatures at which each column's height is tabulated."""
OVERSHOOT_K_PER_KM = 7.0
"""Cooling above the tropopause of tops that overshoot it."""
MAX_KM = 20.0
LAPSE_K_PER_KM = 6.5

log = logging.getLogger("scintille_ingest.clouds")


def grib_key(cycle: datetime, forecast_hour: int) -> str:
    return f"gfs.{cycle:%Y%m%d}/{cycle:%H}/atmos/gfs.t{cycle:%H}z.pgrb2.0p50.f{forecast_hour:03d}"


def fields() -> list[str]:
    """GRIB index patterns, in the order `Profile.of` expects them."""
    out = [":HGT:surface:", ":TMP:2 m above ground:"]
    for p in LEVELS_HPA:
        out += [f":HGT:{p} mb:", f":TMP:{p} mb:"]
    return out


def candidates(valid: datetime, cycles: int = 4) -> list[tuple[datetime, int]]:
    """(cycle, forecast hour) pairs closest to `valid`, newest cycle first; the 0.5° files are
    3-hourly, and a profile 90 minutes off is close enough for cloud tops."""
    latest = valid.replace(hour=valid.hour - valid.hour % 6, minute=0, second=0, microsecond=0)
    pairs = []
    for k in range(cycles):
        cycle = latest - timedelta(hours=6 * k)
        hours = 3 * round((valid - cycle).total_seconds() / 3600 / 3)
        if 0 <= hours <= MAX_FORECAST_HOURS:
            pairs.append((cycle, hours))
    return pairs


@dataclass(frozen=True)
class HeightTable:
    """Height (km above sea level) per column of the 0.5° grid for each of `KNOTS_K`: rows from
    90° N, columns from 0° E."""

    km: NDArray[np.float16]
    """Shape (knots, rows, columns)."""
    label: str

    @classmethod
    def of(cls, stacked: Array, label: str) -> "HeightTable":
        """`stacked`: surface height and 2 m temperature, then height and temperature per level
        of `LEVELS_HPA`, each (rows, columns) north first."""
        surface_z, surface_t = stacked[0], stacked[1]
        z = np.concatenate([surface_z[None], stacked[2::2]]).astype(np.float32)
        t = np.concatenate([surface_t[None], stacked[3::2]]).astype(np.float32)
        below = z[1:] < surface_z[None]
        z[1:] = np.where(below, surface_z[None], z[1:])
        t[1:] = np.where(below, surface_t[None], t[1:])
        rows, cols = surface_z.shape
        km = np.empty((KNOTS_K.size, rows, cols), np.float16)
        for start in range(0, rows, 32):
            sl = slice(start, start + 32)
            km[:, sl] = column_heights(z[:, sl], t[:, sl], KNOTS_K) / 1000
        return cls(km, label)

    def at(self, bt: Array, lat: NDArray[np.float64], lon: NDArray[np.float64]) -> Array:
        """Top height in km for brightness temperatures `bt` (K) at `lat`, `lon`; NaN where `bt`
        is NaN."""
        knots, rows, cols = self.km.shape
        r = np.clip((90 - lat) / GRID_DEGREES, 0, rows - 1)
        c = np.mod(lon, 360) / GRID_DEGREES
        k = np.clip(np.nan_to_num((bt - KNOTS_K[0]) / KNOT_STEP_K, nan=0.0), 0, knots - 1)
        r0, c0, k0 = (np.floor(v).astype(np.intp) for v in (r, c, k))
        fr, fc, fk = ((v - v0).astype(np.float32) for v, v0 in ((r, r0), (c, c0), (k, k0)))
        r1, k1 = np.minimum(r0 + 1, rows - 1), np.minimum(k0 + 1, knots - 1)
        c0, c1 = c0 % cols, (c0 + 1) % cols
        out = np.zeros(np.shape(bt), np.float32)
        for kk, wk in ((k0, 1 - fk), (k1, fk)):
            for rr, wr in ((r0, 1 - fr), (r1, fr)):
                for cc, wc in ((c0, 1 - fc), (c1, fc)):
                    out += self.km[kk, rr, cc] * (wk * wr * wc)
        return np.where(np.isfinite(bt), out, np.nan).astype(np.float32)


def column_heights(z: Array, t: Array, bt: Array) -> Array:
    """Height (m) where each column first gets as cold as each of `bt` going up from the ground,
    stopping at its coldest level (the tropopause); colder tops overshoot it at
    `OVERSHOOT_K_PER_KM`. `z`, `t`: (levels, ...) from the ground up. Returns (bt, ...)."""
    cold = np.argmin(t, axis=0)
    levels = np.arange(t.shape[0]).reshape((-1, *(1,) * (t.ndim - 1)))
    usable = levels <= cold[None]
    out = np.empty((bt.size, *t.shape[1:]), np.float32)
    t_cold = np.take_along_axis(t, cold[None], axis=0)[0]
    z_cold = np.take_along_axis(z, cold[None], axis=0)[0]
    for i, value in enumerate(bt):
        reached = (t <= value) & usable
        first = np.argmax(reached, axis=0)
        any_reached = reached.any(axis=0)
        below = np.maximum(first - 1, 0)
        t0 = np.take_along_axis(t, below[None], axis=0)[0]
        t1 = np.take_along_axis(t, first[None], axis=0)[0]
        z0 = np.take_along_axis(z, below[None], axis=0)[0]
        z1 = np.take_along_axis(z, first[None], axis=0)[0]
        with np.errstate(invalid="ignore", divide="ignore"):
            f = np.where(t0 > t1, (t0 - value) / (t0 - t1), 0.0)
        crossing = np.where(first == 0, z[0], z0 + np.clip(f, 0, 1) * (z1 - z0))
        overshoot = z_cold + (t_cold - value) / OVERSHOOT_K_PER_KM * 1000
        out[i] = np.clip(np.where(any_reached, crossing, overshoot), 0, MAX_KM * 1000)
    return out


def lapse_heights(bt: Array, skin: Array) -> Array:
    """The parallax estimate of ADR 0023: cooling below the surface at `LAPSE_K_PER_KM`, km."""
    with np.errstate(invalid="ignore"):
        km: Array = np.clip((skin - bt) / LAPSE_K_PER_KM, 0, 15).astype(np.float32)
    return km


class GfsProfile:
    """Fetches the temperature profile closest to a frame's hour from the newest cycle and keeps
    the last table for up to `max_age` when GFS is late."""

    def __init__(self, store: ObjectStore, max_age: timedelta = timedelta(hours=24)) -> None:
        self._store = store
        self._max_age = max_age
        self._cache: dict[datetime, tuple[datetime, HeightTable]] = {}

    async def at(self, time: datetime) -> HeightTable | None:
        valid = time.astimezone(UTC).replace(minute=0, second=0, microsecond=0)
        if valid in self._cache:
            return self._cache[valid][1]
        for cycle, hours in candidates(valid):
            try:
                table = await asyncio.to_thread(self._fetch, cycle, hours)
            except FileNotFoundError:
                continue
            fresh = {k: v for k, v in self._cache.items() if valid - k < self._max_age}
            self._cache = {**fresh, valid: (cycle + timedelta(hours=hours), table)}
            return table
        usable = [v for v in self._cache.values() if abs(valid - v[0]) <= self._max_age]
        if usable:
            return min(usable, key=lambda v: abs(valid - v[0]))[1]
        log.warning("gfs profile missing", extra={"fields": {"valid": valid.isoformat()}})
        return None

    def _fetch(self, cycle: datetime, hours: int) -> HeightTable:
        key = grib_key(cycle, hours)
        index = obstore.get(self._store, key + ".idx").bytes().to_bytes().decode()
        ranges = [field_range(index, f) for f in fields()]
        size = None
        if any(end is None for _, end in ranges):
            size = obstore.head(self._store, key)["size"]
        starts = [start for start, _ in ranges]
        ends = [end if end is not None else size for _, end in ranges]
        parts = obstore.get_ranges(self._store, key, starts=starts, ends=ends)  # type: ignore[arg-type]
        stacked = np.stack([decode_field(bytes(p)) for p in parts])
        return HeightTable.of(stacked, f"gfs {cycle:%Y%m%d%H} f{hours:03d} 0p50")
