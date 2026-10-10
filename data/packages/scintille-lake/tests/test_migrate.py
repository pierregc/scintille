from collections.abc import Callable
from dataclasses import replace

import pyarrow as pa
import pytest
from pyiceberg.catalog import Catalog
from pyiceberg.partitioning import PartitionSpec
from pyiceberg.schema import Schema
from pyiceberg.table import Table
from pyiceberg.types import IntegerType, NestedField, StringType
from scintille_lake.config import LOCAL_URI, LakeConfig
from scintille_lake.migrate import IncompatibleChange, migrate
from scintille_lake.tables import FLASHES, INGEST_LOG, MERGE_ON_READ, TABLES, gold_table


def with_field(schema: Schema, field: NestedField) -> Schema:
    return Schema(*schema.fields, field)


def test_creates_everything_then_is_idempotent(catalog: Catalog) -> None:
    first = migrate(catalog)
    assert "create namespace gold" in first
    assert {f"create table {'.'.join(t.identifier)}" for t in TABLES} <= set(first)
    assert migrate(catalog) == []


def test_flashes_layout(catalog: Catalog) -> None:
    migrate(catalog)
    table = catalog.load_table(FLASHES.identifier)
    assert [(f.name, str(f.transform)) for f in table.spec().fields] == [
        ("event_day", "day"),
        ("source", "identity"),
    ]
    assert table.schema().find_column_name(table.sort_order().fields[0].source_id) == "event_time"
    assert {"parser_version", "calibration_version"} <= {f.name for f in table.schema().fields}


def test_adds_optional_columns_once(catalog: Catalog) -> None:
    migrate(catalog)
    extra = NestedField(100, "note", StringType(), required=False)
    evolved = replace(INGEST_LOG, schema=with_field(INGEST_LOG.schema, extra))
    assert migrate(catalog, (evolved,)) == ["add column bronze.ingest_log.note"]
    assert migrate(catalog, (evolved,)) == []


def test_upgrades_flashes_created_with_required_intensity(
    catalog: Catalog, flash_rows: Callable[[str, Table], pa.Table]
) -> None:
    fields = [
        f.model_copy(update={"required": True}) if f.name == "intensity" else f
        for f in FLASHES.schema.fields
    ]
    old = replace(FLASHES, schema=Schema(*fields))
    migrate(catalog, tuple(old if t is FLASHES else t for t in TABLES))
    catalog.load_table(FLASHES.identifier).append(
        flash_rows("old.nc", catalog.load_table(FLASHES.identifier))
    )

    assert migrate(catalog) == ["make column silver.flashes.intensity optional"]
    assert migrate(catalog) == []
    table = catalog.load_table(FLASHES.identifier)
    assert not table.schema().find_field("intensity").required
    rows = flash_rows("new.nc", table).set_column(10, "intensity", pa.nulls(3, pa.float32()))
    table.append(rows)
    intensity = table.scan().to_arrow().sort_by("product_file")["intensity"].to_pylist()
    assert intensity == [None] * 3 + [0.5] * 3


def test_refuses_making_a_column_required(catalog: Catalog) -> None:
    migrate(catalog)
    fields = [
        f.model_copy(update={"required": True}) if f.name == "error" else f
        for f in INGEST_LOG.schema.fields
    ]
    with pytest.raises(IncompatibleChange, match="error changed"):
        migrate(catalog, (replace(INGEST_LOG, schema=Schema(*fields)),))


@pytest.mark.parametrize(
    "schema",
    [
        with_field(INGEST_LOG.schema, NestedField(100, "note", StringType(), required=True)),
        Schema(*INGEST_LOG.schema.fields[:-1]),
        Schema(
            *INGEST_LOG.schema.fields[:-1],
            NestedField(11, "error", IntegerType(), required=False),
        ),
    ],
    ids=["required-column", "removed-column", "type-change"],
)
def test_refuses_non_additive_changes(catalog: Catalog, schema: Schema) -> None:
    migrate(catalog)
    with pytest.raises(IncompatibleChange):
        migrate(catalog, (replace(INGEST_LOG, schema=schema),))


def test_refuses_repartitioning(catalog: Catalog) -> None:
    migrate(catalog)
    with pytest.raises(IncompatibleChange, match="partitioning"):
        migrate(catalog, (replace(FLASHES, partition_spec=PartitionSpec()),))


def test_restores_drifted_properties(catalog: Catalog) -> None:
    migrate(catalog)
    table = catalog.load_table(FLASHES.identifier)
    with table.transaction() as tx:
        tx.set_properties({"write.parquet.compression-codec": "snappy"})
    assert migrate(catalog) == ["set silver.flashes write.parquet.compression-codec=zstd"]


def test_gold_tables_are_merge_on_read() -> None:
    table = gold_table("storms", Schema(NestedField(1, "storm_id", StringType(), required=True)))
    assert table.identifier == ("gold", "storms")
    assert MERGE_ON_READ.items() <= table.properties.items()


def test_write_and_read_back(
    catalog: Catalog, flash_rows: Callable[[str, Table], pa.Table]
) -> None:
    migrate(catalog)
    table = catalog.load_table(FLASHES.identifier)
    table.append(flash_rows("unit.nc", table))
    rows = table.scan(row_filter="product_file == 'unit.nc'").to_arrow()
    assert rows.num_rows == 3
    assert rows.sort_by("lat")["lat"].to_pylist() == [10.5, 11.5, 12.5]


def test_config_from_env() -> None:
    assert LakeConfig.from_env({}).uri == LOCAL_URI
    config = LakeConfig.from_env(
        {
            "SCINTILLE_LAKE_URI": "https://catalog.example/acct/bucket",
            "SCINTILLE_LAKE_WAREHOUSE": "acct_bucket",
            "SCINTILLE_LAKE_TOKEN": "t",
        }
    )
    assert config.pyiceberg_properties() == {
        "type": "rest",
        "uri": "https://catalog.example/acct/bucket",
        "warehouse": "acct_bucket",
        "token": "t",
    }
