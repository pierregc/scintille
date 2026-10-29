"""Search rows for D1 (ADR 0027): published storms with their path, radius and 2° tiles."""

import hashlib
import json
import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from itertools import pairwise
from typing import Any

from scintille_contract.models import StormSummary

EARTH_KM = 6371.0
KM_PER_DEG = math.pi * EARTH_KM / 180
TILE_DEG = 2
ROWS = 180 // TILE_DEG
COLS = 360 // TILE_DEG
#: Covers the bulge of hourly great-circle arcs beyond their endpoints' box.
ARC_MARGIN_KM = 10.0
#: Replays live 60 days (R2 lifecycle); search keeps two days less.
RETENTION = timedelta(days=58)
DAY = 86400


def _wrap(lon: float) -> float:
    return ((lon + 180) % 360 + 360) % 360 - 180


def _row(lat: float) -> int:
    return min(ROWS - 1, max(0, math.floor((lat + 90) / TILE_DEG)))


def _col(lon: float) -> int:
    return math.floor((_wrap(lon) + 180) / TILE_DEG) % COLS


def tile_of(lat: float, lon: float) -> int:
    return _row(lat) * COLS + _col(lon)


def _box_tiles(south: float, north: float, west: float, east: float) -> set[int]:
    """Tiles of a box whose longitudes may run past ±180."""
    rows = range(_row(max(-90.0, south)), _row(min(90.0, north)) + 1)
    if east - west >= 360 or max(abs(south), abs(north)) >= 89.9:
        cols: Iterable[int] = range(COLS)
    else:
        first = math.floor((west + 180) / TILE_DEG)
        last = math.floor((east + 180) / TILE_DEG)
        cols = {c % COLS for c in range(first, last + 1)}
    return {r * COLS + c for r in rows for c in cols}


def query_tiles(lat: float, lon: float, km: float) -> list[int]:
    """Tiles of the box around a disc of `km` around a point; the Worker has the same function."""
    d_lat = km / KM_PER_DEG
    south, north = max(-90.0, lat - d_lat), min(90.0, lat + d_lat)
    widest = max(abs(south), abs(north))
    d_lon = 180.0 if widest >= 89.9 else km / (KM_PER_DEG * math.cos(math.radians(widest)))
    if d_lon >= 180:
        return sorted(_box_tiles(south, north, -180.0, 180.0 + 360))
    return sorted(_box_tiles(south, north, lon - d_lon, lon + d_lon))


def path_tiles(path: Sequence[tuple[float, float]], radius_km: float) -> set[int]:
    """Tiles met by the path's points and arcs, each widened by the storm radius."""
    reach = radius_km + ARC_MARGIN_KM
    tiles: set[int] = set()
    segments = list(pairwise(path)) or [(path[0], path[0])]
    for (lat_a, lon_a), (lat_b, lon_b) in segments:
        lon_b = lon_a + _wrap(lon_b - lon_a)
        d_lat = reach / KM_PER_DEG
        south, north = min(lat_a, lat_b) - d_lat, max(lat_a, lat_b) + d_lat
        widest = min(90.0, max(abs(south), abs(north)))
        d_lon = 360.0 if widest >= 89.9 else reach / (KM_PER_DEG * math.cos(math.radians(widest)))
        tiles |= _box_tiles(south, north, min(lon_a, lon_b) - d_lon, max(lon_a, lon_b) + d_lon)
    return tiles


def days(t_start: datetime, t_end: datetime) -> range:
    """UTC days, as days since the epoch, from the storm's start to its end."""
    return range(int(t_start.timestamp()) // DAY, int(t_end.timestamp()) // DAY + 1)


def score(storm: StormSummary) -> float:
    """ADR 0009 score: square root of flashes times peak rate."""
    return math.sqrt(storm.flashes * storm.peak_rate)


@dataclass(frozen=True)
class SearchRow:
    slug: str
    t_start: int
    t_end: int
    level: int
    score: float
    summary: str
    path: str
    radius_km: float
    tiles: tuple[tuple[int, int], ...]
    digest: str

    def values(self) -> dict[str, Any]:
        return {
            "slug": self.slug,
            "t_start": self.t_start,
            "t_end": self.t_end,
            "level": self.level,
            "score": self.score,
            "summary": self.summary,
            "path": self.path,
            "radius_km": self.radius_km,
            "digest": self.digest,
        }


def search_row(storm: StormSummary, track: Sequence[dict[str, Any]]) -> SearchRow:
    points = sorted(track, key=lambda point: point["time"])
    if not points:
        raise ValueError(f"storm without track: {storm.slug}")
    path = [(round(p["lat"], 3), round(p["lon"], 3)) for p in points]
    area = max((p.get("area_km2") or 0.0) for p in points)
    radius = round(math.sqrt(area / math.pi), 1)
    tiles = tuple(
        sorted(
            (day, tile)
            for day in days(storm.t_start, storm.t_end)
            for tile in path_tiles(path, radius)
        )
    )
    summary = storm.model_dump_json()
    path_json = json.dumps(path, separators=(",", ":"))
    digest = hashlib.sha256(
        "\n".join([summary, path_json, str(radius), json.dumps(tiles)]).encode()
    ).hexdigest()[:16]
    return SearchRow(
        slug=storm.slug,
        t_start=int(storm.t_start.timestamp()),
        t_end=int(storm.t_end.timestamp()),
        level=storm.level,
        score=round(score(storm), 3),
        summary=summary,
        path=path_json,
        radius_km=radius,
        tiles=tiles,
        digest=digest,
    )


def retained(storm: StormSummary, now: datetime) -> bool:
    return storm.t_start >= now.astimezone(UTC) - RETENTION
