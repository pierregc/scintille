"""Against the local Lakekeeper from compose.yaml: `docker compose up -d --wait`."""

from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import duckdb
import pyarrow as pa
import pytest
from pyiceberg.table import Table
from scintille_lake.access import files_read, flashes
from scintille_lake.config import LakeConfig
from scintille_lake.connect import duckdb_attach, pyiceberg_catalog
from scintille_lake.migrate import migrate
from scintille_lake.tables import FLASHES

pytestmark = pytest.mark.lake


def test_migrate_is_idempotent() -> None:
    catalog = pyiceberg_catalog(LakeConfig())
    migrate(catalog)
    assert migrate(catalog) == []


def test_pyiceberg_write_duckdb_read(flash_rows: Callable[[str, Table], pa.Table]) -> None:
    catalog = pyiceberg_catalog(LakeConfig())
    migrate(catalog)
    product = f"{uuid4().hex}.nc"
    table = catalog.load_table(FLASHES.identifier)
    table.append(flash_rows(product, table))

    con = duckdb.connect()
    duckdb_attach(con, LakeConfig())
    rows = con.execute(
        "SELECT native_flash_id, lat FROM lake.silver.flashes WHERE product_file = ? ORDER BY 1",
        [product],
    ).fetchall()
    assert rows == [(0, 10.5), (1, 11.5), (2, 12.5)]


def test_one_hour_reads_one_hour_of_files() -> None:
    catalog = pyiceberg_catalog(LakeConfig())
    migrate(catalog)
    table = catalog.load_table(FLASHES.identifier)
    day = datetime(2030, 1, 1, tzinfo=UTC)
    for hour in range(0, 24, 6):
        rows = [
            {
                "flash_id": f"{uuid4().hex}",
                "source": "glm-east",
                "product_file": "access.nc",
                "native_flash_id": hour,
                "event_time": day + timedelta(hours=hour),
                "ingest_time": day,
                "lat": 0.0,
                "lon": 0.0,
                "energy_raw": 1.0,
                "energy_unit": "J",
                "intensity": 0.5,
                "area_km2": 1.0,
                "duration_ms": 1.0,
                "quality": [],
                "parser_version": "test",
                "calibration_version": "test",
            }
        ]
        table.append(pa.Table.from_pylist(rows, schema=table.schema().as_arrow()))

    con = duckdb.connect()
    duckdb_attach(con, LakeConfig())
    t0 = day + timedelta(hours=6)
    assert files_read(con, t0, t0 + timedelta(hours=1)) == 1
    rows = flashes(con, t0, t0 + timedelta(hours=1), columns=("native_flash_id",))
    assert rows["native_flash_id"].to_pylist() == [6]
