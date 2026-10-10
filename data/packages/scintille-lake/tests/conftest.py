from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import pyarrow as pa
import pytest
from pyiceberg.catalog import Catalog
from pyiceberg.catalog.sql import SqlCatalog
from pyiceberg.table import Table


@pytest.fixture
def catalog(tmp_path: Path) -> Catalog:
    return SqlCatalog(
        "test",
        uri=f"sqlite:///{tmp_path / 'catalog.db'}",
        warehouse=f"file://{tmp_path / 'warehouse'}",
    )


def _flash_rows(product_file: str, table: Table, n: int = 3) -> pa.Table:
    t = datetime(2026, 7, 15, 18, 0, tzinfo=UTC)
    return pa.Table.from_pylist(
        [
            {
                "flash_id": f"{i:032x}",
                "source": "glm-east",
                "product_file": product_file,
                "native_flash_id": i,
                "event_time": t,
                "ingest_time": t,
                "lat": 10.5 + i,
                "lon": -60.25,
                "energy_raw": 1e-14,
                "energy_unit": "J",
                "intensity": 0.5,
                "area_km2": 120.0,
                "duration_ms": 250.0,
                "quality": [],
                "parser_version": "test",
                "calibration_version": "test",
            }
            for i in range(n)
        ],
        schema=table.schema().as_arrow(),
    )


FlashRows = Callable[[str, Table], pa.Table]


@pytest.fixture
def flash_rows() -> FlashRows:
    """Three valid rows for a product file, typed by the silver.flashes table."""
    return _flash_rows
