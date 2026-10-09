"""Catalog connections: PyIceberg and DuckDB, from the same config."""

import duckdb
from pyiceberg.catalog import Catalog, load_catalog

from .config import LakeConfig


def pyiceberg_catalog(config: LakeConfig | None = None) -> Catalog:
    config = config or LakeConfig.from_env()
    return load_catalog("scintille", **config.pyiceberg_properties())


def duckdb_attach(
    connection: duckdb.DuckDBPyConnection, config: LakeConfig | None = None, alias: str = "lake"
) -> None:
    """Attaches the REST catalog as `alias`; tables are then `alias.namespace.table`."""
    config = config or LakeConfig.from_env()
    connection.execute("INSTALL iceberg; LOAD iceberg; INSTALL httpfs; LOAD httpfs")
    if config.token:
        token = _literal(config.token)
        connection.execute(f"CREATE OR REPLACE SECRET {alias}_secret (TYPE iceberg, TOKEN {token})")
        auth = f"SECRET {alias}_secret"
    else:
        auth = "AUTHORIZATION_TYPE 'none'"
    connection.execute(
        f"ATTACH {_literal(config.warehouse)} AS {alias} "
        f"(TYPE iceberg, ENDPOINT {_literal(config.uri)}, {auth})"
    )


def _literal(value: str) -> str:
    """SQL string literal; ATTACH and CREATE SECRET take no bound parameters."""
    return "'" + value.replace("'", "''") + "'"
