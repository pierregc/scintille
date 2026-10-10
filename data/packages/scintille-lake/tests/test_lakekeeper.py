"""Against the local Lakekeeper from compose.yaml: `docker compose up -d --wait`."""

from collections.abc import Callable
from uuid import uuid4

import duckdb
import pyarrow as pa
import pytest
from pyiceberg.table import Table
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
