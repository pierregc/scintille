"""Analytics reads of `silver.flashes` through DuckDB, with partition and file pruning."""

import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import duckdb
import pyarrow as pa

DEFAULT_RELATION = "lake.silver.flashes"
DEFAULT_COLUMNS = (
    "flash_id",
    "source",
    "event_time",
    "lat",
    "lon",
    "energy_raw",
    "energy_unit",
    "intensity",
    "area_km2",
    "duration_ms",
    "quality",
)


@dataclass(frozen=True)
class BBox:
    """Degrees; `west > east` crosses the antimeridian."""

    west: float
    south: float
    east: float
    north: float


def flashes_query(
    t0: datetime,
    t1: datetime,
    bbox: BBox | None = None,
    sources: Sequence[str] | None = None,
    columns: Sequence[str] = DEFAULT_COLUMNS,
    relation: str = DEFAULT_RELATION,
) -> tuple[str, list[Any]]:
    """SQL and parameters for flashes in [t0, t1), optionally inside `bbox` and from `sources`."""
    if t0.tzinfo is None or t1.tzinfo is None:
        raise ValueError("t0 and t1 must be timezone-aware")
    where = ["event_time >= ?", "event_time < ?"]
    params: list[Any] = [t0, t1]
    if sources:
        where.append(f"source IN ({', '.join('?' for _ in sources)})")
        params += list(sources)
    if bbox:
        where.append("lat BETWEEN ? AND ?")
        params += [bbox.south, bbox.north]
        if bbox.west <= bbox.east:
            where.append("lon BETWEEN ? AND ?")
        else:
            where.append("(lon >= ? OR lon <= ?)")
        params += [bbox.west, bbox.east]
    for column in columns:
        if not re.fullmatch(r"\w+", column):
            raise ValueError(f"bad column name {column!r}")
    sql = f"SELECT {', '.join(columns)} FROM {relation} WHERE {' AND '.join(where)}"
    return sql, params


def flashes(
    connection: duckdb.DuckDBPyConnection,
    t0: datetime,
    t1: datetime,
    bbox: BBox | None = None,
    sources: Sequence[str] | None = None,
    columns: Sequence[str] = DEFAULT_COLUMNS,
    relation: str = DEFAULT_RELATION,
) -> pa.Table:
    """Flashes as Arrow; `pl.from_arrow(...)` gives a Polars frame."""
    sql, params = flashes_query(t0, t1, bbox, sources, columns, relation)
    return connection.execute(sql, params).to_arrow_table()


def files_read(
    connection: duckdb.DuckDBPyConnection,
    t0: datetime,
    t1: datetime,
    bbox: BBox | None = None,
    sources: Sequence[str] | None = None,
    relation: str = DEFAULT_RELATION,
) -> int:
    """Data files DuckDB actually opens for that query, from EXPLAIN ANALYZE."""
    sql, params = flashes_query(t0, t1, bbox, sources, ("flash_id",), relation)
    plan = "\n".join(
        str(row[1]) for row in connection.execute(f"EXPLAIN ANALYZE {sql}", params).fetchall()
    )
    counts = [int(n) for n in re.findall(r"Total Files Read:\s*(\d+)", plan)]
    if not counts:
        raise RuntimeError("no Iceberg scan in the plan")
    return sum(counts)
