"""Fixed hot spots: sensor pixels that fire around the clock, excluded from storm detection."""

import math
from dataclasses import dataclass
from datetime import datetime, timedelta

import polars as pl

from .clustering import KM_PER_DEGREE


@dataclass(frozen=True)
class HotspotRule:
    """Hot spots per source and grid cell (docs/data-quality.md).

    Busy: over the last 24 h, `min_flashes` flashes in `min_hours` distinct hours. Stuck: on
    `pixel_min_days` of the last `pixel_days` days, `pixel_min_flashes` flashes in
    `pixel_min_hours` hours with a spread (geometric mean of the north and east standard
    deviations) under `pixel_spread_km`. Tight: the same over the last 24 h alone, with a
    spread under `pixel_tight_km`.
    """

    grid_deg: float = 0.05
    min_flashes: int = 2000
    min_hours: int = 12
    pixel_days: int = 3
    pixel_min_days: int = 2
    pixel_min_flashes: int = 300
    pixel_min_hours: int = 3
    pixel_spread_km: float = 1.0
    pixel_tight_km: float = 0.5
    radius_km: float = 10.0

    @property
    def lookback(self) -> timedelta:
        return timedelta(days=max(1, self.pixel_days))


CELL = ["source", "gi", "gj"]


def fixed_hotspots(flashes: pl.DataFrame, end: datetime, rule: HotspotRule) -> pl.DataFrame:
    """Hot spots seen before `end`: source, centre (median position), flashes and days."""
    return hotspots_from_days(pixel_days(flashes, end, rule), rule)


def pixel_days(flashes: pl.DataFrame, end: datetime, rule: HotspotRule) -> pl.DataFrame:
    """Per grid cell and day before `end`; each day only needs its own flashes."""
    return (
        flashes.filter(pl.col("event_time").is_between(end - rule.lookback, end, closed="left"))
        .with_columns(
            gi=(pl.col("lat") / rule.grid_deg).floor(),
            gj=(pl.col("lon") / rule.grid_deg).floor(),
            day=((pl.lit(end) - pl.col("event_time")).dt.total_microseconds() // 86_400_000_000),
        )
        .group_by(*CELL, "day")
        .agg(
            pl.col("lat").median(),
            pl.col("lon").median(),
            pl.len().alias("flashes"),
            pl.col("event_time").dt.truncate("1h").n_unique().alias("hours"),
            (pl.col("lat").std() * pl.col("lon").std() * pl.col("lat").mean().radians().cos())
            .sqrt()
            .mul(KM_PER_DEGREE)
            .fill_null(0.0)
            .alias("spread_km"),
        )
        .with_columns(
            pixel=(pl.col("flashes") >= rule.pixel_min_flashes)
            & (pl.col("hours") >= rule.pixel_min_hours),
            last=pl.col("day") == 0,
        )
        .with_columns(
            busy=pl.col("last")
            & (pl.col("flashes") >= rule.min_flashes)
            & (pl.col("hours") >= rule.min_hours),
            stuck=pl.col("pixel") & (pl.col("spread_km") < rule.pixel_spread_km),
            tight=pl.col("pixel") & pl.col("last") & (pl.col("spread_km") < rule.pixel_tight_km),
        )
    )


def hotspots_from_days(days: pl.DataFrame, rule: HotspotRule) -> pl.DataFrame:
    return (
        days.group_by(CELL)
        .agg(
            pl.col("lat").filter(pl.col("busy") | pl.col("stuck") | pl.col("tight")).median(),
            pl.col("lon").filter(pl.col("busy") | pl.col("stuck") | pl.col("tight")).median(),
            pl.col("flashes").sum(),
            pl.col("busy").any(),
            pl.col("stuck").sum().alias("stuck_days"),
            pl.col("tight").any(),
        )
        .filter(pl.col("busy") | pl.col("tight") | (pl.col("stuck_days") >= rule.pixel_min_days))
        .select("source", "lat", "lon", "flashes", "busy", "tight", "stuck_days")
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
