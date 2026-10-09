"""Gold model definitions and how one day of a model is computed and written."""

import hashlib
import os
import urllib.request
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from importlib.resources import files
from pathlib import Path

import duckdb
import pyarrow as pa
from pyiceberg.catalog import Catalog
from pyiceberg.partitioning import PartitionField, PartitionSpec
from pyiceberg.schema import Schema
from pyiceberg.transforms import DayTransform, IdentityTransform
from pyiceberg.types import (
    DateType,
    DoubleType,
    IntegerType,
    LongType,
    NestedField,
    StringType,
    TimestamptzType,
)
from scintille_lake.migrate import sync_table
from scintille_lake.tables import TableDef, gold_table

COUNTRIES = {
    "url": "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_50m_admin_0_countries.geojson",
    "sha256": "3e458fc036ad0a66411f2c1e6cac49c5d7bfb81cb1123bc513b22511a2b7fdeb",
}


@dataclass(frozen=True)
class Model:
    name: str
    table: TableDef
    #: Column holding the day each row belongs to, for the daily overwrite.
    day_column: str
    #: Columns that identify a row.
    key: tuple[str, ...]
    reads: tuple[str, ...]

    @property
    def sql(self) -> str:
        return files(__package__).joinpath("sql", f"{self.name}.sql").read_text()


FLASH_STATS_HOURLY = Model(
    "flash_stats_hourly",
    gold_table(
        "flash_stats_hourly",
        Schema(
            NestedField(1, "hour", TimestamptzType(), required=True),
            NestedField(2, "source", StringType(), required=True),
            NestedField(3, "lat_cell", IntegerType(), required=True),
            NestedField(4, "lon_cell", IntegerType(), required=True),
            NestedField(5, "flashes", LongType(), required=True),
            NestedField(6, "energy_raw_sum", DoubleType(), required=True),
            NestedField(7, "mean_area_km2", DoubleType(), required=True),
        ),
        PartitionSpec(PartitionField(1, 1000, DayTransform(), "day")),
    ),
    day_column="hour",
    key=("hour", "source", "lat_cell", "lon_cell"),
    reads=("flashes",),
)

SOURCE_SLA_DAILY = Model(
    "source_sla_daily",
    gold_table(
        "source_sla_daily",
        Schema(
            NestedField(1, "day", DateType(), required=True),
            NestedField(2, "source", StringType(), required=True),
            NestedField(3, "files", LongType(), required=True),
            NestedField(4, "expected_files", IntegerType(), required=True),
            NestedField(5, "completeness", DoubleType(), required=True),
            NestedField(6, "failed_files", LongType(), required=True),
            NestedField(7, "latency_p50_s", DoubleType(), required=False),
            NestedField(8, "latency_p95_s", DoubleType(), required=False),
        ),
        PartitionSpec(PartitionField(1, 1000, IdentityTransform(), "day")),
    ),
    day_column="day",
    key=("day", "source"),
    reads=("ingest_log",),
)

REGION_DAILY = Model(
    "region_daily",
    gold_table(
        "region_daily",
        Schema(
            NestedField(1, "day", DateType(), required=True),
            NestedField(2, "country_code", StringType(), required=True),
            NestedField(3, "country_name", StringType(), required=True),
            NestedField(4, "source", StringType(), required=True),
            NestedField(5, "flashes", LongType(), required=True),
        ),
        PartitionSpec(PartitionField(1, 1000, IdentityTransform(), "day")),
    ),
    day_column="day",
    key=("day", "country_code", "source"),
    reads=("flashes", "countries"),
)

MODELS = (FLASH_STATS_HOURLY, SOURCE_SLA_DAILY, REGION_DAILY)


def day_bounds(day: date) -> tuple[datetime, datetime]:
    start = datetime(day.year, day.month, day.day, tzinfo=UTC)
    return start, start + timedelta(days=1)


def compute(con: duckdb.DuckDBPyConnection, model: Model, day: date, relations: dict[str, str]) -> pa.Table:
    """Runs the model's SQL for one day; `relations` maps `{flashes}` etc. to table expressions."""
    start, end = day_bounds(day)
    sql = model.sql.format(**relations)
    return con.execute(sql, {"start": start, "end": end}).to_arrow_table()


def write(catalog: Catalog, model: Model, day: date, rows: pa.Table) -> int:
    """Replaces the model's rows for `day` in one commit (PyIceberg: DuckDB cannot overwrite a partition)."""
    sync_table(catalog, model.table)
    table = catalog.load_table(model.table.identifier)
    start, end = day_bounds(day)
    if model.day_column == "day":
        condition = f"day == '{day.isoformat()}'"
    else:
        condition = f"{model.day_column} >= '{start.isoformat()}' AND {model.day_column} < '{end.isoformat()}'"
    table.overwrite(rows.cast(table.schema().as_arrow()), overwrite_filter=condition)
    return rows.num_rows


def countries_file(cache: Path | None = None) -> Path:
    """Natural Earth admin-0 countries, downloaded once and checked against a pinned checksum."""
    cache = cache or Path(os.environ.get("SCINTILLE_CACHE_DIR", Path.home() / ".cache" / "scintille"))
    path = cache / "ne_50m_admin_0_countries.geojson"
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == COUNTRIES["sha256"]:
        return path
    cache.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(COUNTRIES["url"], timeout=60) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != COUNTRIES["sha256"]:
        raise ValueError("Natural Earth countries file does not match its pinned checksum")
    path.write_bytes(data)
    return path


def load_countries(con: duckdb.DuckDBPyConnection, path: Path) -> str:
    """Creates the `countries` table and returns its name for the SQL models."""
    con.execute("INSTALL spatial; LOAD spatial")
    con.execute(
        "CREATE OR REPLACE TABLE countries AS SELECT ISO_A2_EH AS code, NAME_EN AS name, geom "
        "FROM ST_Read(?) WHERE ISO_A2_EH <> '-99'",
        [str(path)],
    )
    return "countries"
