"""Fixed hot spots: sensor pixels that fire around the clock, excluded from storm detection."""

import math
from dataclasses import dataclass
from datetime import datetime, timedelta

import polars as pl

from .clustering import KM_PER_DEGREE


@dataclass(frozen=True)
class HotspotRule:
    """A grid cell of one source is a hot spot when, over `lookback_hours`, it holds at least
    `min_flashes` flashes spread over at least `min_hours` distinct hours (docs/data-quality.md).
    """

    lookback_hours: int = 24
    grid_deg: float = 0.05
    min_flashes: int = 2000
    min_hours: int = 12
    radius_km: float = 10.0


def fixed_hotspots(flashes: pl.DataFrame, end: datetime, rule: HotspotRule) -> pl.DataFrame:
    """Hot spots seen in `[end - lookback, end)`: source, centre (median position), counts."""
    start = end - timedelta(hours=rule.lookback_hours)
    return (
        flashes.filter(pl.col("event_time").is_between(start, end, closed="left"))
        .with_columns(
            gi=(pl.col("lat") / rule.grid_deg).floor(),
            gj=(pl.col("lon") / rule.grid_deg).floor(),
        )
        .group_by("source", "gi", "gj")
        .agg(
            pl.col("lat").median(),
            pl.col("lon").median(),
            pl.len().alias("flashes"),
            pl.col("event_time").dt.truncate("1h").n_unique().alias("hours"),
        )
        .filter((pl.col("flashes") >= rule.min_flashes) & (pl.col("hours") >= rule.min_hours))
        .select("source", "lat", "lon", "flashes", "hours")
        .sort("source", "lat", "lon")
    )


def drop_hotspots(flashes: pl.DataFrame, hotspots: pl.DataFrame, radius_km: float) -> pl.DataFrame:
    """Flashes farther than `radius_km` from every hot spot of their own source."""
    r2 = (radius_km / KM_PER_DEGREE) ** 2
    near = pl.lit(False)
    for source, lat, lon in hotspots.select("source", "lat", "lon").iter_rows():
        dlon = ((pl.col("lon") - lon + 180) % 360 - 180) * math.cos(math.radians(lat))
        near |= (pl.col("source") == source) & ((pl.col("lat") - lat) ** 2 + dlon**2 <= r2)
    return flashes.filter(~near)
