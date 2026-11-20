"""Cold cloud tops in Himawari's infrared where no lightning source sees (ADR 0038)."""

import math
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray
from pydantic import AwareDatetime, BaseModel
from scintille_contract.coverage import half_width

from . import geos
from .composite import MAX_HEIGHT_KM, TopAt
from .disk import Disk

SATELLITE = "himawari09"
THRESHOLD_K = 215.0
CELL_PX = 16
"""Native pixels per cell side: about 32 km at the sub-satellite point."""
MIN_COLD_PX = 9
MAX_VIEW_ZENITH_DEG = 75.0
PARALLAX_STEPS = 3
STRIP_CELLS = 32


@dataclass(frozen=True)
class ColdTops:
    lat: NDArray[np.float64]
    lon: NDArray[np.float64]
    cold: NDArray[np.float64]
    """Share of the cell's pixels under the threshold."""
    min_bt: NDArray[np.float64]

    def __len__(self) -> int:
        return len(self.lat)


class ColdTopsFile(BaseModel):
    """`cold-tops/…json`: one row per cell, `[lat, lon, cold, min_bt_k]`, ground positions."""

    time: AwareDatetime
    satellite: str
    threshold_k: float
    cell_km: float
    tops: list[tuple[float, float, float, float]]


def detect(infrared: Disk, top_at: TopAt) -> ColdTops:
    """Cells with enough pixels under the threshold, placed under their top, in no lightning
    source's footprint."""
    grid = infrared.grid
    rows, cols = grid.rows // CELL_PX, grid.cols // CELL_PX
    counts = np.zeros((rows, cols), np.int32)
    coldest = np.full((rows, cols), np.inf, np.float32)
    for first in range(0, rows, STRIP_CELLS):
        last = min(first + STRIP_CELLS, rows)
        values = np.asarray(
            infrared.values[first * CELL_PX : last * CELL_PX, : cols * CELL_PX], np.float32
        )
        blocks = np.nan_to_num(values, nan=np.inf).reshape(last - first, CELL_PX, cols, CELL_PX)
        counts[first:last] = (blocks < THRESHOLD_K).sum(axis=(1, 3))
        coldest[first:last] = blocks.min(axis=(1, 3))
    r, c = np.nonzero(counts >= MIN_COLD_PX)
    if len(r) == 0:
        return _empty()
    centre = (CELL_PX - 1) / 2
    x, y = grid.angles(
        r.astype(np.float64) * CELL_PX + centre, c.astype(np.float64) * CELL_PX + centre
    )
    min_bt = coldest[r, c]
    lat, lon = geos.ground(x, y, infrared.view)
    seen = np.isfinite(lat)
    lat, lon, x, y, min_bt, cold = (
        lat[seen],
        lon[seen],
        x[seen],
        y[seen],
        min_bt[seen],
        counts[r, c][seen] / CELL_PX**2,
    )
    top_km = np.nan_to_num(top_at(min_bt, lat, lon)).astype(np.float64)
    height_m = np.clip(top_km, 0, MAX_HEIGHT_KM) * 1000
    for _ in range(PARALLAX_STEPS):
        xh, yh, _ = geos.scan_angles(lat, lon, height_m, infrared.view)
        x0, y0, _ = geos.scan_angles(lat, lon, 0.0, infrared.view)
        lat, lon = geos.ground(x - (xh - x0), y - (yh - y0), infrared.view)
    _, _, cos_vza = geos.scan_angles(lat, lon, height_m, infrared.view)
    keep = (
        np.isfinite(lat)
        & (cos_vza >= math.cos(math.radians(MAX_VIEW_ZENITH_DEG)))
        & (np.abs(lat) > half_width(lon))
    )
    return ColdTops(lat[keep], lon[keep], cold[keep], min_bt[keep].astype(np.float64))


def encode(tops: ColdTops, time: AwareDatetime) -> bytes:
    rows = [
        (round(float(a), 2), round(float(o), 2), round(float(f), 2), round(float(t), 1))
        for a, o, f, t in zip(tops.lat, tops.lon, tops.cold, tops.min_bt, strict=True)
    ]
    return (
        ColdTopsFile(
            time=time,
            satellite=SATELLITE,
            threshold_k=THRESHOLD_K,
            cell_km=2.0 * CELL_PX,
            tops=rows,
        )
        .model_dump_json()
        .encode()
    )


def _empty() -> ColdTops:
    empty = np.empty(0)
    return ColdTops(empty, empty, empty, empty)
