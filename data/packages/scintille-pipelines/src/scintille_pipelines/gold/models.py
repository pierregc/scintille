"""Gold model definitions and how one day of a model is computed and written."""

import hashlib
import os
import urllib.request
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from importlib.resources import files
from pathlib import Path
from typing import Any

import duckdb
import pyarrow as pa
from pyiceberg.catalog import Catalog
from pyiceberg.partitioning import PartitionField, PartitionSpec
from pyiceberg.schema import Schema
from pyiceberg.transforms import DayTransform, IdentityTransform, Transform
from pyiceberg.types import (
    DateType,
    DoubleType,
    IntegerType,
    LongType,
    NestedField,
    StringType,
    TimestamptzType,
)
from scintille_contract.models import SOURCE_VALUES
from scintille_ingest.backfill import EXPECTED_FILES_PER_DAY
from scintille_lake.migrate import sync_table
from scintille_lake.tables import TableDef, gold_table

from .checks import Check, accepted_ranges, not_null, relationship, unique

COUNTRIES = {
    "url": "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_50m_admin_0_countries.geojson",
    "sha256": "3e458fc036ad0a66411f2c1e6cac49c5d7bfb81cb1123bc513b22511a2b7fdeb",
}

#: Relations the SQL files read, by placeholder name.
RELATIONS = {
    "flashes": "lake.silver.flashes",
    "ingest_log": "lake.bronze.ingest_log",
    "flash_stats_hourly": "lake.gold.flash_stats_hourly",
    "source_sla_daily": "lake.gold.source_sla_daily",
    "expected_files": "expected_files",
    "countries": "countries",
}

SOURCES = "(" + ", ".join(f"'{s}'" for s in SOURCE_VALUES) + ")"


@dataclass(frozen=True)
class Model:
    name: str
    table: TableDef
    description: str
    #: Column holding the day each row belongs to, for the daily overwrite.
    day_column: str
    #: Upstream asset keys, as `namespace/name`.
    deps: tuple[str, ...]
    checks: tuple[Check, ...] = field(default=())

    @property
    def sql(self) -> str:
        return files(__package__).joinpath("sql", f"{self.name}.sql").read_text()


def _model(
    name: str,
    schema: Schema,
    day_column: str,
    key: tuple[str, ...],
    ranges: dict[str, str],
    deps: tuple[str, ...],
    description: str,
    extra: tuple[Check, ...] = (),
) -> Model:
    day_field = schema.find_field(day_column).field_id
    transform: Transform[Any, Any] = IdentityTransform() if day_column == "day" else DayTransform()
    spec = PartitionSpec(PartitionField(day_field, 1000, transform, "day"))
    table = gold_table(name, schema, spec)
    required = tuple(f.name for f in schema.fields if f.required)
    checks = (unique(key), not_null(required), accepted_ranges(ranges), *extra)
    return Model(name, table, description, day_column, deps, checks)


FLASH_STATS_HOURLY = _model(
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
    day_column="hour",
    key=("hour", "source", "lat_cell", "lon_cell"),
    ranges={
        "lat_cell": "lat_cell BETWEEN -90 AND 89",
        "lon_cell": "lon_cell BETWEEN -180 AND 179",
        "flashes": "flashes > 0",
        "energy_raw_sum": "energy_raw_sum >= 0",
        "mean_area_km2": "mean_area_km2 >= 0",
        "source": f"source IN {SOURCES}",
    },
    deps=("silver/flashes",),
    description="Flashes per hour, source and 1° cell, with summed raw energy.",
)

SOURCE_SLA_DAILY = _model(
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
    day_column="day",
    key=("day", "source"),
    ranges={
        "completeness": "completeness BETWEEN 0 AND 1",
        "failed_files": "failed_files BETWEEN 0 AND files",
        "latency": "latency_p50_s IS NULL OR latency_p50_s <= latency_p95_s",
        "source": f"source IN {SOURCES}",
    },
    deps=("bronze/ingest_log",),
    description="Per source and day: files received against expected, and delivery latency.",
)

REGION_DAILY = _model(
    "region_daily",
    Schema(
        NestedField(1, "day", DateType(), required=True),
        NestedField(2, "country_code", StringType(), required=True),
        NestedField(3, "country_name", StringType(), required=True),
        NestedField(4, "source", StringType(), required=True),
        NestedField(5, "flashes", LongType(), required=True),
    ),
    day_column="day",
    key=("day", "country_code", "source"),
    ranges={"country_code": "length(country_code) = 2", "flashes": "flashes > 0"},
    deps=("silver/flashes", "reference/countries", "gold/flash_stats_hourly"),
    description="Flashes per country, source and day (Natural Earth admin-0 borders).",
    extra=(
        relationship(
            "source",
            "SELECT DISTINCT source FROM {flash_stats_hourly} WHERE hour >= $start AND hour < $end",
        ),
    ),
)

MODELS = (FLASH_STATS_HOURLY, SOURCE_SLA_DAILY, REGION_DAILY)


def day_bounds(day: date) -> tuple[datetime, datetime]:
    start = datetime(day.year, day.month, day.day, tzinfo=UTC)
    return start, start + timedelta(days=1)


def prepare(con: duckdb.DuckDBPyConnection, model: Model) -> None:
    """UTC session, plus the reference relations the model reads."""
    con.execute("SET TimeZone = 'UTC'")
    expected = pa.table(
        {
            "source": list(EXPECTED_FILES_PER_DAY),
            "expected": pa.array(EXPECTED_FILES_PER_DAY.values(), pa.int32()),
        }
    )
    con.register("expected_files", expected)
    if "{countries}" in model.sql:
        load_countries(con, countries_file())


def compute(con: duckdb.DuckDBPyConnection, model: Model, day: date) -> pa.Table:
    """Runs the model's SQL for one day."""
    prepare(con, model)
    start, end = day_bounds(day)
    sql = model.sql.format(**RELATIONS)
    rows = con.execute(sql, {"start": start, "end": end}).to_arrow_table()
    return rows.cast(model.table.schema.as_arrow())


def write(catalog: Catalog, model: Model, day: date, rows: pa.Table) -> int:
    """Replaces the model's rows for `day` in one commit."""
    sync_table(catalog, model.table)
    table = catalog.load_table(model.table.identifier)
    if model.day_column == "day":
        condition = f"day == '{day.isoformat()}'"
    else:
        start, end = day_bounds(day)
        column = model.day_column
        condition = f"{column} >= '{start.isoformat()}' AND {column} < '{end.isoformat()}'"
    table.overwrite(rows.cast(table.schema().as_arrow()), overwrite_filter=condition)
    return rows.num_rows


def countries_file(cache: Path | None = None) -> Path:
    """Natural Earth admin-0 countries, downloaded once and checked against a pinned checksum."""
    default = Path.home() / ".cache" / "scintille"
    cache = cache or Path(os.environ.get("SCINTILLE_CACHE_DIR", default))
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


def load_countries(con: duckdb.DuckDBPyConnection, path: Path) -> None:
    """Creates the `countries` table (code, name, geom)."""
    con.execute("INSTALL spatial; LOAD spatial")
    con.execute(
        "CREATE OR REPLACE TABLE countries AS SELECT ISO_A2_EH AS code, NAME_EN AS name, geom "
        "FROM ST_Read(?) WHERE ISO_A2_EH <> '-99'",
        [str(path)],
    )
