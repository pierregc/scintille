from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np
import polars as pl
import pyarrow as pa
import pytest
from dagster import AssetKey, materialize
from pyiceberg.catalog import Catalog
from pyiceberg.catalog.sql import SqlCatalog
from scintille_lake.migrate import migrate
from scintille_lake.tables import FLASHES
from scintille_pipelines.clustering import KM_PER_DEGREE, Params, cell_id, st_dbscan, summarize
from scintille_pipelines.definitions import defs
from scintille_pipelines.resources import LakeResource
from scintille_pipelines.storm_cells import (
    STORM_CELLS,
    StormCellsConfig,
    check_cells,
    hour_cells,
    storm_cells,
)

PARAMS = Params(eps_km=10, eps_minutes=10, min_pts=10)
T0 = datetime(2026, 7, 15, 18, tzinfo=UTC)
rng = np.random.default_rng(7)


def cell(
    n: int,
    lat: float,
    lon: float,
    start: datetime = T0,
    minutes: float = 30,
    sigma_km: float = 3,
    speed_kmh: tuple[float, float] = (0, 0),
) -> pl.DataFrame:
    """Flashes of a Gaussian cell drifting at `speed_kmh` (east, north)."""
    offsets = np.sort(rng.uniform(0, minutes * 60, n))
    hours = offsets / 3600
    north = rng.normal(0, sigma_km, n) + speed_kmh[1] * hours
    east = rng.normal(0, sigma_km, n) + speed_kmh[0] * hours
    lats = lat + north / KM_PER_DEGREE
    lons = lon + east / (KM_PER_DEGREE * np.cos(np.radians(lat)))
    return frame(lats, (lons + 180) % 360 - 180, [start + timedelta(seconds=s) for s in offsets])


def frame(lats: np.ndarray, lons: np.ndarray, times: list[datetime]) -> pl.DataFrame:
    return pl.DataFrame(
        {
            "flash_id": [f"{rng.integers(2**62):032x}" for _ in times],
            "source": "glm-east",
            "event_time": pl.Series(times, dtype=pl.Datetime("us", "UTC")),
            "lat": np.asarray(lats, np.float64),
            "lon": np.asarray(lons, np.float64),
        }
    )


def noise(n: int, minutes: float = 60) -> pl.DataFrame:
    times = [T0 + timedelta(seconds=float(s)) for s in rng.uniform(0, minutes * 60, n)]
    return frame(rng.uniform(-10, 10, n), rng.uniform(-60, -40, n), times)


def labels(df: pl.DataFrame, params: Params = PARAMS) -> np.ndarray:
    t = df["event_time"].dt.epoch("us").to_numpy() / 1e6
    return st_dbscan(df["lat"].to_numpy(), df["lon"].to_numpy(), t, params)


def test_two_separate_cells() -> None:
    a, b = cell(200, 0, -50), cell(200, 0, -47)
    got = labels(pl.concat([a, b]))
    assert set(got[:200]) == {0} or set(got[:200]) == {1}
    assert set(got[200:]) == {1 - got[0]}


def test_one_moving_cell() -> None:
    moving = cell(400, -30, -60, minutes=120, sigma_km=2, speed_kmh=(60, 20))
    got = labels(moving)
    assert set(got) - {-1} == {0}
    assert (got == 0).mean() > 0.97


def test_noise_stays_noise() -> None:
    scattered = noise(300)
    assert (labels(scattered) == -1).all()
    got = labels(pl.concat([cell(100, 20, -100), scattered]))
    assert set(got[:100]) == {0}
    assert (got[100:] == -1).all()


def test_same_place_hours_apart() -> None:
    later = T0 + timedelta(hours=2)
    got = labels(pl.concat([cell(50, 10, -80), cell(50, 10, -80, start=later)]))
    assert list(np.unique(got[:50])) == [0]
    assert list(np.unique(got[50:])) == [1]


def test_min_pts_counts_the_flash_itself() -> None:
    tight = cell(10, 0, -50, minutes=5, sigma_km=0.5)
    assert set(labels(tight)) == {0}
    assert set(labels(tight.head(9))) == {-1}


def test_result_does_not_depend_on_input_order() -> None:
    df = pl.concat([cell(80, 0, -50), cell(80, 5, -50), noise(50)])
    shuffled = df.sample(fraction=1, shuffle=True, seed=3)
    expected = dict(zip(df["flash_id"], labels(df), strict=True))
    got = dict(zip(shuffled["flash_id"], labels(shuffled), strict=True))
    assert got == expected


def test_empty_input() -> None:
    assert len(labels(cell(0, 0, 0))) == 0


def test_cell_across_the_antimeridian() -> None:
    df = cell(200, -15, 179.98, sigma_km=4)
    assert (df["lon"] < 0).any() and (df["lon"] > 0).any()
    got = labels(df)
    assert set(got) - {-1} == {0}
    cells = summarize(df, got, T0, T0 + timedelta(hours=1), PARAMS)
    row = cells.row(0, named=True)
    assert row["west"] > row["east"]
    assert abs(abs(row["lon"]) - 180) < 0.1
    assert 0 < row["area_km2"] < 2000
    assert row["hull"].startswith("POLYGON((")


def test_summary_of_two_cells() -> None:
    df = pl.concat([cell(100, 0, -50), cell(60, 3, -50, start=T0 + timedelta(minutes=5))])
    got = labels(df)
    cells = summarize(df, got, T0, T0 + timedelta(hours=1), PARAMS)
    assert cells["flash_count"].to_list() == [100, 60]
    assert cells["sources"].to_list() == [["glm-east"], ["glm-east"]]
    first = cells.row(0, named=True)
    assert first["south"] < 0 < first["north"]
    assert abs(first["lat"]) < 0.1
    assert first["t_start"] == df["event_time"][:100].min()
    assert first["params"] == "st-dbscan eps_km=10 eps_minutes=10 min_pts=10"
    assert first["cell_id"] == cell_id(T0, str(df["flash_id"][:100].min()))
    assert summarize(df.head(0), got[:0], T0, T0, PARAMS).height == 0


def test_cells_inside_the_overlap_belong_to_the_previous_hour() -> None:
    hour = T0 + timedelta(hours=1)
    before = cell(50, 0, -50, start=hour - timedelta(minutes=25), minutes=10)
    across = cell(80, 5, -50, start=hour - timedelta(minutes=10), minutes=20)
    after_window = cell(50, 10, -50, start=hour + timedelta(hours=1), minutes=10)
    cells = hour_cells(
        pl.concat([before, across, after_window]), hour, timedelta(minutes=30), PARAMS
    )
    assert cells["flash_count"].to_list() == [80]
    assert cells["t_start"][0] < hour <= cells["t_end"][0]


def test_check_flags_bad_cells() -> None:
    df = pl.concat([cell(100, 0, -50, start=T0 + timedelta(minutes=10))])
    cells = summarize(df, labels(df), T0, T0 + timedelta(hours=1), PARAMS)
    assert check_cells(cells, 10).passed
    assert not check_cells(cells, 200).passed
    assert not check_cells(pl.concat([cells, cells]), 10).passed


class SqliteLake(LakeResource):
    path: str

    def catalog(self) -> Catalog:
        return SqlCatalog(
            "test", uri=f"sqlite:///{self.path}/catalog.db", warehouse=f"file://{self.path}"
        )


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


@pytest.fixture
def lake(tmp_path: Path) -> SqliteLake:
    resource = SqliteLake(path=str(tmp_path))
    catalog = resource.catalog()
    migrate(catalog)
    table = catalog.load_table(FLASHES.identifier)
    df = pl.concat(
        [
            cell(100, 0, -50, start=T0 + timedelta(minutes=10)),
            cell(100, 20, -100, start=T0 + timedelta(minutes=50), minutes=30),
            noise(50, minutes=120),
        ]
    )
    table.append(silver_rows(df, table.schema().as_arrow()))
    return resource


def stored(lake: SqliteLake) -> pl.DataFrame:
    rows = pl.from_arrow(lake.catalog().load_table(STORM_CELLS.identifier).scan().to_arrow())
    assert isinstance(rows, pl.DataFrame)
    return rows.sort("window_start", "t_start")


def test_materializes_hours_idempotently(lake: SqliteLake) -> None:
    for key in ("2026-07-15-18:00", "2026-07-15-19:00", "2026-07-15-19:00"):
        result = materialize([storm_cells], partition_key=key, resources={"lake": lake})
        assert result.success
        assert [c.passed for c in result.get_asset_check_evaluations()] == [True]
    rows = stored(lake)
    hours = [w.hour for w in rows["window_start"]]
    # The second cell spans 18:50-19:20: cut at 19:00 in the first window, whole in the next.
    assert hours == [18, 18, 19]
    first, cut, whole = rows["flash_count"].to_list()
    assert first == whole == 100 and 10 <= cut < 100
    assert rows["cell_id"].n_unique() == 3


def test_config_changes_the_params(lake: SqliteLake) -> None:
    config = {"ops": {"gold__storm_cells": {"config": {"min_pts": 150}}}}
    result = materialize(
        [storm_cells], partition_key="2026-07-15-18:00", resources={"lake": lake}, run_config=config
    )
    assert result.success
    assert stored(lake).height == 0
    assert StormCellsConfig().params == PARAMS


def test_registered_in_the_code_location() -> None:
    node = defs.resolve_asset_graph().get(AssetKey(["gold", "storm_cells"]))
    assert node.pools == {"storm-cells"}


def test_skips_a_fixed_pixel_seen_over_the_lookback(lake: SqliteLake) -> None:
    pixel = cell(2400 * 6, 21.3, -28.7, start=T0 - timedelta(hours=23), minutes=24 * 60, sigma_km=1)
    table = lake.catalog().load_table(FLASHES.identifier)
    table.append(silver_rows(pixel, table.schema().as_arrow()))
    result = materialize([storm_cells], partition_key="2026-07-15-18:00", resources={"lake": lake})
    assert result.success
    assert stored(lake)["lat"].round(0).to_list() == [0.0, 20.0]
