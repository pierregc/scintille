"""Row-level validation of normalized flashes: Pandera checks generated from the data contract."""

import json
from datetime import datetime, timedelta
from typing import Any, get_args

import pandera.polars as pa
import polars as pl
from annotated_types import Ge, Le, MinLen
from pandera.errors import SchemaErrors
from scintille_contract.models import FlashRecord

# Event times may run a little past the product window (flash grouping, clock skew).
WINDOW_TOLERANCE = timedelta(minutes=5)
# Filled later by the calibration (#33).
NULLABLE = {"intensity"}


def _checks(metadata: list[Any]) -> list[pa.Check]:
    checks: list[pa.Check] = []
    for item in metadata:
        if isinstance(item, Ge):
            checks.append(pa.Check.greater_than_or_equal_to(item.ge))
        elif isinstance(item, Le):
            checks.append(pa.Check.less_than_or_equal_to(item.le))
        elif isinstance(item, MinLen):
            checks.append(pa.Check.str_length(min_value=item.min_length))
        elif getattr(item, "pattern", None):
            checks.append(pa.Check.str_matches(item.pattern))
    return checks


def contract_schema() -> pa.DataFrameSchema:
    """One column per `FlashRecord` field, with its ranges, patterns and allowed values."""
    columns: dict[str, pa.Column] = {}
    for name, field in FlashRecord.model_fields.items():
        checks = _checks(list(field.metadata))
        allowed = get_args(field.annotation)
        if allowed and all(isinstance(a, str) for a in allowed):
            checks.append(pa.Check.isin(list(allowed)))
        columns[name] = pa.Column(checks=checks, nullable=name in NULLABLE)
    return pa.DataFrameSchema(columns, strict=False)


SCHEMA = contract_schema()


def validate(
    flashes: pl.DataFrame, window: tuple[datetime, datetime]
) -> tuple[pl.DataFrame, pl.DataFrame]:
    """Valid rows, and rejected rows with a `reason` listing every failed check."""
    if flashes.height == 0:
        return flashes, flashes.with_columns(pl.lit(None, pl.String).alias("reason")).clear()
    frame = flashes.with_row_index("_row")
    reasons: dict[int, list[str]] = {}
    try:
        SCHEMA.validate(frame.with_columns(pl.col(pl.Enum).cast(pl.String)), lazy=True)
    except SchemaErrors as errors:
        for row in errors.failure_cases.iter_rows(named=True):
            if row["index"] is not None:
                reasons.setdefault(int(row["index"]), []).append(f"{row['column']}: {row['check']}")
    start, end = window[0] - WINDOW_TOLERANCE, window[1] + WINDOW_TOLERANCE
    outside = frame.filter(~pl.col("event_time").is_between(start, end))["_row"].to_list()
    for index in outside:
        reasons.setdefault(index, []).append("event_time: outside the product window")
    bad = pl.DataFrame(
        {"_row": list(reasons), "reason": ["; ".join(r) for r in reasons.values()]},
        schema={"_row": pl.UInt32, "reason": pl.String},
    )
    rejected = frame.join(bad, on="_row", how="inner").drop("_row")
    valid = frame.join(bad, on="_row", how="anti").drop("_row")
    return valid, rejected


def quarantine_rows(
    rejected: pl.DataFrame, parser_version: str, calibration_version: str
) -> pl.DataFrame:
    """Rows of `silver.flashes_quarantine`: the rejected record as JSON, with its reason."""
    records = rejected.drop("reason").with_columns(pl.col(pl.Enum).cast(pl.String))
    return pl.DataFrame(
        {
            "source": rejected["source"].cast(pl.String),
            "product_file": rejected["product_file"],
            "ingest_time": rejected["ingest_time"],
            "reason": rejected["reason"],
            "record": [json.dumps(r, default=str) for r in records.iter_rows(named=True)],
            "parser_version": [parser_version] * rejected.height,
            "calibration_version": [calibration_version] * rejected.height,
            "native_flash_id": rejected["native_flash_id"],
            "event_time": rejected["event_time"],
        }
    )
