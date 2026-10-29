import json
import math
import os
import random
import sqlite3
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from scintille_contract.models import StormSummary
from scintille_pipelines.storm_search import (
    COARSE,
    DAILY_ROWS,
    EARTH_KM,
    FINE,
    STATE_PATH,
    D1Rest,
    Result,
    State,
    centroid,
    days,
    path_tiles,
    published_sample,
    query_tiles,
    reconcile,
    retained,
    search_row,
    sync_search,
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
    t = np.linspace(0, 1, 2001)[:, None]
    for a, b in zip(vectors, vectors[1:] or vectors, strict=False):
        omega = math.acos(min(1.0, float(a @ b)))
        if omega < 1e-12:
            samples = a[None, :]
        else:
            samples = (np.sin((1 - t) * omega) * a + np.sin(t * omega) * b) / math.sin(omega)
        angles = np.arctan2(np.linalg.norm(np.cross(samples, p), axis=1), samples @ p)
        best = min(best, float(angles.min()))
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


def track(*points: tuple[float, float, float]) -> list[dict[str, Any]]:
    return [
        {"time": T0 + timedelta(hours=i), "lat": lat, "lon": lon, "area_km2": area}
        for i, (lat, lon, area) in enumerate(points)
    ]


class FakeD1:
    """D1 stand-in: SQLite runs the same statements, one transaction per call."""

    def __init__(self) -> None:
        self.db = sqlite3.connect(":memory:", isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.calls = 0
        self.fail_on: int | None = None

    def run(self, statements: Sequence[tuple[str, Sequence[str]]]) -> list[Result]:
        self.calls += 1
        if self.fail_on == self.calls:
            raise OSError("connection reset")
        results = []
        self.db.execute("BEGIN")
        try:
            for sql, params in statements:
                before = self.db.total_changes
                rows = [dict(row) for row in self.db.execute(sql, list(params)).fetchall()]
                results.append(Result(rows, len(rows), self.db.total_changes - before))
        except Exception:
            self.db.execute("ROLLBACK")
            raise
        self.db.execute("COMMIT")
        return results

    def table(self, sql: str) -> list[tuple[Any, ...]]:
        return [tuple(row) for row in self.db.execute(sql).fetchall()]


class Store:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def put(self, path: str, data: bytes, headers: dict[str, str]) -> None:
        self.objects[path] = data

    def get(self, path: str) -> bytes | None:
        return self.objects.get(path)


def test_grids_wrap_and_clamp() -> None:
    assert FINE.tile(-90, -180) == 0
    assert FINE.tile(89.99, 179.99) == 90 * 180 - 1
    assert FINE.tile(90, 180) == FINE.tile(89.9, -180)
    assert FINE.tile(45.8, 4.8) == 67 * 180 + 92
    assert COARSE.tile(45.8, 4.8) == 20_000 + 13 * 36 + 18


def test_path_tiles_cross_the_date_line() -> None:
    tiles = path_tiles([(-17.8, 179.5), (-17.6, -179.6)], 5, FINE)
    assert {tile // 180 for tile in tiles} == {36}
    assert {tile % 180 for tile in tiles} == {179, 0}


def test_path_tiles_near_the_pole_take_the_whole_band() -> None:
    assert len(path_tiles([(89.95, 10.0)], 1, FINE)) == 180
    assert len(path_tiles([(89.95, 10.0)], 1, COARSE)) == 36


def test_query_tiles_widen_in_longitude_and_switch_grid_past_500_km() -> None:
    assert len(query_tiles(69.5, 18.9, 200)) > len(query_tiles(0.5, 10.0, 200))
    assert max(query_tiles(45.8, 4.8, 500)) < 20_000
    coarse = query_tiles(45.8, 4.8, 3000)
    assert min(coarse) >= 20_000 and len(coarse) < 150


def test_days_span_utc_midnight() -> None:
    assert list(days(T0, T0 + timedelta(hours=3))) == [20754, 20755]


def test_search_row_is_stable_and_bounded() -> None:
    points = ((45.7, 4.7, 400.0), (45.9, 5.0, 1200.0), (46.1, 5.3, 300.0))
    row = search_row(storm(), track(*points))
    assert row == search_row(storm(), track(*points))
    assert row.radius_km == round(math.sqrt(1200 / math.pi), 1)
    assert row.score == 80.0
    assert {day for day, _ in row.tiles} == {20754, 20755}
    assert {tile >= 20_000 for _, tile in row.tiles} == {True, False}
    assert json.loads(row.summary)["slug"] == "2026-10-28-lyon"
    assert row.digest != search_row(storm(flashes=401), track(*points)).digest


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
            east = step * math.sin(bearing) / max(0.05, math.cos(math.radians(lat)))
            lon = (lon + east + 540) % 360 - 180
            points.append((lat, lon))
        path = [(round(a, 3), round(b, 3)) for a, b in points]
        radius = round(rng.uniform(0, 60), 1)
        queries = []
        for _ in range(6):
            spread = rng.choice([6, 30])
            q_lat = round(max(-90.0, min(90.0, path[0][0] + rng.uniform(-spread, spread))), 1)
            q_lon = round((path[0][1] + rng.uniform(-2 * spread, 2 * spread) + 540) % 360 - 180, 1)
            queries.append([q_lat, q_lon, round(brute_distance(q_lat, q_lon, path, radius), 3)])
        tiles = path_tiles(path, radius, FINE) | path_tiles(path, radius, COARSE)
        paths.append(
            {"path": path, "radius_km": radius, "tiles": sorted(tiles), "queries": queries}
        )
    lats = (-89.95, -45.8, 0.0, 45.8, 69.5, 88.0)
    grid = [(lat, lon) for lat in lats for lon in (-180, -0.1, 4.8, 179.9)]
    return {
        "tile_of": [[lat, lon, FINE.tile(lat, lon), COARSE.tile(lat, lon)] for lat, lon in grid],
        "query_tiles": [
            [lat, lon, km, query_tiles(lat, lon, km)]
            for lat, lon in grid
            for km in (10, 200, 500, 3000)
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
            for km in (10, 200, 500, 3000):
                if distance <= km:
                    assert tiles & set(query_tiles(lat, lon, km)), (case["path"], lat, lon, km)


NOW = T0 + timedelta(hours=4)


def catalog() -> tuple[list[StormSummary], dict[str, list[dict[str, Any]]]]:
    storms = [
        storm(),
        storm(
            storm_id="b2",
            slug="2026-10-28-fiji",
            t_start=T0 - timedelta(hours=30),
            t_end=T0 - timedelta(hours=27),
        ),
        storm(
            storm_id="c3",
            slug="2026-08-01-old",
            t_start=T0 - timedelta(days=80),
            t_end=T0 - timedelta(days=80),
        ),
    ]
    tracks = {
        "a1": track((45.7, 4.7, 400.0), (45.9, 5.0, 1200.0)),
        "b2": track((-17.8, 179.5, 900.0), (-17.6, -179.6, 900.0)),
        "c3": track((10.0, 10.0, 100.0)),
    }
    return storms, tracks


def test_sync_upserts_published_storms_within_retention() -> None:
    d1, store = FakeD1(), Store()
    storms, tracks = catalog()
    metrics = sync_search(store, d1, storms, tracks, NOW)
    assert metrics["search_upserted"] == 2 and metrics["search_pending"] == 0
    assert d1.table("SELECT slug FROM storms ORDER BY slug") == [
        ("2026-10-28-fiji",),
        ("2026-10-28-lyon",),
    ]
    (summary_json,) = d1.table("SELECT summary FROM storms WHERE slug = '2026-10-28-lyon'")[0]
    summary = json.loads(summary_json)
    assert summary == json.loads(storms[0].model_dump_json())
    tiles = d1.table("SELECT DISTINCT tile FROM storm_tiles WHERE slug = '2026-10-28-fiji'")
    assert {t % 180 for (t,) in tiles if t < 20_000} == {179, 0}
    meta = dict(d1.table("SELECT key, value FROM meta"))
    assert meta["last_observation_time"] == "2026-10-29T01:10:00Z" and meta["pending"] == "0"


def test_sync_writes_only_changes_and_removes_expired_storms() -> None:
    d1, store = FakeD1(), Store()
    storms, tracks = catalog()
    sync_search(store, d1, storms, tracks, NOW)
    tiles_before = d1.table("SELECT * FROM storm_tiles WHERE slug = '2026-10-28-lyon'")
    again = sync_search(store, d1, storms, tracks, NOW)
    assert again["search_upserted"] == 0 and again["search_deleted"] == 0
    moved = {**tracks, "a1": track((45.7, 4.7, 400.0), (46.5, 6.5, 1200.0))}
    changed = sync_search(store, d1, storms, moved, NOW)
    assert changed["search_upserted"] == 1
    assert d1.table("SELECT * FROM storm_tiles WHERE slug = '2026-10-28-lyon'") != tiles_before
    later = sync_search(store, d1, storms, moved, T0 + timedelta(days=58) - timedelta(hours=1))
    assert later["search_deleted"] == 1
    assert d1.table("SELECT slug FROM storms") == [("2026-10-28-lyon",)]
    assert d1.table("SELECT DISTINCT slug FROM storm_tiles") == [("2026-10-28-lyon",)]


def test_an_interrupted_sync_resumes_without_duplicates() -> None:
    d1, store = FakeD1(), Store()
    storms, tracks = catalog()
    d1.fail_on = 5
    with pytest.raises(OSError):
        sync_search(store, d1, storms, tracks, NOW)
    state = State.load(store.objects[STATE_PATH])
    assert state is not None and len(state.storms) == 2
    d1.fail_on = None
    assert sync_search(store, d1, storms, tracks, NOW)["search_upserted"] == 0


def test_a_lost_state_is_rebuilt_from_d1() -> None:
    d1, store = FakeD1(), Store()
    storms, tracks = catalog()
    sync_search(store, d1, storms, tracks, NOW)
    d1.db.execute("INSERT INTO storm_tiles VALUES (1, 2, 'orphan')")
    del store.objects[STATE_PATH]
    rebuilt = reconcile(d1, page=2)
    assert set(rebuilt.storms) == {"2026-10-28-fiji", "2026-10-28-lyon", "orphan"}
    metrics = sync_search(store, d1, storms, tracks, NOW)
    assert metrics["search_upserted"] == 0 and metrics["search_deleted"] == 1
    assert d1.table("SELECT count(*) FROM storm_tiles WHERE slug = 'orphan'") == [(0,)]


def test_the_daily_budget_defers_older_storms(monkeypatch: pytest.MonkeyPatch) -> None:
    d1, store = FakeD1(), Store()
    storms, tracks = catalog()
    lyon = search_row(storms[0], tracks["a1"])
    monkeypatch.setattr("scintille_pipelines.storm_search.DAILY_ROWS", 1 + len(lyon.tiles) + 3)
    first = sync_search(store, d1, storms, tracks, NOW)
    assert first["search_upserted"] == 1 and first["search_pending"] == 1
    assert d1.table("SELECT slug FROM storms") == [("2026-10-28-lyon",)]
    assert dict(d1.table("SELECT key, value FROM meta"))["pending"] == "1"
    monkeypatch.setattr("scintille_pipelines.storm_search.DAILY_ROWS", DAILY_ROWS)
    assert sync_search(store, d1, storms, tracks, NOW + timedelta(days=1))["search_pending"] == 0


def test_storms_without_tracks_are_counted_not_indexed() -> None:
    d1, store = FakeD1(), Store()
    storms, tracks = catalog()
    del tracks["a1"]
    assert sync_search(store, d1, storms, tracks, NOW)["search_missing_tracks"] == 1


def test_d1_rest_needs_a_token_and_an_account() -> None:
    assert D1Rest.from_env({}) is None
    assert D1Rest.from_env({"SCINTILLE_D1_TOKEN": "x"}) is None


def test_a_published_sample_loads_like_the_catalog_run(monkeypatch: pytest.MonkeyPatch) -> None:
    root = Path(__file__).parents[4] / "fixtures"
    monkeypatch.setattr(
        "scintille_pipelines.storm_search._fetch",
        lambda url: (root / url.removeprefix("https://data.test/")).read_bytes(),
    )
    summaries, tracks = published_sample("https://data.test", datetime(2026, 7, 15, tzinfo=UTC))
    assert [s.slug for s in summaries] == ["2026-07-15-orlando"]
    d1, store = FakeD1(), Store()
    now = datetime(2026, 7, 16, tzinfo=UTC)
    assert sync_search(store, d1, summaries, tracks, now)["search_upserted"] == 1
    assert published_sample("https://data.test", datetime(2026, 7, 16, tzinfo=UTC))[0] == []


def test_the_centroid_bounds_every_point_across_the_date_line() -> None:
    path = [(-17.8, 179.5), (-17.6, -179.6), (-17.2, -178.9)]
    c_lat, c_lon, spread = centroid(path)
    assert abs(abs(c_lon) - 180) < 1 and -18 < c_lat < -17
    assert all(brute_distance(c_lat, c_lon, [p], 0) <= spread for p in path)
    assert centroid([(45.8, 4.8)]) == (45.8, 4.8, 0.0)
