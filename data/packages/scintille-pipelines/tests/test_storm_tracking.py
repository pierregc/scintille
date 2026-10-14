from datetime import UTC, datetime, timedelta
from itertools import pairwise
from pathlib import Path

import numpy as np
import polars as pl
import pyarrow as pa
import pytest
from dagster import AssetKey, DagsterInstance, materialize
from pyiceberg.catalog import Catalog
from pyiceberg.catalog.sql import SqlCatalog
from scintille_lake.migrate import migrate
from scintille_lake.tables import FLASHES
from scintille_pipelines.clustering import KM_PER_DEGREE, Params
from scintille_pipelines.definitions import defs
from scintille_pipelines.resources import LakeResource
from scintille_pipelines.storm_cells import range_cells, storm_cells
from scintille_pipelines.storm_levels import STORM_LEVELS, StormLevelsConfig, storm_levels
from scintille_pipelines.storms import STORM_TRACKS, STORMS, check_storms, storm_tracks, storms
from scintille_pipelines.tracking import (
    TRACK_SCHEMA,
    TrackParams,
    link,
    summarize_storms,
    track_range,
)

PARAMS = Params(eps_km=10, eps_minutes=10, min_pts=10)
TRACK = TrackParams(max_speed_kmh=100, max_gap_minutes=30)
T0 = datetime(2026, 7, 15, 18, tzinfo=UTC)
HOUR = timedelta(hours=1)
OVERLAP = timedelta(minutes=30)
rng = np.random.default_rng(11)


def flashes(
    n: int,
    lat: float,
    lon: float,
    start: datetime = T0,
    minutes: float = 30,
    speed_kmh: tuple[float, float] = (0, 0),
    sigma_km: float = 2,
) -> pl.DataFrame:
    """Flashes of a Gaussian cell drifting at `speed_kmh` (east, north)."""
    offsets = np.sort(rng.uniform(0, minutes * 60, n))
    hours = offsets / 3600
    north = rng.normal(0, sigma_km, n) + speed_kmh[1] * hours
    east = rng.normal(0, sigma_km, n) + speed_kmh[0] * hours
    lats = lat + north / KM_PER_DEGREE
    lons = lon + east / (KM_PER_DEGREE * np.cos(np.radians(lat)))
    return pl.DataFrame(
        {
            "flash_id": [f"{rng.integers(2**62):032x}" for _ in range(n)],
            "source": "glm-east",
            "event_time": pl.Series(
                [start + timedelta(seconds=s) for s in offsets], dtype=pl.Datetime("us", "UTC")
            ),
            "lat": lats,
            "lon": (lons + 180) % 360 - 180,
        }
    )


def tracked(df: pl.DataFrame, hours: int = 3) -> pl.DataFrame:
    cells = range_cells(df, T0, T0 + hours * HOUR, OVERLAP, PARAMS)
    return track_range(pl.DataFrame(schema=TRACK_SCHEMA), cells, T0, T0 + hours * HOUR, TRACK)


def test_moving_cell_is_one_storm_with_its_track() -> None:
    n = 1500
    df = flashes(n, -30, -60, start=T0 + timedelta(minutes=20), minutes=150, speed_kmh=(60, 20))
    tracks = tracked(df)
    assert tracks["storm_id"].n_unique() == 1
    storm = summarize_storms(tracks, T0 + 3 * HOUR).row(0, named=True)
    assert storm["steps"] == 3
    assert storm["storm_id"] == tracks["cell_id"][0]
    assert 0.95 * n <= storm["flash_count"] <= n
    track = storm["track"]
    assert [p["time"] for p in track] == sorted(p["time"] for p in track)
    for a, b in pairwise(track):
        hours = (b["time"] - a["time"]).total_seconds() / 3600
        east = (b["lon"] - a["lon"]) * KM_PER_DEGREE * np.cos(np.radians(-30)) / hours
        north = (b["lat"] - a["lat"]) * KM_PER_DEGREE / hours
        assert east == pytest.approx(60, abs=12)
        assert north == pytest.approx(20, abs=12)
    assert storm["west"] < storm["lon"] < storm["east"]
    assert storm["closed"]


def test_storm_still_active_is_not_closed() -> None:
    tracks = tracked(flashes(400, 10, -40, start=T0 + timedelta(minutes=40), minutes=60), 2)
    storm = summarize_storms(tracks, T0 + HOUR).row(0, named=True)
    assert storm["steps"] == 2 and not storm["closed"]


def test_separate_and_successive_storms() -> None:
    df = pl.concat(
        [
            flashes(300, 0, -50, start=T0 + timedelta(minutes=30), minutes=60),
            flashes(300, 0, -45, start=T0 + timedelta(minutes=30), minutes=60),
            flashes(200, 0, -50, start=T0 + timedelta(minutes=150), minutes=20),
        ]
    )
    storms = summarize_storms(tracked(df), T0 + 3 * HOUR)
    assert storms["flash_count"].sort().to_list() == [200, 300, 300]


def test_moving_cell_across_the_antimeridian() -> None:
    df = flashes(900, -15, 179.6, start=T0 + timedelta(minutes=30), minutes=120, speed_kmh=(60, 0))
    tracks = tracked(df)
    assert tracks["storm_id"].n_unique() == 1
    storm = summarize_storms(tracks, T0 + 3 * HOUR).row(0, named=True)
    assert storm["west"] > storm["east"]
    assert storm["track"][0]["lon"] > 0
    assert storm["track"][-1]["lon"] < 0


def cell_row(
    cell_id: str,
    window: datetime,
    lat: float,
    lon: float,
    flash_count: int,
    radius_km: float = 10,
) -> dict[str, object]:
    d = radius_km / KM_PER_DEGREE
    return {
        "cell_id": cell_id,
        "window_start": window,
        "window_end": window + HOUR,
        "t_start": window - timedelta(minutes=20),
        "t_end": window + timedelta(minutes=20),
        "flash_count": flash_count,
        "hour_flash_count": flash_count // 2,
        "lat": lat,
        "lon": lon,
        "west": lon - d,
        "south": lat - d,
        "east": lon + d,
        "north": lat + d,
        "area_km2": np.pi * radius_km**2,
        "hull": f"POLYGON(({lon - d} {lat - d}, {lon + d} {lat - d}, {lon + d} {lat + d}, "
        f"{lon - d} {lat - d}))",
        "sources": ["glm-east"],
    }


def cells(*rows: dict[str, object]) -> pl.DataFrame:
    return pl.DataFrame(list(rows)).with_columns(
        pl.col("window_start", "window_end", "t_start", "t_end").cast(pl.Datetime("us", "UTC"))
    )


def test_split_keeps_the_main_branch() -> None:
    first = link(pl.DataFrame(schema=TRACK_SCHEMA), cells(cell_row("a", T0, 0, -50, 300)), TRACK)
    hour = T0 + HOUR
    got = link(
        first, cells(cell_row("b", hour, 0, -50.1, 100), cell_row("c", hour, 0, -49.9, 400)), TRACK
    )
    by_cell = {r["cell_id"]: r for r in got.iter_rows(named=True)}
    assert by_cell["c"]["storm_id"] == "a" and by_cell["c"]["previous_cell_id"] == "a"
    assert by_cell["b"]["storm_id"] == "b" and by_cell["b"]["split_from"] == "a"
    assert by_cell["b"]["storm_start"] == hour


def test_merge_keeps_the_main_branch() -> None:
    prev = cells(cell_row("a", T0, 0, -50.1, 100), cell_row("b", T0, 0, -49.9, 400))
    first = link(pl.DataFrame(schema=TRACK_SCHEMA), prev, TRACK)
    got = link(first, cells(cell_row("c", T0 + HOUR, 0, -50, 600)), TRACK).row(0, named=True)
    assert got["storm_id"] == "b"
    assert got["merged"] == ["a"]
    assert got["split_from"] is None


def test_far_or_late_cells_start_new_storms() -> None:
    first = link(pl.DataFrame(schema=TRACK_SCHEMA), cells(cell_row("a", T0, 0, -50, 300)), TRACK)
    far = cell_row("b", T0 + HOUR, 0, -47, 300)
    late = cell_row("c", T0 + HOUR, 0, -50, 300)
    late["t_start"] = T0 + timedelta(minutes=55)
    got = link(first, cells(far, late), TRACK)
    assert got["storm_id"].to_list() == ["b", "c"]
    assert got["split_from"].to_list() == [None, None]


def test_check_flags_bad_storms() -> None:
    first = link(pl.DataFrame(schema=TRACK_SCHEMA), cells(cell_row("a", T0, 0, -50, 300)), TRACK)
    rows = summarize_storms(first, T0)
    assert check_storms(rows).passed
    assert not check_storms(pl.concat([rows, rows])).passed


def silver_rows(df: pl.DataFrame, schema: pa.Schema) -> pa.Table:
    full = df.with_columns(
        product_file=pl.lit("test.nc"),
        native_flash_id=pl.int_range(pl.len(), dtype=pl.Int64),
        ingest_time=pl.col("event_time"),
        energy_raw=pl.lit(1.0),
        energy_unit=pl.lit("J"),
        intensity=pl.lit(None, pl.Float32),
        area_km2=pl.lit(100.0, pl.Float32),
        duration_ms=pl.lit(200.0, pl.Float32),
        quality=pl.lit([], pl.List(pl.String)),
        parser_version=pl.lit("test"),
        calibration_version=pl.lit("test"),
    )
    return full.select(schema.names).to_arrow().cast(schema)


class SqliteLake(LakeResource):
    path: str

    def catalog(self) -> Catalog:
        return SqlCatalog(
            "test", uri=f"sqlite:///{self.path}/catalog.db", warehouse=f"file://{self.path}"
        )


@pytest.fixture
def lake(tmp_path: Path) -> SqliteLake:
    resource = SqliteLake(path=str(tmp_path))
    catalog = resource.catalog()
    migrate(catalog)
    table = catalog.load_table(FLASHES.identifier)
    df = pl.concat(
        [
            flashes(900, -30, -60, start=T0 + timedelta(minutes=20), minutes=90, speed_kmh=(60, 0)),
            flashes(200, 20, -100, start=T0 + timedelta(minutes=10), minutes=20),
        ]
    )
    table.append(silver_rows(df, table.schema().as_arrow()))
    return resource


NEW_CHAIN = {"ops": {"gold__storm_tracks": {"config": {"new_chain": True}}}}


def scan(lake: SqliteLake, identifier: tuple[str, str]) -> pl.DataFrame:
    df = pl.from_arrow(lake.catalog().load_table(identifier).scan().to_arrow())
    assert isinstance(df, pl.DataFrame)
    return df


def test_materializes_hour_after_hour_idempotently(lake: SqliteLake) -> None:
    instance = DagsterInstance.ephemeral()
    for key in ("2026-07-15-18:00", "2026-07-15-19:00", "2026-07-15-19:00", "2026-07-15-20:00"):
        result = materialize(
            [storm_cells, storm_tracks, storms],
            partition_key=key,
            resources={"lake": lake},
            instance=instance,
            run_config=NEW_CHAIN if key == "2026-07-15-18:00" else None,
        )
        assert result.success
        assert all(c.passed for c in result.get_asset_check_evaluations())
    tracks = scan(lake, STORM_TRACKS.identifier)
    assert tracks.height == 3
    rows = scan(lake, STORMS.identifier).sort("flash_count")
    assert rows["steps"].to_list() == [1, 2]
    assert rows["closed"].to_list() == [True, True]
    assert rows["flash_count"][0] == 200
    assert 0.95 * 900 <= rows["flash_count"][1] <= 900
    assert rows["params"][1] == "tracking max_speed_kmh=100 max_gap_minutes=30"


def test_fails_when_the_previous_hour_is_not_tracked(lake: SqliteLake) -> None:
    result = materialize(
        [storm_cells, storm_tracks],
        partition_key="2026-07-15-19:00",
        resources={"lake": lake},
        raise_on_error=False,
    )
    assert not result.success


def test_cells_count_their_hour_per_source_and_minute() -> None:
    east = flashes(400, -30, -60, start=T0 + timedelta(minutes=40), minutes=40)
    df = pl.concat([east, east.with_columns(source=pl.lit("glm-west"))]).sort("event_time")
    cells = range_cells(df, T0, T0 + timedelta(hours=2), OVERLAP, PARAMS)
    for row in cells.iter_rows(named=True):
        counts = pl.DataFrame(row["minute_counts"])
        assert counts["flashes"].sum() == row["hour_flash_count"]
        assert set(counts["source"]) == {"glm-east", "glm-west"}
        assert counts["minute"].min() >= row["window_start"]
        assert counts["minute"].max() < row["window_end"]


@pytest.fixture
def two_sources(tmp_path: Path) -> SqliteLake:
    resource = SqliteLake(path=str(tmp_path))
    catalog = resource.catalog()
    migrate(catalog)
    east = flashes(900, -30, -60, start=T0 + timedelta(minutes=20), minutes=90, speed_kmh=(60, 0))
    small = flashes(200, 20, -100, start=T0 + timedelta(minutes=10), minutes=20)
    df = pl.concat([east, east.head(500).with_columns(source=pl.lit("glm-west")), small])
    table = catalog.load_table(FLASHES.identifier)
    table.append(silver_rows(df, table.schema().as_arrow()))
    return resource


def run(
    lake: SqliteLake,
    instance: DagsterInstance,
    key: str,
    config: dict[str, object] | None = None,
) -> None:
    ops: dict[str, object] = {"gold__storm_levels": {"config": config or {}}}
    if key == "2026-07-15-18:00":
        ops |= NEW_CHAIN["ops"]
    result = materialize(
        [storm_cells, storm_tracks, storms, storm_levels],
        partition_key=key,
        resources={"lake": lake},
        instance=instance,
        run_config={"ops": ops},
    )
    assert result.success
    assert all(c.passed for c in result.get_asset_check_evaluations())


def test_materializes_levels_hour_after_hour(two_sources: SqliteLake) -> None:
    instance = DagsterInstance.ephemeral()
    run(two_sources, instance, "2026-07-15-18:00")
    first = scan(two_sources, STORM_LEVELS.identifier).sort("flashes")
    for key in ("2026-07-15-19:00", "2026-07-15-19:00", "2026-07-15-20:00"):
        run(two_sources, instance, key)
    rows = scan(two_sources, STORM_LEVELS.identifier).sort("flashes")
    assert rows["storm_id"].to_list() == first["storm_id"].to_list()
    assert rows["closed"].to_list() == [True, True]
    assert rows["level_source"].to_list() == ["glm-east", "glm-east"]
    assert rows["flashes"][0] == 200
    assert 0.95 * 900 <= rows["flashes"][1] <= 900
    assert (rows["level"] >= first["level"]).all()
    assert rows["level_rule"][0] == str(StormLevelsConfig().rule)

    run(
        two_sources,
        instance,
        "2026-07-15-20:00",
        {"score": "flashes", "thresholds": [100, 1000], "names": ["Light", "Moderate", "Strong"]},
    )
    changed = scan(two_sources, STORM_LEVELS.identifier).sort("flashes")
    assert changed["level"].to_list() == [2, 2]
    assert changed["level_name"].to_list() == ["Moderate", "Moderate"]


def test_registered_in_the_code_location() -> None:
    graph = defs.resolve_asset_graph()
    for name in ("storm_tracks", "storms"):
        assert graph.get(AssetKey(["gold", name])).pools == {"storm-tracks"}
