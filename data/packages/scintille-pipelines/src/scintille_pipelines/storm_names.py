"""`gold/storm_names`: a place name and a stable slug for each storm."""

from collections.abc import Iterable
from datetime import timedelta

import polars as pl
from dagster import (
    AssetCheckResult,
    AssetCheckSeverity,
    AssetCheckSpec,
    AssetExecutionContext,
    AssetKey,
    MaterializeResult,
    asset,
)
from pyiceberg.partitioning import PartitionField, PartitionSpec
from pyiceberg.schema import Schema
from pyiceberg.transforms import DayTransform
from pyiceberg.types import (
    BooleanType,
    DateType,
    DoubleType,
    NestedField,
    StringType,
    TimestamptzType,
)
from scintille_lake.migrate import sync_table
from scintille_lake.tables import gold_table

from .geocoding import Geocoder, base_slug, geodata_version, unique_slugs
from .resources import LakeResource
from .storm_cells import BACKFILL, hourly
from .storms import STORMS, STORMS_CHECK, _between, _scan

STORM_NAMES = gold_table(
    "storm_names",
    Schema(
        NestedField(1, "storm_id", StringType(), required=True),
        NestedField(2, "storm_start", TimestamptzType(), required=True),
        NestedField(3, "day", DateType(), required=True, doc="UTC day of the first flash."),
        NestedField(4, "slug", StringType(), required=True, doc="Unique, never changes."),
        NestedField(5, "name", StringType(), required=True, doc="Place, region, country or sea."),
        NestedField(6, "label", StringType(), required=True, doc="Full English name."),
        NestedField(7, "place", StringType(), required=False, doc="GeoNames city."),
        NestedField(8, "place_km", DoubleType(), required=False),
        NestedField(9, "region", StringType(), required=False, doc="GeoNames admin-1."),
        NestedField(10, "country_code", StringType(), required=False, doc="Land only."),
        NestedField(11, "country_name", StringType(), required=False),
        NestedField(12, "sea", StringType(), required=False, doc="Offshore only."),
        NestedField(13, "offshore", BooleanType(), required=True),
        NestedField(14, "lat", DoubleType(), required=True, doc="Centroid when first named."),
        NestedField(15, "lon", DoubleType(), required=True),
        NestedField(16, "geodata", StringType(), required=True, doc="Reference data version."),
    ),
    PartitionSpec(PartitionField(2, 1000, DayTransform(), "start_day")),
)


def name_storms(storms: pl.DataFrame, taken: Iterable[str]) -> pl.DataFrame:
    """Names the storms, with slugs unique among themselves and `taken`."""
    storms = storms.sort("t_start", "storm_id")
    names = Geocoder.load().locate(storms["lat"], storms["lon"])
    rows = pl.concat(
        [
            storms.select(
                "storm_id", "storm_start", pl.col("t_start").dt.date().alias("day"), "lat", "lon"
            ),
            names,
        ],
        how="horizontal",
    )
    bases = [
        base_slug(r["day"], r["name"], r["offshore"], r["place"])
        for r in rows.select("day", "name", "offshore", "place").iter_rows(named=True)
    ]
    return rows.with_columns(
        slug=pl.Series(unique_slugs(bases, taken), dtype=pl.String()),
        geodata=pl.lit(geodata_version()),
    ).select(STORM_NAMES.schema.column_names)


KEYS = ("storm_id", "slug")
NAMES_CHECK = AssetCheckSpec(
    "unique_slugs",
    asset=AssetKey(["gold", "storm_names"]),
    blocking=True,
    description="One name per storm and no slug used twice, over the days written.",
)


def check_names(names: pl.DataFrame) -> AssetCheckResult:
    slugs = names.height - names["slug"].n_unique()
    storms = names.height - names["storm_id"].n_unique()
    return AssetCheckResult(
        check_name=NAMES_CHECK.name,
        passed=slugs == storms == 0,
        severity=AssetCheckSeverity.ERROR,
        metadata={"rows": names.height, "duplicate_slugs": slugs, "duplicate_storms": storms},
    )


@asset(
    key=NAMES_CHECK.asset_key,
    partitions_def=hourly,
    deps=[STORMS_CHECK.asset_key],
    backfill_policy=BACKFILL,
    pool="storm-tracks",
    group_name="gold",
    check_specs=[NAMES_CHECK],
    description="Storms starting in the hours, named once from their centroid (Natural Earth, "
    "GeoNames).",
)
def storm_names(context: AssetExecutionContext, lake: LakeResource) -> MaterializeResult:  # type: ignore[type-arg]
    start, end = context.partition_time_window
    catalog = lake.catalog()
    sync_table(catalog, STORM_NAMES)
    table = catalog.load_table(STORM_NAMES.identifier)
    storms = _scan(catalog.load_table(STORMS.identifier), _between("storm_start", start, end))
    # A first flash can precede its first window by a few minutes, hence the day before.
    first, last = (start - timedelta(days=1)).date(), end.date()
    existing = _scan(table, f"day >= '{first.isoformat()}' AND day <= '{last.isoformat()}'")
    new = storms.join(existing.select("storm_id"), on="storm_id", how="anti")
    rows = name_storms(new, existing["slug"])
    orphans = existing.filter(pl.col("storm_start").is_between(start, end, closed="left")).join(
        storms.select("storm_id"), on="storm_id", how="anti"
    )
    if not rows.is_empty():
        table.append(rows.to_arrow().cast(table.schema().as_arrow()))
    return MaterializeResult(
        metadata={
            "storms": storms.height,
            "named": rows.height,
            "offshore": int(rows["offshore"].sum()),
            "orphans": orphans.height,
            "geodata": geodata_version(),
        },
        check_results=[check_names(pl.concat([existing.select(KEYS), rows.select(KEYS)]))],
    )
