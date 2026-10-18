import re
from datetime import UTC, datetime, timedelta
from typing import Any

import numpy as np
import polars as pl
from scintille_pipelines.clustering import KM_PER_DEGREE, Params
from scintille_pipelines.hotspots import HotspotRule, drop_hotspots, fixed_hotspots
from scintille_pipelines.storm_cells import StormCellsConfig, hour_cells, scan_hotspots

PARAMS = Params(eps_km=10, eps_minutes=10, min_pts=10)
RULE = HotspotRule()
HOUR = datetime(2026, 10, 8, 12, tzinfo=UTC)
END = HOUR + timedelta(hours=1)
OVERLAP = timedelta(minutes=30)
PIXEL = (21.315, -28.665)
rng = np.random.default_rng(179)


def flashes(
    n: int,
    lat: float,
    lon: float,
    start: datetime,
    hours: float,
    sigma_km: float,
    speed_kmh: tuple[float, float] = (0, 0),
    source: str = "glm-east",
) -> pl.DataFrame:
    """Gaussian flashes drifting at `speed_kmh` (east, north) over `hours`."""
    t = np.sort(rng.uniform(0, hours, n))
    north = rng.normal(0, sigma_km, n) + speed_kmh[1] * t
    east = rng.normal(0, sigma_km, n) + speed_kmh[0] * t
    return pl.DataFrame(
        {
            "flash_id": [f"{rng.integers(2**62):032x}" for _ in range(n)],
            "source": source,
            "event_time": pl.Series(
                [start + timedelta(hours=float(h)) for h in t], dtype=pl.Datetime("us", "UTC")
            ),
            "lat": lat + north / KM_PER_DEGREE,
            "lon": lon + east / (KM_PER_DEGREE * np.cos(np.radians(lat))),
        }
    )


def pixel(per_hour: int = 300, hours: int = 24, sigma_km: float = 1.5) -> pl.DataFrame:
    """A sensor pixel firing up to the end of the tested hour."""
    start = END - timedelta(hours=hours)
    return flashes(per_hour * hours, *PIXEL, start, hours, sigma_km=sigma_km)


def test_fixed_pixel_is_found_and_yields_no_cells() -> None:
    df = pixel()
    spots = fixed_hotspots(df, END, RULE)
    assert spots.height == 1
    assert abs(spots["lat"][0] - PIXEL[0]) < 0.01 and abs(spots["lon"][0] - PIXEL[1]) < 0.01
    assert hour_cells(df, HOUR, OVERLAP, PARAMS).height > 0
    assert hour_cells(df, HOUR, OVERLAP, PARAMS, RULE).height == 0


def test_real_storm_crossing_the_pixel_is_kept() -> None:
    storm = flashes(
        1500, PIXEL[0] - 0.3, PIXEL[1] - 0.3, HOUR - OVERLAP, 1.5, sigma_km=15, speed_kmh=(25, 25)
    )
    cells = hour_cells(pl.concat([pixel(), storm]), HOUR, OVERLAP, PARAMS, RULE)
    assert cells["flash_count"].sum() >= 0.8 * storm.height
    biggest = cells.sort("flash_count").row(-1, named=True)
    assert abs(biggest["lat"] - PIXEL[0]) < 0.3 and abs(biggest["lon"] - PIXEL[1]) < 0.3


def burst(days_ago: int, sigma_km: float) -> pl.DataFrame:
    """A pixel bursting for 4 h, ending `days_ago` days before the tested hour ends."""
    start = END - timedelta(days=days_ago, hours=4)
    return flashes(4000, *PIXEL, start, 4, sigma_km=sigma_km)


def test_pixel_bursting_on_two_days_is_found() -> None:
    bursts = pl.concat([burst(1, 0.7), burst(0, 0.7)])
    assert fixed_hotspots(bursts, END, RULE)["stuck_days"].to_list() == [2]
    assert fixed_hotspots(burst(0, 0.7), END, RULE).is_empty()
    assert fixed_hotspots(pl.concat([burst(1, 0.7), burst(0, 3)]), END, RULE).is_empty()
    assert hour_cells(bursts, HOUR, OVERLAP, PARAMS, RULE).height == 0


def test_very_tight_pixel_is_found_on_its_first_day() -> None:
    assert fixed_hotspots(burst(0, 0.2), END, RULE)["tight"].to_list() == [True]


def test_storms_are_not_hotspots() -> None:
    # An intense storm of a few hours, and a long-lived one with natural rates.
    intense = flashes(6000, *PIXEL, END - timedelta(hours=4), 4, sigma_km=8)
    lasting = flashes(1500, -24.0, -58.0, END - timedelta(hours=20), 20, sigma_km=5)
    compact = [
        flashes(800, 10.0, -70.0 + day, END - timedelta(days=day, hours=6), 6, sigma_km=0.8)
        for day in range(3)
    ]
    assert fixed_hotspots(pl.concat([intense, lasting, *compact]), END, RULE).is_empty()


def test_only_the_hotspot_source_is_dropped() -> None:
    df = pixel()
    west = flashes(50, *PIXEL, HOUR, 1, sigma_km=1, source="glm-west")
    kept = drop_hotspots(pl.concat([df, west]), fixed_hotspots(df, END, RULE), RULE.radius_km)
    assert kept["source"].to_list() == ["glm-west"] * 50


def test_drop_keeps_order_and_wraps_the_antimeridian() -> None:
    spot = pl.DataFrame({"source": ["glm-west"], "lat": [0.0], "lon": [179.99]})
    df = flashes(20, 0, -179.99, HOUR, 1, sigma_km=1, source="glm-west")
    far = flashes(20, 0, 170, HOUR, 1, sigma_km=1, source="glm-west")
    both = pl.concat([far, df]).sort("event_time")
    assert drop_hotspots(both, spot, 10).equals(both.filter(pl.col("lon") > 0))


def test_config_defaults_match_the_rule() -> None:
    assert StormCellsConfig().rule == RULE


class Silver:
    """Answers `scan(row_filter=..., selected_fields=...)` from a frame, counting rows read."""

    def __init__(self, df: pl.DataFrame) -> None:
        self.df, self.largest = df, 0

    def scan(self, row_filter: str, selected_fields: tuple[str, ...]) -> Any:
        lo, hi = (datetime.fromisoformat(t) for t in re.findall(r"'([^']+)'", row_filter))
        part = self.df.filter(pl.col("event_time").is_between(lo, hi, closed="left"))
        self.largest = max(self.largest, part.height)
        return type("Scan", (), {"to_arrow": lambda _: part.select(selected_fields).to_arrow()})()


def test_hotspots_read_day_by_day_match_a_single_read() -> None:
    days = [pixel(hours=72), pixel(hours=2).with_columns(pl.col("lat") + 1)]
    df = pl.concat(days)
    silver = Silver(df)
    expected = fixed_hotspots(df, END, RULE)
    assert not expected.is_empty()
    assert scan_hotspots(silver, END, RULE).equals(expected)  # type: ignore[arg-type]
    assert silver.largest < df.height / 2
