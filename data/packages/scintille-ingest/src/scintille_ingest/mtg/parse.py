"""Read LI L2 LFL flashes and normalize them to the contract's flash record."""

from datetime import UTC, datetime

import netCDF4
import numpy as np
import polars as pl
from numpy.typing import NDArray
from scintille_contract.ids import flash_id
from scintille_contract.models import Source

from scintille_ingest.glm.parse import FLASH_SCHEMA, QUALITY, UTC_US

RAW_SCHEMA = pl.Schema(
    {
        "native_flash_id": pl.Int64(),
        "event_time": UTC_US,
        "lat": pl.Float64(),
        "lon": pl.Float64(),
        "radiance": pl.Float64(),
        "footprint_km2": pl.Float64(),
        "duration_ms": pl.Float64(),
        "l1b_warning": pl.Boolean(),
    }
)

_TIME_UNITS_PREFIX = "seconds since "
_DURATION_MS = {"ms": 1.0, "s": 1e3}
_AREA_KM2 = {"km2": 1.0, "km^2": 1.0, "m2": 1e-6, "m^2": 1e-6}
_WARNINGS = ("l1b_missing_warning", "l1b_geolocation_warning", "l1b_radiometric_warning")


def read_li_flashes(data: bytes) -> pl.DataFrame:
    """Flash variables of one chunk, unpacked, with absolute times (RAW_SCHEMA)."""
    with netCDF4.Dataset("li.nc", memory=data) as root:
        ds = root.groups.get("data", root)
        n = ds.variables["flash_id"].size
        time = ds.variables["flash_time"]
        reference = _time_reference(str(time.getncattr("units")))
        columns = {
            "native_flash_id": _values(ds, "flash_id"),
            "event_time": _values(ds, "flash_time") * 1e6,
            "lat": _values(ds, "latitude"),
            "lon": _values(ds, "longitude"),
            "radiance": _values(ds, "radiance"),
            "footprint_km2": _values(ds, "flash_footprint")
            * _factor(ds, "flash_footprint", _AREA_KM2),
            "duration_ms": _values(ds, "flash_duration")
            * _factor(ds, "flash_duration", _DURATION_MS),
            "l1b_warning": _warnings(ds, n),
        }
    reference_us = int(reference.timestamp()) * 1_000_000 + reference.microsecond
    frame = pl.DataFrame(columns).with_columns(pl.selectors.float().fill_nan(None))
    return frame.with_columns(
        (pl.col("event_time").round() + reference_us).cast(pl.Int64).cast(UTC_US)
    ).cast(RAW_SCHEMA)


def normalize_li_flashes(
    raw: pl.DataFrame, source: Source, product_file: str, ingest_time: datetime
) -> pl.DataFrame:
    """Contract flash records (FLASH_SCHEMA); intensity stays null until it is normalized."""
    ids = [flash_id(source, product_file, native) for native in raw["native_flash_id"]]
    frame = raw.select(
        pl.Series("flash_id", ids, dtype=pl.String),
        pl.lit(source).alias("source"),
        pl.lit(product_file).alias("product_file"),
        "native_flash_id",
        "event_time",
        pl.lit(ingest_time.astimezone(UTC)).alias("ingest_time"),
        "lat",
        "lon",
        pl.col("radiance").alias("energy_raw"),
        pl.lit("mW m-2 sr-1").alias("energy_unit"),
        pl.lit(None).alias("intensity"),
        pl.col("footprint_km2").alias("area_km2"),
        pl.col("duration_ms").clip(lower_bound=0),
        pl.when(pl.col("l1b_warning"))
        .then(pl.lit(["degraded"], dtype=QUALITY))
        .otherwise(pl.lit([], dtype=QUALITY))
        .alias("quality"),
    )
    return frame.cast(FLASH_SCHEMA)


def _time_reference(units: str) -> datetime:
    if not units.startswith(_TIME_UNITS_PREFIX):
        raise ValueError(f"unexpected time units: {units}")
    return datetime.fromisoformat(units.removeprefix(_TIME_UNITS_PREFIX)).replace(tzinfo=UTC)


def _factor(ds: netCDF4.Dataset, name: str, known: dict[str, float]) -> float:
    units = str(ds.variables[name].getncattr("units"))
    if units not in known:
        raise ValueError(f"unexpected units for {name}: {units}")
    return known[units]


def _warnings(ds: netCDF4.Dataset, n: int) -> NDArray[np.bool_]:
    """L1b warnings flag the whole chunk (scalar) or single flashes (one value per flash)."""
    warning = np.zeros(n, dtype=bool)
    for name in _WARNINGS:
        if name in ds.variables:
            values = np.nan_to_num(_values(ds, name), nan=0.0) != 0
            warning |= np.broadcast_to(values.reshape(-1) if values.size == n else values.any(), n)
    return warning


def _values(ds: netCDF4.Dataset, name: str) -> NDArray[np.float64]:
    return np.ma.filled(np.ma.asarray(ds.variables[name][:], dtype=np.float64), np.nan)
