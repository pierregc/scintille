"""Static ownership mask: each point belongs to the instrument with the best view of it."""

from dataclasses import dataclass
from typing import Any

import numpy as np
from numpy.typing import ArrayLike, NDArray
from shapely import Polygon, box
from shapely.geometry.base import BaseGeometry
from shapely.geometry.polygon import orient

from scintille_contract.models import Source

MASK_VERSION = 2
"""Bump whenever SATELLITES changes, then run `scintille-contract generate`."""


@dataclass(frozen=True)
class Satellite:
    source: Source
    subpoint_lon: float
    coverage_deg: float
    """Max central angle (deg) from the sub-satellite point where flashes are reported."""


# GLM: sub-points from `nominal_satellite_subpoint_lon`, coverage from 30 days of data.
# MTG LI: coverage from the committed 10 min sample (farthest flash at 79.95°).
SATELLITES: tuple[Satellite, ...] = (
    Satellite("glm-east", -75.2, 67.0),
    Satellite("glm-west", -137.0, 67.0),
    Satellite("mtg-li", 0.0, 80.0),
)


def central_angle(lat: ArrayLike, lon: ArrayLike, subpoint_lon: float) -> NDArray[np.float64]:
    """Great-circle angle (deg) between points and a sub-satellite point on the equator."""
    cos = np.cos(np.radians(lat)) * np.cos(np.radians(np.asarray(lon) - subpoint_lon))
    angle: NDArray[np.float64] = np.degrees(np.arccos(np.clip(cos, -1.0, 1.0)))
    return angle


def owner_index(
    lat: ArrayLike, lon: ArrayLike, satellites: tuple[Satellite, ...] = SATELLITES
) -> NDArray[np.int64]:
    """Index in `satellites` of the owner of each point, -1 where none sees it.

    For geostationary instruments the smallest central angle is the best viewing angle.
    """
    angles = np.stack([central_angle(lat, lon, s.subpoint_lon) for s in satellites])
    limits = np.array([s.coverage_deg for s in satellites]).reshape(-1, *[1] * (angles.ndim - 1))
    seen = angles <= limits
    best = np.argmin(np.where(seen, angles, np.inf), axis=0)
    return np.where(seen.any(axis=0), best, -1)


def owners(
    lat: ArrayLike, lon: ArrayLike, satellites: tuple[Satellite, ...] = SATELLITES
) -> list[Source | None]:
    names = [s.source for s in satellites]
    return [names[i] if i >= 0 else None for i in owner_index(lat, lon, satellites).tolist()]


def zone(satellite: int, satellites: tuple[Satellite, ...] = SATELLITES) -> list[Polygon]:
    """Owned zone in the lon/lat plane, longitudes unwrapped around the sub-point.

    The field of view minus, for every other satellite, the part of its field of view on its side
    of the meridian halfway between the two sub-points.
    """
    sat = satellites[satellite]
    owned: BaseGeometry = Polygon(_cap(sat.subpoint_lon, sat.coverage_deg))
    for j, other in enumerate(satellites):
        if j == satellite:
            continue
        lon = other.subpoint_lon - 360.0 * round((other.subpoint_lon - sat.subpoint_lon) / 360.0)
        west = (lon + sat.subpoint_lon) / 2 - (0.0 if lon > sat.subpoint_lon else 180.0)
        side = box(west, -90, west + 180, 90)
        owned = owned.difference(Polygon(_cap(lon, other.coverage_deg)).intersection(side))
    parts = [p for p in getattr(owned, "geoms", [owned]) if isinstance(p, Polygon) and p.area > 0]
    if any(p.interiors for p in parts):
        raise ValueError(f"{sat.source} zone has a hole, not supported")
    return [orient(p) for p in parts]


def geojson(satellites: tuple[Satellite, ...] = SATELLITES) -> dict[str, Any]:
    """One MultiPolygon per owner, split at the antimeridian (RFC 7946)."""
    features = [
        {
            "type": "Feature",
            "properties": {
                "source": s.source,
                "subpoint_lon": s.subpoint_lon,
                "coverage_deg": s.coverage_deg,
            },
            "geometry": {
                "type": "MultiPolygon",
                "coordinates": [
                    [[[round(x, 3), round(y, 3)] for x, y in part]]
                    for polygon in zone(i, satellites)
                    for part in _split_antimeridian([(x, y) for x, y in polygon.exterior.coords])
                ],
            },
        }
        for i, s in enumerate(satellites)
    ]
    return {"type": "FeatureCollection", "mask_version": MASK_VERSION, "features": features}


def _cap(subpoint_lon: float, coverage_deg: float, step_deg: float = 0.5) -> NDArray[np.float64]:
    azimuths = np.radians(np.arange(0.0, 360.0, step_deg))
    lat, lon = _destination(subpoint_lon, azimuths, np.full_like(azimuths, coverage_deg))
    return np.column_stack([lon, lat])


def _destination(
    lon0: float, azimuth: NDArray[np.float64], distance_deg: NDArray[np.float64]
) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    d = np.radians(distance_deg)
    lat = np.arcsin(np.sin(d) * np.cos(azimuth))
    lon = lon0 + np.degrees(np.arctan2(np.sin(azimuth) * np.sin(d), np.cos(d)))
    return np.degrees(lat), lon


def _split_antimeridian(ring: list[tuple[float, float]]) -> list[list[tuple[float, float]]]:
    parts = []
    for shift in (-360.0, 0.0, 360.0):
        moved = [(x + shift, y) for x, y in ring]
        clipped = _clip(_clip(moved, -180.0, keep_above=True), 180.0, keep_above=False)
        if len(clipped) >= 3:
            parts.append([*clipped, clipped[0]])
    return parts


def _clip(
    ring: list[tuple[float, float]], lon: float, *, keep_above: bool
) -> list[tuple[float, float]]:
    """Sutherland-Hodgman against one meridian, in the lon/lat plane."""

    def inside(p: tuple[float, float]) -> bool:
        return p[0] >= lon if keep_above else p[0] <= lon

    out: list[tuple[float, float]] = []
    points = ring[:-1] if ring and ring[0] == ring[-1] else ring
    for i, current in enumerate(points):
        previous = points[i - 1]
        if inside(current) != inside(previous):
            t = (lon - previous[0]) / (current[0] - previous[0])
            out.append((lon, previous[1] + t * (current[1] - previous[1])))
        if inside(current):
            out.append(current)
    return out
