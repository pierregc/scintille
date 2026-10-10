"""Table definitions as code."""

from dataclasses import dataclass, field

from pyiceberg.partitioning import PartitionField, PartitionSpec
from pyiceberg.schema import Schema
from pyiceberg.table.sorting import SortField, SortOrder
from pyiceberg.transforms import DayTransform, IdentityTransform
from pyiceberg.types import (
    DoubleType,
    FloatType,
    ListType,
    LongType,
    NestedField,
    StringType,
    TimestamptzType,
)

NAMESPACES = ("bronze", "silver", "gold")

BASE_PROPERTIES = {
    "format-version": "2",
    "write.parquet.compression-codec": "zstd",
}

MERGE_ON_READ = {
    "write.delete.mode": "merge-on-read",
    "write.update.mode": "merge-on-read",
    "write.merge.mode": "merge-on-read",
}


@dataclass(frozen=True)
class TableDef:
    namespace: str
    name: str
    schema: Schema
    partition_spec: PartitionSpec = field(default_factory=PartitionSpec)
    sort_order: SortOrder = field(default_factory=SortOrder)
    properties: dict[str, str] = field(default_factory=lambda: dict(BASE_PROPERTIES))

    @property
    def identifier(self) -> tuple[str, str]:
        return (self.namespace, self.name)


def gold_table(name: str, schema: Schema, partition_spec: PartitionSpec | None = None) -> TableDef:
    """A gold table: always merge-on-read."""
    return TableDef(
        "gold",
        name,
        schema,
        partition_spec or PartitionSpec(),
        properties={**BASE_PROPERTIES, **MERGE_ON_READ},
    )


INGEST_LOG = TableDef(
    "bronze",
    "ingest_log",
    Schema(
        NestedField(1, "key", StringType(), required=True),
        NestedField(2, "source", StringType(), required=True),
        NestedField(3, "satellite", StringType(), required=True),
        NestedField(4, "product_start", TimestamptzType(), required=True),
        NestedField(5, "product_end", TimestamptzType(), required=True),
        NestedField(6, "received_at", TimestamptzType(), required=True),
        NestedField(7, "row_count", LongType(), required=True),
        NestedField(8, "checksum", StringType(), required=True),
        NestedField(9, "status", StringType(), required=True),
        NestedField(10, "parse_duration_ms", DoubleType(), required=True),
        NestedField(11, "error", StringType(), required=False),
    ),
    PartitionSpec(PartitionField(4, 1000, DayTransform(), "product_day")),
)

_FLASH_FIELDS = (
    NestedField(1, "flash_id", StringType(), required=True),
    NestedField(2, "source", StringType(), required=True),
    NestedField(3, "product_file", StringType(), required=True),
    NestedField(4, "native_flash_id", LongType(), required=True),
    NestedField(5, "event_time", TimestamptzType(), required=True),
    NestedField(6, "ingest_time", TimestamptzType(), required=True),
    NestedField(7, "lat", DoubleType(), required=True),
    NestedField(8, "lon", DoubleType(), required=True),
    NestedField(9, "energy_raw", DoubleType(), required=True),
    NestedField(10, "energy_unit", StringType(), required=True),
    NestedField(
        11,
        "intensity",
        FloatType(),
        required=False,
        doc="Null until cross-source calibration (#33).",
    ),
    NestedField(12, "area_km2", FloatType(), required=True),
    NestedField(13, "duration_ms", FloatType(), required=True),
    NestedField(14, "quality", ListType(15, StringType(), element_required=True), required=True),
    NestedField(16, "parser_version", StringType(), required=True),
    NestedField(17, "calibration_version", StringType(), required=True),
)

FLASHES = TableDef(
    "silver",
    "flashes",
    Schema(*_FLASH_FIELDS),
    PartitionSpec(
        PartitionField(5, 1000, DayTransform(), "event_day"),
        PartitionField(2, 1001, IdentityTransform(), "source"),
    ),
    SortOrder(SortField(source_id=5, transform=IdentityTransform())),
)

FLASHES_QUARANTINE = TableDef(
    "silver",
    "flashes_quarantine",
    Schema(
        NestedField(1, "source", StringType(), required=True),
        NestedField(2, "product_file", StringType(), required=True),
        NestedField(3, "ingest_time", TimestamptzType(), required=True),
        NestedField(4, "reason", StringType(), required=True),
        NestedField(5, "record", StringType(), required=True, doc="Rejected row as JSON."),
        NestedField(6, "parser_version", StringType(), required=True),
        NestedField(7, "calibration_version", StringType(), required=True),
        NestedField(8, "native_flash_id", LongType(), required=False),
        NestedField(9, "event_time", TimestamptzType(), required=False),
    ),
    PartitionSpec(PartitionField(3, 1000, DayTransform(), "ingest_day")),
)

TABLES: tuple[TableDef, ...] = (INGEST_LOG, FLASHES, FLASHES_QUARANTINE)
