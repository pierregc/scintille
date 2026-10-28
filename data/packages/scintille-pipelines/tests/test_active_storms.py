import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import obstore
import polars as pl
import pyarrow as pa
import pytest
from dagster import DagsterInstance, materialize
from obstore.store import MemoryStore
from pyiceberg.catalog import Catalog
from pyiceberg.catalog.sql import SqlCatalog
from scintille_contract import active
from scintille_contract.models import ActiveStorms
from scintille_ingest.runtime.spool import Spool
from scintille_lake.migrate import migrate, sync_table
from scintille_lake.tables import FLASHES, INGEST_LOG
from scintille_pipelines.active_lake import ACTIVE_PATH, Lake, SilverCache, read_spool
from scintille_pipelines.active_service import ActiveService
from scintille_pipelines.active_storms import ActiveFeed, CatalogState, Update
from scintille_pipelines.clustering import KM_PER_DEGREE
from scintille_pipelines.hotspots import (
    HotspotRule,
    fixed_hotspots,
    hotspots_from_hours,
    pixel_hours,
)
from scintille_pipelines.resources import LakeResource
from scintille_pipelines.storm_cells import StormCellsConfig, hour_cells, storm_cells
from scintille_pipelines.storm_levels import storm_levels
from scintille_pipelines.storm_names import STORM_NAMES
from scintille_pipelines.storms import STORMS, storm_tracks, storms
from scintille_pipelines.tracking import TRACK_SCHEMA, link

T0 = datetime(2026, 7, 15, 18, tzinfo=UTC)
SEC = timedelta(seconds=1)
MIN = timedelta(minutes=1)
HOUR = timedelta(hours=1)
LAG = {"glm-east": timedelta(seconds=20), "mtg-li": timedelta(minutes=8)}
NO_SPOTS = pl.DataFrame(schema={"source": pl.String, "lat": pl.Float64, "lon": pl.Float64})
rng = np.random.default_rng(7)


def flashes(
    n: int,
    lat: float,
    lon: float,
    start: datetime,
    minutes: float,
    speed_kmh: tuple[float, float] = (0, 0),
    sigma_km: float = 2,
    source: str = "glm-east",
) -> pl.DataFrame:
    """Flashes of a Gaussian cell drifting at `speed_kmh` (east, north)."""
    offsets = np.sort(rng.uniform(0, minutes * 60, n))
    north = rng.normal(0, sigma_km, n) + speed_kmh[1] * offsets / 3600
    east = rng.normal(0, sigma_km, n) + speed_kmh[0] * offsets / 3600
    return pl.DataFrame(
        {
            "flash_id": [f"{rng.integers(2**62):032x}" for _ in range(n)],
            "source": source,
            "event_time": pl.Series(
                [start + timedelta(seconds=float(s)) for s in offsets],
                dtype=pl.Datetime("us", "UTC"),
            ),
            "lat": lat + north / KM_PER_DEGREE,
            "lon": lon + east / (KM_PER_DEGREE * np.cos(np.radians(lat))),
        }
    )


class Run:
    """Feeds flashes to an ActiveFeed as they arrive, checking every snapshot and transition."""

    def __init__(self, data: pl.DataFrame, feed: ActiveFeed | None = None) -> None:
        self.data = data
        self.feed = feed or ActiveFeed()
        self.snapshots: list[ActiveStorms] = []

    def at(
        self,
        now: datetime,
        catalog: CatalogState | None = None,
        stuck: dict[str, datetime] | None = None,
    ) -> ActiveStorms:
        catalog = catalog or CatalogState(None)
        observed = {s: now - lag for s, lag in LAG.items()} | (stuck or {})
        since = self.feed.window(now, catalog.tracked_until)
        arrived = self.data.filter(
            pl.col("event_time") >= since,
            pl.col("event_time")
            < pl.col("source").replace_strict(observed, return_dtype=pl.Datetime("us", "UTC")),
        )
        snapshot = self.feed.update(Update(now, arrived, observed, catalog, NO_SPOTS))
        errors = active.check(snapshot)
        if self.feed.previous is not None:
            errors += active.check_transition(self.feed.previous, snapshot)
        assert errors == []
        self.feed.published(snapshot)
        self.snapshots.append(snapshot)
        return snapshot

    def every(self, start: datetime, end: datetime, **kwargs: Any) -> list[ActiveStorms]:
        steps = int((end - start) / (5 * MIN)) + 1
        return [self.at(start + k * 5 * MIN, **kwargs) for k in range(steps)]


def ids(snapshot: ActiveStorms) -> list[str]:
    return [cell.id for cell in snapshot.cells]


def ended(snapshot: ActiveStorms) -> dict[str, tuple[str, str | None]]:
    return {e.id: (e.reason, e.into) for e in snapshot.ended}


def catalog_until(data: pl.DataFrame, hours: int, start: datetime = T0) -> CatalogState:
    """The catalog after tracking `hours` hours from `start` on complete data."""
    config = StormCellsConfig()
    overlap = timedelta(minutes=config.overlap_minutes)
    tracks = pl.DataFrame(schema=TRACK_SCHEMA)
    rows = []
    for h in range(hours):
        cells = hour_cells(data, start + h * HOUR, overlap, config.params)
        tracks = link(tracks, cells, TRACK_PARAMS)
        rows.append(tracks)
    every = pl.concat(rows)
    info = every.group_by("storm_id").agg(
        pl.col("t_start").min(),
        pl.col("split_from").first(),
        pl.lit("glm-east").alias("level_source"),
        pl.col("hour_flash_count").sum().alias("flashes"),
        pl.lit(1, pl.Int64).alias("peak_rate"),
        pl.lit(3, pl.Int64).alias("level"),
    )
    info = info.with_columns(
        slug=pl.format("storm-{}", pl.col("storm_id").str.slice(0, 6)), name=pl.lit("Somewhere")
    )
    return CatalogState(start + hours * HOUR, tracks, info)


TRACK_PARAMS = ActiveFeed().tracks.params


def test_moving_storm_keeps_one_provisional_id_until_it_expires() -> None:
    storm = flashes(4000, -30, -60, T0 + 20 * MIN, 150, speed_kmh=(40, 0))
    run = Run(storm)
    snapshots = run.every(T0 + 25 * MIN, T0 + 3 * HOUR + 30 * MIN)
    listed = {i for s in snapshots for i in ids(s)}
    assert len(listed) == 1
    (storm_id,) = listed
    live = [s.cells[0] for s in snapshots if s.cells]
    assert all(c.provisional and c.level >= 2 for c in live)
    assert live[0].t_start == storm["event_time"].min()
    assert max(len(c.path) for c in live) == 13
    lons = [p.lon for p in live[-1].path]
    assert lons == sorted(lons)
    assert ended(snapshots[-1]) == {storm_id: ("expired", None)}
    gone = next(s for s in snapshots if not s.cells)
    last = storm["event_time"].max()
    assert isinstance(last, datetime)
    assert gone.published_at - last >= timedelta(minutes=30)


def test_ids_become_final_once_the_catalog_tracks_their_hour() -> None:
    storm = flashes(3000, -30, -60, T0 + 20 * MIN, 120, speed_kmh=(40, 0))
    run = Run(storm)
    before = run.every(T0 + 25 * MIN, T0 + HOUR + 20 * MIN)
    (storm_id,) = {i for s in before for i in ids(s)}
    catalog = catalog_until(storm, 1)
    assert catalog.tracks["storm_id"].to_list() == [storm_id]
    after = run.at(T0 + HOUR + 25 * MIN, catalog)
    cell = after.cells[0]
    assert (cell.id, cell.provisional, cell.name) == (storm_id, False, "Somewhere")
    assert cell.slug == f"storm-{storm_id[:6]}"
    assert after.ended == []
    scores = run.feed.id_scores(catalog)
    assert scores is not None and scores["hour"] == scores["worst_update"] == 1.0


def test_a_fresh_feed_continues_the_catalog_ids() -> None:
    storm = flashes(3000, -30, -60, T0 + 20 * MIN, 120, speed_kmh=(40, 0))
    catalog = catalog_until(storm, 1)
    snapshot = Run(storm).at(T0 + HOUR + 30 * MIN, catalog)
    assert ids(snapshot) == catalog.tracks["storm_id"].to_list()
    assert not snapshot.cells[0].provisional
    assert snapshot.authoritative_until == T0 + HOUR


def test_final_ids_start_before_the_catalog_hour_while_its_storms_are_written() -> None:
    storm = flashes(3000, -30, -60, T0 + 50 * MIN, 120, speed_kmh=(40, 0))
    full = catalog_until(storm, 1)
    tracks_only = CatalogState(full.tracked_until, full.tracks)
    cell = Run(storm).at(T0 + HOUR + 25 * MIN, tracks_only).cells[0]
    assert not cell.provisional and cell.name is None
    assert cell.t_start == storm["event_time"].min()


def test_a_merge_ends_the_smaller_storm_into_the_main_branch() -> None:
    a = flashes(900, -30, -60.0, T0, 60, sigma_km=3)
    b = flashes(400, -30, -59.55, T0, 60, sigma_km=3)
    joint = flashes(2500, -30, -59.78, T0 + HOUR, 50, sigma_km=12)
    run = Run(pl.concat([a, b, joint]))
    first = run.at(T0 + 50 * MIN)
    assert len(first.cells) == 2
    main, small = ids(first)
    last = run.every(T0 + 55 * MIN, T0 + HOUR + 30 * MIN)[-1]
    assert ids(last) == [main]
    assert last.cells[0].merged == [small]
    assert ended(last)[small] == ("merged", main)


def test_a_split_starts_a_storm_with_split_from() -> None:
    big = flashes(2500, -30, -59.78, T0, 52, sigma_km=12)
    a = flashes(900, -30, -60.0, T0 + 63 * MIN, 40, sigma_km=3)
    b = flashes(400, -30, -59.55, T0 + 63 * MIN, 40, sigma_km=3)
    run = Run(pl.concat([big, a, b]))
    (parent,) = ids(run.at(T0 + 50 * MIN))
    snapshot = run.every(T0 + 55 * MIN, T0 + HOUR + 30 * MIN)[-1]
    cells = {c.id: c for c in snapshot.cells}
    assert parent in cells and cells[parent].split_from is None
    (child,) = set(cells) - {parent}
    assert cells[child].split_from == parent


def test_late_flashes_replace_a_provisional_id() -> None:
    storm = flashes(1500, 5, 20, T0 + HOUR, 40, source="glm-east")
    late = flashes(60, 5, 20, T0 + HOUR - 3 * MIN, 3, source="mtg-li")
    run = Run(storm)
    (first,) = ids(run.at(T0 + HOUR + 10 * MIN))
    run.data = pl.concat([storm, late])
    snapshot = run.at(T0 + HOUR + 15 * MIN)
    (second,) = ids(snapshot)
    assert second != first
    assert snapshot.cells[0].previous_ids == [first]
    assert ended(snapshot)[first] == ("replaced", second)
    assert snapshot.cells[0].sources == ["glm-east", "mtg-li"]


def test_a_silent_source_keeps_its_storms_then_ends_them() -> None:
    storm = flashes(3000, 5, 20, T0, 100, source="mtg-li")
    run = Run(storm)
    run.at(T0 + 50 * MIN)
    stuck = {"mtg-li": T0 + HOUR}
    held = run.every(T0 + HOUR + 15 * MIN, T0 + 2 * HOUR, stuck=stuck)
    (storm_id,) = ids(held[0])
    assert all(ids(s) == [storm_id] for s in held)
    gone = run.at(T0 + 2 * HOUR + 5 * MIN, stuck=stuck)
    assert gone.cells == []
    assert ended(gone)[storm_id] == ("source-gap", None)


def test_a_restart_keeps_ids_levels_and_paths() -> None:
    storm = flashes(4000, -30, -60, T0 + 20 * MIN, 150, speed_kmh=(40, 0))
    run = Run(storm)
    last = run.every(T0 + 25 * MIN, T0 + HOUR + 40 * MIN)[-1]
    restarted = Run(storm, ActiveFeed(previous=last))
    snapshot = restarted.at(T0 + HOUR + 45 * MIN)
    assert ids(snapshot) == ids(last)
    assert snapshot.ended == []
    assert snapshot.cells[0].level >= last.cells[0].level
    assert len(snapshot.cells[0].path) >= len(last.cells[0].path)


def test_a_restart_behind_its_own_hours_replaces_by_overlap() -> None:
    storm = flashes(6000, -30, -60, T0, 200, speed_kmh=(30, 0))
    run = Run(storm)
    last = run.every(T0 + 10 * MIN, T0 + 2 * HOUR + 30 * MIN)[-1]
    (old,) = ids(last)
    restarted = Run(storm, ActiveFeed(previous=last))
    snapshot = restarted.at(T0 + 2 * HOUR + 35 * MIN)
    (new,) = ids(snapshot)
    assert new != old
    assert ended(snapshot)[old] == ("replaced", new)
    assert snapshot.cells[0].previous_ids == [old]
    assert snapshot.cells[0].level >= last.cells[0].level


def test_the_same_inputs_give_the_same_snapshots() -> None:
    data = pl.concat(
        [
            flashes(2000, -30, -60, T0 + 20 * MIN, 90, speed_kmh=(40, 0)),
            flashes(800, 5, 20, T0 + 30 * MIN, 60, source="mtg-li"),
        ]
    )
    one, two = Run(data), Run(data.sample(fraction=1.0, shuffle=True, seed=1))
    for k in range(6):
        now = T0 + 40 * MIN + 10 * k * MIN
        assert one.at(now).model_dump() == two.at(now).model_dump()


class FakeLake:
    """A lake holding one storm, whose writes fail while `fail` is set."""

    def __init__(self, data: pl.DataFrame) -> None:
        self.data = data
        self.fail = False
        self.written: list[bytes] = []

    def tracked_until(self, now: datetime) -> datetime | None:
        return None

    def catalog_state(self, tracked_until: datetime | None) -> CatalogState:
        return CatalogState(tracked_until)

    def inputs(self, since: datetime, now: datetime) -> Any:
        from scintille_pipelines.active_lake import Inputs

        arrived = self.data.filter(pl.col("event_time").is_between(since, now - LAG["glm-east"]))
        return Inputs(arrived, {"glm-east": now - LAG["glm-east"]}, arrived.height, 0, 1)

    def hotspots(self, end: datetime) -> pl.DataFrame:
        return NO_SPOTS

    def write(self, body: bytes) -> None:
        if self.fail:
            raise OSError("R2 unavailable")
        self.written.append(body)


def test_a_failed_write_keeps_the_previous_snapshot() -> None:
    lake = FakeLake(flashes(3000, -30, -60, T0 + 20 * MIN, 120))
    clock = iter(T0 + 40 * MIN + k * 5 * MIN for k in range(100))
    now = [T0]

    def tick() -> datetime:
        now[0] = next(clock)
        return now[0]

    service = ActiveService(lake, clock=tick)  # type: ignore[arg-type]
    service.update_once()
    first = service.feed.previous
    assert first is not None and len(lake.written) == 1
    lake.fail = True
    with pytest.raises(OSError):
        service.update_once()
    assert service.feed.previous is first
    lake.fail = False
    service.update_once()
    current = ActiveStorms.model_validate_json(lake.written[-1])
    assert active.check_transition(first, current) == []


def test_a_snapshot_breaking_the_contract_is_not_written(monkeypatch: pytest.MonkeyPatch) -> None:
    lake = FakeLake(flashes(3000, -30, -60, T0 + 20 * MIN, 120))
    service = ActiveService(lake, clock=lambda: T0 + HOUR)  # type: ignore[arg-type]
    monkeypatch.setattr(active, "check", lambda snapshot: ["broken"])
    with pytest.raises(ValueError, match="contract"):
        service.update_once()
    assert lake.written == []
    assert service.feed.previous is None


def spool_batch(spool: Spool, batch: str, data: pl.DataFrame, end: datetime) -> None:
    log = pl.DataFrame({"source": ["glm-east"], "product_end": [end]})
    spool.write(batch, data, log)


def test_read_spool_skips_old_and_vanished_batches(tmp_path: Path) -> None:
    spool = Spool(tmp_path)
    data = flashes(30, -30, -60, T0 + HOUR, 1)
    spool_batch(spool, "old", data.head(10), T0)
    spool_batch(spool, "gone", data.slice(10, 10), T0 + HOUR)
    spool_batch(spool, "new", data.tail(10), T0 + HOUR + MIN)
    old = (T0 - HOUR).timestamp()
    os.utime(spool.path("old"), (old, old))
    spool.log_path("gone").unlink()
    found, frontier = read_spool(tmp_path, datetime.fromtimestamp(old + 60, UTC))
    assert sorted(found["flash_id"]) == sorted(data.tail(10)["flash_id"])
    assert frontier == {"glm-east": T0 + HOUR + MIN}


def test_hot_spots_from_hourly_counts_match_the_catalog_rule() -> None:
    rule = StormCellsConfig().rule
    end = T0 + 3 * 24 * HOUR
    stuck = pl.concat(
        flashes(400, 12.03, 30.03, T0 + d * 24 * HOUR + 2 * HOUR, 600, sigma_km=0.2)
        for d in range(3)
    )
    storm = flashes(3000, -20, 50, end - 5 * HOUR, 120, speed_kmh=(50, 0), sigma_km=4)
    data = pl.concat([stuck, storm])
    expected = fixed_hotspots(data, end, rule)
    got = hotspots_from_hours(pixel_hours(data, rule), end, rule)
    assert got.height == expected.height >= 1
    for column in ("lat", "lon"):
        assert np.allclose(got[column].to_numpy(), expected[column].to_numpy(), atol=0.01)
    assert got["stuck_days"].to_list() == expected["stuck_days"].to_list()


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


def test_silver_cache_reads_only_new_files_and_drops_removed_ones(tmp_path: Path) -> None:
    catalog = SqliteLake(path=str(tmp_path)).catalog()
    migrate(catalog)
    table = catalog.load_table(FLASHES.identifier)
    first, second = flashes(200, -30, -60, T0, 30), flashes(200, -30, -60, T0 + 30 * MIN, 30)
    table.append(silver_rows(first, table.schema().as_arrow()))
    cache = SilverCache(HotspotRule())
    now = T0 + HOUR
    cache.refresh(catalog.load_table(FLASHES.identifier), now)
    assert cache.files_read == 1 and cache.window(T0).height == 200
    table = catalog.load_table(FLASHES.identifier)
    table.append(silver_rows(second, table.schema().as_arrow()))
    cache.refresh(catalog.load_table(FLASHES.identifier), now)
    assert cache.files_read == 1 and cache.window(T0).height == 400
    cache.refresh(catalog.load_table(FLASHES.identifier), now)
    assert cache.files_read == 0
    table = catalog.load_table(FLASHES.identifier)
    table.delete(f"event_time < '{(T0 + 30 * MIN).isoformat()}'")
    cache.refresh(catalog.load_table(FLASHES.identifier), now)
    assert sorted(cache.window(T0)["flash_id"]) == sorted(second["flash_id"])
    assert int(pl.concat([cache.settled, *cache.pixels.values()])["flashes"].sum()) == 200


def test_the_service_publishes_the_catalog_ids_from_the_lake(tmp_path: Path) -> None:
    lake = SqliteLake(path=str(tmp_path))
    catalog = lake.catalog()
    migrate(catalog)
    storm = flashes(2000, -30, -60, T0 + 20 * MIN, 69, speed_kmh=(40, 0))
    table = catalog.load_table(FLASHES.identifier)
    table.append(silver_rows(storm, table.schema().as_arrow()))
    files = catalog.load_table(INGEST_LOG.identifier)
    log = pl.DataFrame(
        {
            "key": ["glm/test.nc"],
            "source": ["glm-east"],
            "satellite": ["G19"],
            "product_start": [T0 + HOUR + 29 * MIN],
            "product_end": [T0 + HOUR + 29 * MIN + 20 * SEC],
            "received_at": [T0 + HOUR + 29 * MIN + 40 * SEC],
            "row_count": [0],
            "checksum": ["x"],
            "status": ["ok"],
            "parse_duration_ms": [1.0],
            "error": [None],
        }
    )
    files.append(log.to_arrow().cast(files.schema().as_arrow()))
    run_config = {"ops": {"gold__storm_tracks": {"config": {"new_chain": True}}}}
    result = materialize(
        [storm_cells, storm_tracks, storms, storm_levels],
        partition_key="2026-07-15-18:00",
        resources={"lake": lake},
        instance=DagsterInstance.ephemeral(),
        run_config=run_config,
    )
    assert result.success
    sync_table(catalog, STORM_NAMES)
    rows = pl.from_arrow(catalog.load_table(STORMS.identifier).scan().to_arrow())
    assert isinstance(rows, pl.DataFrame)
    names = rows.select(
        "storm_id",
        storm_start=pl.col("t_start"),
        day=pl.col("t_start").dt.date(),
        slug=pl.lit("2026-07-15-somewhere"),
        name=pl.lit("Somewhere"),
        label=pl.lit("Somewhere storm"),
        place=pl.lit(None, pl.String),
        place_km=pl.lit(None, pl.Float64),
        region=pl.lit(None, pl.String),
        country_code=pl.lit(None, pl.String),
        country_name=pl.lit(None, pl.String),
        sea=pl.lit("Test Sea"),
        offshore=pl.lit(True),
        lat=pl.lit(0.0),
        lon=pl.lit(0.0),
        geodata=pl.lit("test"),
    )
    names_table = catalog.load_table(STORM_NAMES.identifier)
    names_table.append(names.to_arrow().cast(names_table.schema().as_arrow()))
    feed = MemoryStore()
    obstore.put(feed, "_pipeline/storms/published.json", b'["2026-07-15-somewhere"]')
    reader = Lake(lake.catalog, feed, None, StormCellsConfig().rule)
    now = T0 + HOUR + 30 * MIN
    service = ActiveService(reader, clock=lambda: now)
    stats = service.update_once()
    assert stats["files_read"] == 1
    snapshot = ActiveStorms.model_validate_json(obstore.get(feed, ACTIVE_PATH).bytes().to_bytes())
    assert active.check(snapshot) == []
    assert snapshot.authoritative_until == T0 + HOUR
    (cell,) = snapshot.cells
    assert cell.id == rows["storm_id"][0]
    assert (cell.provisional, cell.slug, cell.name) == (False, "2026-07-15-somewhere", "Somewhere")
    observed = {s.source: s.observed_until for s in snapshot.sources}
    assert observed["glm-east"] == T0 + HOUR + 29 * MIN + 20 * SEC
    assert ActiveService(reader).lake.previous() == snapshot
