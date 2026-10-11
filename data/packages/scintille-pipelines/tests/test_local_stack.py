"""Against the local stack from compose.yaml (Lakekeeper, Postgres and the S3 store)."""

from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import obstore
import pyarrow as pa
import pytest
from dagster import materialize
from pyiceberg.partitioning import PartitionField, PartitionSpec
from pyiceberg.schema import Schema
from pyiceberg.transforms import IdentityTransform
from pyiceberg.types import DateType, LongType, NestedField
from scintille_lake.migrate import migrate, sync_table
from scintille_lake.tables import FLASHES, INGEST_LOG, gold_table
from scintille_pipelines.gold import models
from scintille_pipelines.gold.assets import GOLD, daily_stats_feed, feed_key
from scintille_pipelines.resources import FeedResource, LakeResource, PostgresResource
from scintille_pipelines.storm_cells import storm_cells
from scintille_pipelines.storms import storm_tracks, storms

pytestmark = pytest.mark.lake

COUNTRIES = Path(__file__).parent / "fixtures" / "countries.geojson"
DAY = date(2026, 8, 3)


def seed(lake: LakeResource) -> None:
    catalog = lake.catalog()
    migrate(catalog)
    t = datetime(DAY.year, DAY.month, DAY.day, 18, tzinfo=UTC)
    flashes = catalog.load_table(FLASHES.identifier)
    rows = [
        {
            "flash_id": uuid4().hex,
            "source": "glm-east",
            "product_file": "stack.nc",
            "native_flash_id": i,
            "event_time": t,
            "ingest_time": t,
            "lat": 48.85,
            "lon": 2.35,
            "energy_raw": 1.0,
            "energy_unit": "J",
            "intensity": 0.5,
            "area_km2": 100.0,
            "duration_ms": 200.0,
            "quality": [],
            "parser_version": "test",
            "calibration_version": "test",
        }
        for i in range(3)
    ]
    flashes.append(pa.Table.from_pylist(rows, schema=flashes.schema().as_arrow()))
    log = catalog.load_table(INGEST_LOG.identifier)
    entry = {
        "key": f"stack/{uuid4().hex}.nc",
        "source": "glm-east",
        "satellite": "test",
        "product_start": t,
        "product_end": t + timedelta(seconds=20),
        "received_at": t + timedelta(seconds=40),
        "row_count": 3,
        "checksum": "x",
        "status": "ok",
        "parse_duration_ms": 1.0,
        "error": None,
    }
    log.append(pa.Table.from_pylist([entry], schema=log.schema().as_arrow()))


def test_gold_and_feed_against_lakekeeper(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(models, "countries_file", lambda: COUNTRIES)
    lake, feed = LakeResource(), FeedResource()
    seed(lake)
    result = materialize(
        [*GOLD, daily_stats_feed],
        partition_key=DAY.isoformat(),
        resources={"lake": lake, "feed_bucket": feed},
    )
    assert result.success
    assert all(c.passed for c in result.get_asset_check_evaluations())
    with lake.duckdb() as con:
        row = con.execute(
            "SELECT count(*) FROM lake.gold.region_daily WHERE day = ? AND country_code = 'FR'",
            [DAY],
        ).fetchone()
    assert row == (1,)
    assert obstore.head(feed.store(), feed_key(DAY))["size"] > 0


def test_duckdb_write_path_on_a_partitioned_gold_table() -> None:
    """DuckDB INSERT, then DELETE of one day, on a merge-on-read gold table (pinned versions)."""
    lake = LakeResource()
    probe = gold_table(
        "duckdb_write_probe",
        Schema(
            NestedField(1, "day", DateType(), required=True),
            NestedField(2, "n", LongType(), required=True),
        ),
        PartitionSpec(PartitionField(1, 1000, IdentityTransform(), "day")),
    )
    sync_table(lake.catalog(), probe)
    with lake.duckdb() as con:
        con.execute("DELETE FROM lake.gold.duckdb_write_probe")
        con.execute(
            "INSERT INTO lake.gold.duckdb_write_probe VALUES"
            " (DATE '2026-08-01', 1), (DATE '2026-08-02', 2)"
        )
        con.execute("DELETE FROM lake.gold.duckdb_write_probe WHERE day = DATE '2026-08-01'")
        rows = con.execute("SELECT day, n FROM lake.gold.duckdb_write_probe").fetchall()
    assert rows == [(date(2026, 8, 2), 2)]


def test_storm_cells_rerun_against_lakekeeper() -> None:
    for _ in range(2):
        result = materialize(
            [storm_cells, storm_tracks, storms],
            partition_key="2026-07-15-18:00",
            resources={"lake": LakeResource()},
            run_config={"ops": {"gold__storm_tracks": {"config": {"new_chain": True}}}},
        )
        assert result.success


def test_partition_lock_is_exclusive() -> None:
    postgres = PostgresResource()
    key = "silver.flashes/2026-07-15/glm-east"
    with postgres.partition_lock(key) as held:
        assert held
        with postgres.partition_lock(key, wait=False) as other:
            assert not other
    with postgres.partition_lock(key, wait=False) as after:
        assert after
