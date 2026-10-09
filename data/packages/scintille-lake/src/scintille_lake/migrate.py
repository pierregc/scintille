"""Idempotent creation and additive evolution of the lakehouse tables."""

from pyiceberg.catalog import Catalog
from pyiceberg.exceptions import NamespaceAlreadyExistsError, NoSuchTableError
from pyiceberg.partitioning import PartitionSpec
from pyiceberg.schema import Schema
from pyiceberg.table import Table
from pyiceberg.table.sorting import SortOrder

from .tables import NAMESPACES, TABLES, TableDef


# Set at creation only; catalogs reject them as property updates.
CREATE_ONLY = frozenset({"format-version"})


class IncompatibleChange(Exception):
    """A change the policy forbids without a new table version."""


def migrate(catalog: Catalog, tables: tuple[TableDef, ...] = TABLES) -> list[str]:
    """Brings the catalog to the definitions; returns what changed (empty when up to date)."""
    changes: list[str] = []
    existing = {ns[0] for ns in catalog.list_namespaces()}
    for namespace in NAMESPACES:
        if namespace in existing:
            continue
        try:
            catalog.create_namespace(namespace)
            changes.append(f"create namespace {namespace}")
        except NamespaceAlreadyExistsError:
            pass
    for table in tables:
        changes += sync_table(catalog, table)
    return changes


def sync_table(catalog: Catalog, table: TableDef) -> list[str]:
    name = ".".join(table.identifier)
    try:
        current = catalog.load_table(table.identifier)
    except NoSuchTableError:
        catalog.create_table(
            table.identifier,
            schema=table.schema,
            partition_spec=table.partition_spec,
            sort_order=table.sort_order,
            properties=table.properties,
        )
        return [f"create table {name}"]

    check_layout(name, current, table)
    added = additive_columns(name, current.schema(), table.schema)
    changes = [f"add column {name}.{column}" for column in added]
    if added:
        with current.update_schema() as update:
            for column in added:
                field = table.schema.find_field(column)
                update.add_column(column, field.field_type, doc=field.doc)
    stale = {
        k: v
        for k, v in table.properties.items()
        if k not in CREATE_ONLY and current.properties.get(k) != v
    }
    if stale:
        with current.transaction() as tx:
            tx.set_properties(stale)
        changes += [f"set {name} {k}={v}" for k, v in sorted(stale.items())]
    return changes


def additive_columns(name: str, current: Schema, wanted: Schema) -> list[str]:
    """New optional top-level columns; anything else is an incompatible change."""
    have = {f.name: f for f in current.fields}
    want = {f.name: f for f in wanted.fields}
    removed = sorted(have.keys() - want.keys())
    if removed:
        raise IncompatibleChange(f"{name}: columns removed {removed}")
    added: list[str] = []
    for column, field in want.items():
        old = have.get(column)
        if old is None:
            if field.required:
                raise IncompatibleChange(f"{name}: new column {column} must be optional")
            added.append(column)
        elif str(old.field_type) != str(field.field_type) or old.required != field.required:
            raise IncompatibleChange(f"{name}: column {column} changed")
    return added


def check_layout(name: str, current: Table, table: TableDef) -> None:
    if _spec(current.schema(), current.spec()) != _spec(table.schema, table.partition_spec):
        raise IncompatibleChange(f"{name}: partitioning changed")
    if _order(current.schema(), current.sort_order()) != _order(table.schema, table.sort_order):
        raise IncompatibleChange(f"{name}: sort order changed")


def _spec(schema: Schema, spec: PartitionSpec) -> list[tuple[str, str, str]]:
    return [
        (schema.find_column_name(f.source_id) or "", str(f.transform), f.name) for f in spec.fields
    ]


def _order(schema: Schema, order: SortOrder) -> list[tuple[str, str, str]]:
    return [
        (schema.find_column_name(f.source_id) or "", str(f.transform), str(f.direction))
        for f in order.fields
    ]
