"""Coverage map: the usable field of view of each source and the area no source sees."""

from typing import Any

import numpy as np
from numpy.typing import ArrayLike, NDArray

from scintille_contract.models import SCHEMA_VERSION
from scintille_contract.ownership import (
    MASK_VERSION,
    SATELLITES,
    Satellite,
    _destination,
    _split_antimeridian,
)

type Ring = list[tuple[float, float]]

STEP_DEG = 0.5


def footprint_ring(sat: Satellite, step_deg: float = STEP_DEG) -> Ring:
    """Edge of the field of view, counterclockwise, longitudes unwrapped around the sub-point."""
    azimuths = np.radians(np.arange(360.0, 0.0, -step_deg))
    lat, lon = _destination(sat.subpoint_lon, azimuths, np.full_like(azimuths, sat.coverage_deg))
    ring = [(float(x), float(y)) for x, y in zip(lon, lat, strict=True)]
    return [*ring, ring[0]]


def half_width(lon: ArrayLike, satellites: tuple[Satellite, ...] = SATELLITES) -> NDArray[Any]:
    """Highest latitude seen at each longitude, -inf where no source sees the equator.

    Geostationary footprints are centred on the equator, so their union is symmetric about it.
    """
    lon = np.asarray(lon, dtype=np.float64)
    best = np.full(lon.shape, -np.inf)
    for sat in satellites:
        dlon = np.radians(_wrap(lon - sat.subpoint_lon))
        ratio = np.cos(np.radians(sat.coverage_deg)) / np.cos(dlon)
        seen = np.abs(dlon) <= np.radians(sat.coverage_deg)
        lat = np.degrees(np.arccos(np.clip(ratio, -1.0, 1.0)))
        best = np.maximum(best, np.where(seen, lat, -np.inf))
    return best


def covered_spans(satellites: tuple[Satellite, ...] = SATELLITES) -> list[tuple[float, float]]:
    """Longitude spans where some source sees the equator, start in [-180, 180), end > start.

    Empty when the sources see the whole equator.
    """
    spans = [(s.subpoint_lon - s.coverage_deg, s.subpoint_lon + s.coverage_deg) for s in satellites]
    gaps = [end for _, end in spans if half_width([end + 1e-6], satellites)[0] < 0]
    if not gaps:
        return []
    origin = gaps[0]
    merged: list[list[float]] = []
    for start, width in sorted((origin + (a - origin) % 360.0, b - a) for a, b in spans):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], start + width)
        else:
            merged.append([start, start + width])
    shifts = [float(_wrap(a)) - a for a, _ in merged]
    return sorted((a + shift, b + shift) for (a, b), shift in zip(merged, shifts, strict=True))


def geojson(satellites: tuple[Satellite, ...] = SATELLITES) -> dict[str, Any]:
    """`CoverageMap`: one footprint per satellite, then the no coverage area."""
    features = [
        _feature(
            {
                "kind": "footprint",
                "source": s.source,
                "subpoint_lon": s.subpoint_lon,
                "coverage_deg": s.coverage_deg,
            },
            [[part] for part in _split_antimeridian(footprint_ring(s))],
        )
        for s in satellites
    ]
    features.append(
        _feature(
            {"kind": "no-coverage", "source": None, "subpoint_lon": None, "coverage_deg": None},
            no_coverage(satellites),
        )
    )
    return {
        "type": "FeatureCollection",
        "schema_version": SCHEMA_VERSION,
        "mask_version": MASK_VERSION,
        "features": features,
    }


def no_coverage(satellites: tuple[Satellite, ...] = SATELLITES) -> list[list[Ring]]:
    """Polygons (outer ring, then holes) of the area no source sees."""
    spans = covered_spans(satellites)
    if not spans:
        lons = _boundary_lons(-180.0, 180.0, satellites)
        north = [*_edge(lons, satellites, 1), (180.0, 90.0), (-180.0, 90.0)]
        south = [(-180.0, -90.0), (180.0, -90.0), *_edge(lons[::-1], satellites, -1)]
        return [[_closed(north)], [_closed(south)]]
    shell: Ring = [(-180.0, -90.0), (180.0, -90.0)]
    west_edge: Ring = []
    holes: list[Ring] = []
    for a, b in spans:
        if b <= 180.0:
            lons = _boundary_lons(a, b, satellites)
            holes.append(
                _closed([*_edge(lons, satellites, 1), *_edge(lons[-2:0:-1], satellites, -1)])
            )
            continue
        east = _boundary_lons(a, 180.0, satellites)
        west = _boundary_lons(-180.0, b - 360.0, satellites)
        shell += [*_edge(east[::-1], satellites, -1), *_edge(east[1:], satellites, 1)]
        west_edge = [*_edge(west, satellites, 1), *_edge(west[-2::-1], satellites, -1)]
    shell += [(180.0, 90.0), (-180.0, 90.0), *west_edge]
    return [[_closed(shell), *holes]]


def _feature(properties: dict[str, Any], polygons: list[list[Ring]]) -> dict[str, Any]:
    return {
        "type": "Feature",
        "properties": properties,
        "geometry": {
            "type": "MultiPolygon",
            "coordinates": [[_rounded(ring) for ring in polygon] for polygon in polygons],
        },
    }


def _boundary_lons(a: float, b: float, satellites: tuple[Satellite, ...]) -> list[float]:
    """Longitudes in [a, b] of every footprint vertex, so edges match the footprints."""
    candidates = []
    for sat in satellites:
        lon = np.array([x for x, _ in footprint_ring(sat)])
        candidates += [lon - 360.0, lon, lon + 360.0]
    lons = np.concatenate(candidates)
    inside = np.unique(lons[(lons > a) & (lons < b)])
    return [a, *inside.tolist(), b]


def _edge(lons: list[float], satellites: tuple[Satellite, ...], sign: int) -> Ring:
    lat = np.maximum(half_width(lons, satellites), 0.0)
    return [(x, sign * float(y)) for x, y in zip(lons, lat, strict=True)]


def _closed(ring: Ring) -> Ring:
    return [*ring, ring[0]]


def _rounded(ring: Ring) -> list[list[float]]:
    out: list[list[float]] = []
    for x, y in ring:
        point = [round(x, 3) + 0.0, round(y, 3) + 0.0]
        if not out or out[-1] != point:
            out.append(point)
    return out


def _wrap(lon: Any) -> Any:
    return (np.asarray(lon) + 180.0) % 360.0 - 180.0
