from datetime import UTC, datetime, timedelta

import duckdb
import pyarrow as pa
import pytest
from pyiceberg.catalog import Catalog
from pyiceberg.table import Table
from scintille_lake.access import BBox, files_read, flashes, flashes_query
from scintille_lake.migrate import migrate
from scintille_lake.tables import FLASHES

DAY = datetime(2026, 7, 14, tzinfo=UTC)


def append_hour(table: Table, source: str, hour: datetime, lons: list[float]) -> None:
    rows = [
        {
            "flash_id": f"{hash((source, hour, i)) & (2**128 - 1):032x}",
            "source": source,
            "product_file": "test.nc",
            "native_flash_id": i,
            "event_time": hour + timedelta(minutes=i),
            "ingest_time": hour,
            "lat": 10.0,
            "lon": lon,
            "energy_raw": 1.0,
            "energy_unit": "J",
            "intensity": 0.5,
            "area_km2": 100.0,
            "duration_ms": 200.0,
            "quality": [],
            "parser_version": "test",
            "calibration_version": "test",
        }
        for i, lon in enumerate(lons)
    ]
    table.append(pa.Table.from_pylist(rows, schema=table.schema().as_arrow()))


@pytest.fixture
def scan(catalog: Catalog) -> str:
    """Two days of hourly appends from two sources, like lake-writer would leave them."""
    migrate(catalog)
    table = catalog.load_table(FLASHES.identifier)
    for day in range(2):
        for hour in range(0, 24, 4):
            for source in ("glm-east", "mtg-li"):
                append_hour(
                    table, source, DAY + timedelta(days=day, hours=hour), [-170.0, 20.0, 175.0]
                )
    table = catalog.load_table(FLASHES.identifier)
    return f"iceberg_scan('{table.metadata_location}')"


@pytest.fixture
def con() -> duckdb.DuckDBPyConnection:
    connection = duckdb.connect()
    connection.execute("INSTALL iceberg; LOAD iceberg")
    return connection


def test_reads_only_the_hour_asked(scan: str, con: duckdb.DuckDBPyConnection) -> None:
    t0 = DAY + timedelta(days=1, hours=8)
    assert files_read(con, DAY, DAY + timedelta(days=2), relation=scan) == 24
    assert files_read(con, t0, t0 + timedelta(hours=1), relation=scan) == 2
    assert files_read(con, t0, t0 + timedelta(hours=1), sources=["mtg-li"], relation=scan) == 1


def test_filters_time_sources_and_bbox(scan: str, con: duckdb.DuckDBPyConnection) -> None:
    t0 = DAY + timedelta(hours=4)
    rows = flashes(con, t0, t0 + timedelta(hours=1), sources=["glm-east"], relation=scan)
    assert rows.num_rows == 3
    assert set(rows["source"].to_pylist()) == {"glm-east"}
    europe = flashes(con, t0, t0 + timedelta(hours=1), BBox(0, 0, 40, 30), relation=scan)
    assert europe["lon"].to_pylist() == [20.0, 20.0]
    pacific = flashes(con, t0, t0 + timedelta(hours=1), BBox(170, 0, -160, 30), relation=scan)
    assert pacific.sort_by("lon")["lon"].to_pylist() == [-170.0, -170.0, 175.0, 175.0]


def test_rejects_naive_times_and_odd_columns() -> None:
    with pytest.raises(ValueError, match="timezone"):
        flashes_query(datetime(2026, 7, 14), datetime(2026, 7, 15))
    with pytest.raises(ValueError, match="column"):
        flashes_query(DAY, DAY, columns=["lat; DROP TABLE x"])
