import json
import math
import os
import random
from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np
import pytest
from scintille_contract.models import StormSummary
from scintille_pipelines.storm_search import (
    COLS,
    EARTH_KM,
    days,
    path_tiles,
    query_tiles,
    retained,
    search_row,
    tile_of,
)

FIXTURE = Path(__file__).parents[4] / "fixtures" / "search" / "geometry.json"
T0 = datetime(2026, 10, 28, 22, 10, tzinfo=UTC)


def _unit(lat: float, lon: float) -> np.ndarray:
    phi, lam = math.radians(lat), math.radians(lon)
    return np.array([math.cos(phi) * math.cos(lam), math.cos(phi) * math.sin(lam), math.sin(phi)])


def brute_distance(lat: float, lon: float, path: list[tuple[float, float]], radius: float) -> float:
    """Reference: dense samples along each arc, by spherical interpolation."""
    p = _unit(lat, lon)
    best = math.inf
    vectors = [_unit(*point) for point in path]
    for a, b in zip(vectors, vectors[1:] or vectors, strict=False):
        omega = math.acos(min(1.0, float(a @ b)))
        for t in np.linspace(0, 1, 2001):
            if omega < 1e-12:
                v = a
            else:
                v = (math.sin((1 - t) * omega) * a + math.sin(t * omega) * b) / math.sin(omega)
            best = min(best, math.atan2(np.linalg.norm(np.cross(p, v)), float(p @ v)))
    return max(0.0, best * EARTH_KM - radius)


def storm(**changes: object) -> StormSummary:
    base = {
        "storm_id": "a1",
        "slug": "2026-10-28-lyon",
        "name": "Lyon",
        "label": "Lyon, Auvergne-Rhône-Alpes, France",
        "country_code": "FR",
        "t_start": T0,
        "t_end": T0 + timedelta(hours=3),
        "closed": True,
        "flashes": 400,
        "peak_rate": 16,
        "level": 4,
        "level_name": "Intense",
        "level_rule": "levels score=flashes_x_peak count=best_source thresholds=8,25,120,450",
        "sources": ["mtg-li"],
        "distance_km": 60.0,
    }
    return StormSummary.model_validate(base | changes)


def track(*points: tuple[float, float, float]) -> list[dict[str, object]]:
    return [
        {"time": T0 + timedelta(hours=i), "lat": lat, "lon": lon, "area_km2": area}
        for i, (lat, lon, area) in enumerate(points)
    ]


def test_tiles_wrap_and_clamp() -> None:
    assert tile_of(-90, -180) == 0
    assert tile_of(89.99, 179.99) == 90 * COLS - 1
    assert tile_of(90, 180) == tile_of(89.9, -180)
    assert tile_of(45.8, 4.8) == 67 * COLS + 92


def test_path_tiles_cross_the_date_line() -> None:
    tiles = path_tiles([(-17.8, 179.5), (-17.6, -179.6)], 5)
    assert {tile // COLS for tile in tiles} == {36}
    assert {tile % COLS for tile in tiles} == {179, 0}


def test_path_tiles_near_the_pole_take_the_whole_band() -> None:
    assert len(path_tiles([(89.95, 10.0)], 1)) == COLS


def test_query_tiles_at_high_latitude_widen_in_longitude() -> None:
    near_equator = query_tiles(0.5, 10.0, 200)
    north = query_tiles(69.5, 18.9, 200)
    assert len({t % COLS for t in north}) > len({t % COLS for t in near_equator})


def test_days_span_utc_midnight() -> None:
    assert list(days(T0, T0 + timedelta(hours=3))) == [20754, 20755]


def test_search_row_is_stable_and_bounded() -> None:
    row = search_row(storm(), track((45.7, 4.7, 400.0), (45.9, 5.0, 1200.0), (46.1, 5.3, 300.0)))
    assert row == search_row(
        storm(), track((45.7, 4.7, 400.0), (45.9, 5.0, 1200.0), (46.1, 5.3, 300.0))
    )
    assert row.radius_km == round(math.sqrt(1200 / math.pi), 1)
    assert row.score == 80.0
    assert {day for day, _ in row.tiles} == {20754, 20755}
    assert json.loads(row.summary)["slug"] == "2026-10-28-lyon"
    assert row.digest != search_row(storm(flashes=401), track((45.7, 4.7, 400.0))).digest


def test_search_row_needs_a_track() -> None:
    with pytest.raises(ValueError, match="without track"):
        search_row(storm(), [])


def test_retention_follows_replays() -> None:
    now = T0 + timedelta(days=58)
    assert retained(storm(), now)
    assert not retained(storm(), now + timedelta(minutes=1))


def cases() -> dict[str, object]:
    rng = random.Random(288)
    paths = []
    for _ in range(40):
        lat = rng.choice([rng.uniform(-60, 60), rng.uniform(60, 88), rng.uniform(-30, 30)])
        lon = rng.choice([rng.uniform(-180, 180), rng.uniform(175, 180)])
        points = [(lat, lon)]
        for _ in range(rng.randint(0, 6)):
            bearing = rng.uniform(0, 2 * math.pi)
            step = rng.uniform(0, 1.2)
            lat = max(-89.0, min(89.0, lat + step * math.cos(bearing)))
            lon = (
                (lon + step * math.sin(bearing) / max(0.05, math.cos(math.radians(lat)))) + 540
            ) % 360 - 180
            points.append((lat, lon))
        path = [(round(a, 3), round(b, 3)) for a, b in points]
        radius = round(rng.uniform(0, 60), 1)
        queries = []
        for _ in range(6):
            q_lat = max(-90.0, min(90.0, path[0][0] + rng.uniform(-6, 6)))
            q_lon = (path[0][1] + rng.uniform(-12, 12) + 540) % 360 - 180
            q_lat, q_lon = round(q_lat, 1), round(q_lon, 1)
            queries.append([q_lat, q_lon, round(brute_distance(q_lat, q_lon, path, radius), 3)])
        paths.append(
            {
                "path": path,
                "radius_km": radius,
                "tiles": sorted(path_tiles(path, radius)),
                "queries": queries,
            }
        )
    grid = [
        (lat, lon)
        for lat in (-89.95, -45.8, 0.0, 45.8, 69.5, 88.0)
        for lon in (-180, -0.1, 4.8, 179.9)
    ]
    return {
        "tile_of": [[lat, lon, tile_of(lat, lon)] for lat, lon in grid],
        "query_tiles": [
            [lat, lon, km, query_tiles(lat, lon, km)] for lat, lon in grid for km in (10, 200, 500)
        ],
        "paths": paths,
    }


def test_shared_geometry_fixture_is_current() -> None:
    expected = json.dumps(cases(), separators=(",", ":")) + "\n"
    if os.environ.get("SCINTILLE_REGENERATE"):
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(expected)
    assert FIXTURE.read_text() == expected, "run with SCINTILLE_REGENERATE=1"


def test_a_storm_within_reach_shares_a_tile_with_the_query() -> None:
    for case in json.loads(FIXTURE.read_text())["paths"]:
        tiles = set(case["tiles"])
        for lat, lon, distance in case["queries"]:
            for km in (10, 200, 500):
                if distance <= km:
                    assert tiles & set(query_tiles(lat, lon, km)), (case["path"], lat, lon, km)
