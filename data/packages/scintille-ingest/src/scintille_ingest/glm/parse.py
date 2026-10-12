"""Read GLM L2 LCFA flashes and normalize them to the contract's flash record."""

from datetime import UTC, datetime

import netCDF4
import numpy as np
import polars as pl
from numpy.typing import NDArray
from scintille_contract.ids import flash_id
from scintille_contract.models import (
    ENERGY_UNIT_VALUES,
    QUALITY_FLAG_VALUES,
    SOURCE_VALUES,
    Source,
)

UTC_US = pl.Datetime("us", "UTC")
QUALITY = pl.List(pl.Enum(QUALITY_FLAG_VALUES))

RAW_SCHEMA = pl.Schema(
    {
        "native_flash_id": pl.Int64(),
        "first_event_time": UTC_US,
        "last_event_time": UTC_US,
        "lat": pl.Float64(),
        "lon": pl.Float64(),
        "energy_j": pl.Float64(),
        "area_m2": pl.Float64(),
        "quality_flag": pl.Int32(),
    }
)

FLASH_SCHEMA = pl.Schema(
    {
        "flash_id": pl.String(),
        "source": pl.Enum(SOURCE_VALUES),
        "product_file": pl.String(),
        "native_flash_id": pl.Int64(),
        "event_time": UTC_US,
        "ingest_time": UTC_US,
        "lat": pl.Float64(),
        "lon": pl.Float64(),
        "energy_raw": pl.Float64(),
        "energy_unit": pl.Enum(ENERGY_UNIT_VALUES),
        "intensity": pl.Float64(),
        "area_km2": pl.Float64(),
        "duration_ms": pl.Float64(),
        "quality": QUALITY,
    }
)

_TIME_UNITS_PREFIX = "seconds since "


def read_glm_flashes(data: bytes) -> pl.DataFrame:
    """Flash variables of one product file, unpacked, with absolute times (RAW_SCHEMA)."""
    with netCDF4.Dataset("glm.nc", memory=data) as ds:
        first = ds.variables["flash_time_offset_of_first_event"]
        reference = _time_reference(str(first.getncattr("units")))
        columns = {
            "native_flash_id": _values(ds, "flash_id"),
            "first_event_time": _values(ds, first.name) * 1e6,
            "last_event_time": _values(ds, "flash_time_offset_of_last_event") * 1e6,
            "lat": _values(ds, "flash_lat"),
            "lon": _values(ds, "flash_lon"),
            "energy_j": _values(ds, "flash_energy"),
            "area_m2": _values(ds, "flash_area"),
            "quality_flag": _values(ds, "flash_quality_flag"),
        }
    reference_us = int(reference.timestamp()) * 1_000_000 + reference.microsecond
    frame = pl.DataFrame(columns).with_columns(pl.all().fill_nan(None))
    return frame.with_columns(
        (pl.col(name).round() + reference_us).cast(pl.Int64).cast(UTC_US)
        for name in ("first_event_time", "last_event_time")
    ).cast(RAW_SCHEMA)


def normalize_glm_flashes(
    raw: pl.DataFrame, source: Source, product_file: str, ingest_time: datetime
) -> pl.DataFrame:
    """Contract flash records (FLASH_SCHEMA); intensity stays null until `with_intensity`."""
    ids = [flash_id(source, product_file, native) for native in raw["native_flash_id"]]
    degraded = pl.col("quality_flag").fill_null(-1) != 0
    frame = raw.select(
        pl.Series("flash_id", ids, dtype=pl.String),
        pl.lit(source).alias("source"),
        pl.lit(product_file).alias("product_file"),
        "native_flash_id",
        pl.col("first_event_time").alias("event_time"),
        pl.lit(ingest_time.astimezone(UTC)).alias("ingest_time"),
        "lat",
        "lon",
        pl.col("energy_j").alias("energy_raw"),
        pl.lit("J").alias("energy_unit"),
        pl.lit(None).alias("intensity"),
        (pl.col("area_m2") / 1e6).alias("area_km2"),
        ((pl.col("last_event_time") - pl.col("first_event_time")).dt.total_microseconds() / 1e3)
        .clip(lower_bound=0)
        .alias("duration_ms"),
        pl.when(degraded)
        .then(pl.lit(["degraded"], dtype=QUALITY))
        .otherwise(pl.lit([], dtype=QUALITY))
        .alias("quality"),
    )
    return frame.cast(FLASH_SCHEMA)


def empty_flashes() -> pl.DataFrame:
    return FLASH_SCHEMA.to_frame()


def _time_reference(units: str) -> datetime:
    if not units.startswith(_TIME_UNITS_PREFIX):
        raise ValueError(f"unexpected time units: {units}")
    stamp = datetime.strptime(units.removeprefix(_TIME_UNITS_PREFIX), "%Y-%m-%d %H:%M:%S.%f")
    return stamp.replace(tzinfo=UTC)


def _values(ds: netCDF4.Dataset, name: str) -> NDArray[np.float64]:
    return np.ma.filled(np.ma.asarray(ds.variables[name][:], dtype=np.float64), np.nan)
