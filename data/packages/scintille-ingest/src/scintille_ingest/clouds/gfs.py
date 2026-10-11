"""GFS skin temperature, the clear-sky reference for cloud opacity (one GRIB2 field per hour)."""

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import eccodes  # type: ignore[import-untyped]
import numpy as np
import obstore
from numpy.typing import NDArray
from obstore.store import ObjectStore

BUCKET = "noaa-gfs-bdp-pds"
FIELD = ":TMP:surface:"
MAX_FORECAST_HOURS = 120

log = logging.getLogger("scintille_ingest.clouds")


@dataclass(frozen=True)
class SkinTemperature:
    """Kelvin on the GFS 0.25° grid: rows 90° N to 90° S, columns 0° to 359.75° E."""

    values: NDArray[np.float32]
    cycle: datetime
    forecast_hour: int

    @property
    def valid_time(self) -> datetime:
        return self.cycle + timedelta(hours=self.forecast_hour)

    @property
    def label(self) -> str:
        return f"gfs {self.cycle:%Y%m%d%H} f{self.forecast_hour:03d}"


def grib_key(cycle: datetime, forecast_hour: int) -> str:
    return f"gfs.{cycle:%Y%m%d}/{cycle:%H}/atmos/gfs.t{cycle:%H}z.pgrb2.0p25.f{forecast_hour:03d}"


def candidates(valid: datetime, cycles: int = 4) -> list[tuple[datetime, int]]:
    """(cycle, forecast hour) pairs for `valid` (a whole hour), newest cycle first."""
    latest = valid.replace(hour=valid.hour - valid.hour % 6, minute=0, second=0, microsecond=0)
    pairs = []
    for k in range(cycles):
        cycle = latest - timedelta(hours=6 * k)
        hours = round((valid - cycle).total_seconds() / 3600)
        if 0 <= hours <= MAX_FORECAST_HOURS:
            pairs.append((cycle, hours))
    return pairs


def field_range(index: str, field: str = FIELD) -> tuple[int, int | None]:
    """Byte range [start, end) of `field` in a GRIB2 file from its `.idx`; end None means EOF."""
    lines = [line for line in index.splitlines() if line.strip()]
    for i, line in enumerate(lines):
        if field in f":{line.split(':', 3)[3]}":
            start = int(line.split(":")[1])
            end = int(lines[i + 1].split(":")[1]) if i + 1 < len(lines) else None
            return start, end
    raise KeyError(f"{field} not in index")


def decode_field(message: bytes) -> NDArray[np.float32]:
    handle = eccodes.codes_new_from_message(message)
    try:
        ni = eccodes.codes_get(handle, "Ni")
        nj = eccodes.codes_get(handle, "Nj")
        north_first = not eccodes.codes_get(handle, "jScansPositively")
        values = np.asarray(eccodes.codes_get_values(handle), dtype=np.float32).reshape(nj, ni)
    finally:
        eccodes.codes_release(handle)
    return values if north_first else values[::-1]


class GfsSkin:
    """Fetches the field valid at a frame's hour from the newest available cycle; keeps the last
    one as a fallback for up to `max_age` when GFS is late or unreachable."""

    def __init__(self, store: ObjectStore, max_age: timedelta = timedelta(hours=24)) -> None:
        self._store = store
        self._max_age = max_age
        self._cache: dict[datetime, SkinTemperature] = {}

    async def at(self, time: datetime) -> SkinTemperature:
        valid = time.astimezone(UTC).replace(minute=0, second=0, microsecond=0)
        if valid in self._cache:
            return self._cache[valid]
        for cycle, hours in candidates(valid):
            try:
                field = await asyncio.to_thread(self._fetch, cycle, hours)
            except FileNotFoundError:
                continue
            self._cache = {k: v for k, v in self._cache.items() if valid - k < self._max_age}
            self._cache[valid] = field
            return field
        fallback = self._nearest(valid)
        if fallback is None:
            raise LookupError(f"no GFS skin temperature for {valid:%Y-%m-%dT%H}Z")
        log.warning(
            "gfs field missing, using an older one",
            extra={"fields": {"valid": valid.isoformat(), "used": fallback.label}},
        )
        return fallback

    def _nearest(self, valid: datetime) -> SkinTemperature | None:
        usable = [f for f in self._cache.values() if abs(valid - f.valid_time) <= self._max_age]
        return min(usable, key=lambda f: abs(valid - f.valid_time), default=None)

    def _fetch(self, cycle: datetime, hours: int) -> SkinTemperature:
        key = grib_key(cycle, hours)
        index = obstore.get(self._store, key + ".idx").bytes().to_bytes().decode()
        start, end = field_range(index)
        if end is None:
            end = obstore.head(self._store, key)["size"]
        message = obstore.get_range(self._store, key, start=start, end=end).to_bytes()
        return SkinTemperature(decode_field(message), cycle, hours)
