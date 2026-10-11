"""Generic tests for gold models, as SQL selecting the failing rows (dbt style)."""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime

import duckdb
import pyarrow as pa

ROWS = "model_rows"


@dataclass(frozen=True)
class Check:
    name: str
    description: str
    #: Selects failing rows from `model_rows`; may use `{relation}` placeholders and $start/$end.
    sql: str


def unique(columns: Sequence[str]) -> Check:
    cols = ", ".join(columns)
    return Check(
        "unique",
        f"One row per ({cols}).",
        f"SELECT {cols} FROM {ROWS} GROUP BY ALL HAVING count(*) > 1",
    )


def not_null(columns: Sequence[str]) -> Check:
    where = " OR ".join(f"{c} IS NULL" for c in columns)
    return Check(
        "not_null", f"No null in {', '.join(columns)}.", f"SELECT * FROM {ROWS} WHERE {where}"
    )


def accepted_ranges(conditions: Mapping[str, str]) -> Check:
    where = " OR ".join(f"NOT coalesce({c}, true)" for c in conditions.values())
    return Check(
        "accepted_ranges",
        "Values in range: " + "; ".join(conditions.values()) + ".",
        f"SELECT * FROM {ROWS} WHERE {where}",
    )


def relationship(column: str, parent: str) -> Check:
    return Check(
        "relationships",
        f"Every {column} exists upstream: {parent}.",
        f"SELECT * FROM {ROWS} WHERE {column} NOT IN ({parent})",
    )


def failures(
    con: duckdb.DuckDBPyConnection,
    check: Check,
    rows: pa.Table,
    relations: Mapping[str, str],
    start: datetime,
    end: datetime,
) -> int:
    con.register(ROWS, rows)
    sql = check.sql.format(**relations)
    params = {k: v for k, v in {"start": start, "end": end}.items() if f"${k}" in sql}
    result = con.execute(f"SELECT count(*) FROM ({sql})", params).fetchone()
    assert result is not None
    return int(result[0])
