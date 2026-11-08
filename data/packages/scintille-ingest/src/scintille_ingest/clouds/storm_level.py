"""Where the 0.5 km storm tiles go: by day, around the strongest storms of the hour (ADR 0037)."""

import math
from collections.abc import Iterable
from datetime import datetime, timedelta

import numpy as np
from pydantic import AwareDatetime, BaseModel

from scintille_ingest.runtime.live_feed import LiveStore

from . import geos, tiles
from .composite import DAY, MAX_HEIGHT_KM, VIEW_FADE
from .disk import Window, Windows
from .geos import Grid, View
from .storm_detail import Position, keys_under
from .sun import cos_zenith

MIN_LEVEL = 4
"""Storms from this ADR 0009 level get storm tiles."""
MARGIN_KM = 150.0
"""Beyond the current cell: the anvil, and what a close view frames around the storm."""
WINDOW = timedelta(hours=1)
"""Track positions this close to the slot count: the frame shows from an hour before to an hour
after it."""
WINDOW_MARGIN = 4
"""Native pixels kept beyond what a tile samples."""
EDGE_POINTS = 17


class PathPoint(BaseModel):
    time: AwareDatetime
    lat: float
    lon: float


class ActiveCell(BaseModel):
    """The fields read from a cell of `storms/active.json` (ActiveCell in the contract)."""

    level: int
    area_km2: float
    path: list[PathPoint]


class ActiveStorms(BaseModel):
    cells: list[ActiveCell]


def positions(feed: ActiveStorms, slot: datetime) -> list[Position]:
    """Where the storms of at least `MIN_LEVEL` were around the slot, with the margin."""
    return [
        Position(p.lat, p.lon, math.sqrt(cell.area_km2 / math.pi) + MARGIN_KM)
        for cell in feed.cells
        if cell.level >= MIN_LEVEL
        for p in cell.path
        if abs(p.time - slot) <= WINDOW
    ]


class ActiveAreas:
    """Storm areas from the live feed (ADR 0021), so a frame gets them as soon as it renders."""

    def __init__(self, store: LiveStore) -> None:
        self.store = store

    async def positions(self, slot: datetime) -> list[Position]:
        data = await self.store.get("active.json")
        return positions(ActiveStorms.model_validate_json(data), slot) if data else []


def storm_keys(found: Iterable[Position], subsolar: tuple[float, float]) -> frozenset[tiles.Key]:
    """Storm level tiles around the positions where the visible counts fully somewhere."""
    return frozenset(k for k in keys_under(found, (tiles.STORM_LEVEL,)) if _lit(k, subsolar))


def _lit(key: tiles.Key, subsolar: tuple[float, float]) -> bool:
    lat, lon = tiles.centers(key.z, key.x, key.y, 0)
    step = tiles.TILE // (EDGE_POINTS - 1)
    la, lo = np.meshgrid(lat[::step], lon[::step], indexing="ij")
    return bool(np.any(cos_zenith(la, lo, subsolar) > DAY[1]))


def _outline(key: tiles.Key) -> tuple[np.ndarray, np.ndarray]:
    """Latitudes and longitudes around the texels a tile samples, border included."""
    lat, lon = tiles.centers(key.z, key.x, key.y, tiles.BORDER + 2)
    across = np.linspace(0, lat.size - 1, EDGE_POINTS).round().astype(int)
    edge_lat = np.concatenate(
        [lat[across], lat[across], np.full(EDGE_POINTS, lat[0]), np.full(EDGE_POINTS, lat[-1])]
    )
    edge_lon = np.concatenate(
        [np.full(EDGE_POINTS, lon[0]), np.full(EDGE_POINTS, lon[-1]), lon[across], lon[across]]
    )
    return edge_lat, edge_lon


def windows(keys: Iterable[tiles.Key]) -> Windows:
    """For each tile, the native pixels a disk's composite samples there, parallax included."""
    outlines = [_outline(k) for k in keys]

    def compute(view: View, grid: Grid) -> list[Window]:
        out = []
        for lat, lon in outlines:
            rows, cols = [], []
            for height in (0.0, MAX_HEIGHT_KM * 1e3):
                x, y, cos_vza = geos.scan_angles(lat, lon, height, view)
                seen = cos_vza > VIEW_FADE[0]
                r, c = grid.index(x[seen], y[seen])
                rows.append(r)
                cols.append(c)
            r, c = np.concatenate(rows), np.concatenate(cols)
            if r.size == 0:
                continue
            row0 = max(math.floor(r.min()) - WINDOW_MARGIN, 0)
            row1 = min(math.ceil(r.max()) + WINDOW_MARGIN + 1, grid.rows)
            col0 = max(math.floor(c.min()) - WINDOW_MARGIN, 0)
            col1 = min(math.ceil(c.max()) + WINDOW_MARGIN + 1, grid.cols)
            if row1 - row0 >= 2 and col1 - col0 >= 2:
                out.append(Window(row0, row1, col0, col1))
        return out

    return compute
