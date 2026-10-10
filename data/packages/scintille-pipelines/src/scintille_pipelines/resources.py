"""Dagster resources, configured from the environment."""

import os
from collections.abc import Iterator
from contextlib import contextmanager

import duckdb
import psycopg
from dagster import ConfigurableResource, EnvVar
from obstore.store import S3Store
from pyiceberg.catalog import Catalog
from scintille_lake.config import LOCAL_URI, LOCAL_WAREHOUSE, LakeConfig
from scintille_lake.connect import duckdb_attach, pyiceberg_catalog

LOCAL_POSTGRES = "postgresql://postgres:postgres@localhost:55432/scintille"


class LakeResource(ConfigurableResource):  # type: ignore[type-arg]
    """Iceberg REST catalog, through PyIceberg or DuckDB."""

    uri: str = LOCAL_URI
    warehouse: str = LOCAL_WAREHOUSE
    token: str | None = None

    @property
    def config(self) -> LakeConfig:
        return LakeConfig(self.uri, self.warehouse, self.token)

    def catalog(self) -> Catalog:
        return pyiceberg_catalog(self.config)

    @contextmanager
    def duckdb(self) -> Iterator[duckdb.DuckDBPyConnection]:
        connection = duckdb.connect()
        try:
            duckdb_attach(connection, self.config)
            yield connection
        finally:
            connection.close()


class PostgresResource(ConfigurableResource):  # type: ignore[type-arg]
    """Pipeline state; also holds the per-partition write lock shared with lake-writer."""

    dsn: str = LOCAL_POSTGRES

    @contextmanager
    def connect(self) -> Iterator[psycopg.Connection]:
        with psycopg.connect(self.dsn, autocommit=True) as connection:
            yield connection

    @contextmanager
    def partition_lock(self, key: str, wait: bool = True) -> Iterator[bool]:
        """Session advisory lock on `key` (e.g. `silver.flashes/2026-07-15/glm-east`).

        Yields whether the lock is held; with `wait=False` it does not block.
        """
        with self.connect() as connection:
            if wait:
                connection.execute("SELECT pg_advisory_lock(hashtextextended(%s, 0))", [key])
                held = True
            else:
                row = connection.execute(
                    "SELECT pg_try_advisory_lock(hashtextextended(%s, 0))", [key]
                ).fetchone()
                held = bool(row and row[0])
            try:
                yield held
            finally:
                if held:
                    connection.execute("SELECT pg_advisory_unlock(hashtextextended(%s, 0))", [key])


class R2Resource(ConfigurableResource):  # type: ignore[type-arg]
    """S3-compatible bucket: R2 in production, the local store in development."""

    endpoint: str = "http://localhost:9000"
    bucket: str = "scintille-lake"
    access_key_id: str = "scintille-local"
    secret_access_key: str = "scintille-local-secret"
    region: str = "auto"

    def store(self) -> S3Store:
        return S3Store(
            self.bucket,
            endpoint=self.endpoint,
            access_key_id=self.access_key_id,
            secret_access_key=self.secret_access_key,
            region=self.region,
            virtual_hosted_style_request=False,
            client_options={"allow_http": self.endpoint.startswith("http://")},
        )


def env_or(name: str, default: str) -> str | EnvVar:
    """An `EnvVar` when the variable is set, so Dagster never shows its value; else the default."""
    return EnvVar(name) if os.environ.get(name) else default


def resources() -> dict[str, ConfigurableResource]:  # type: ignore[type-arg]
    token = EnvVar("SCINTILLE_LAKE_TOKEN") if os.environ.get("SCINTILLE_LAKE_TOKEN") else None
    return {
        "lake": LakeResource(
            uri=env_or("SCINTILLE_LAKE_URI", LOCAL_URI),
            warehouse=env_or("SCINTILLE_LAKE_WAREHOUSE", LOCAL_WAREHOUSE),
            token=token,
        ),
        "postgres": PostgresResource(dsn=env_or("SCINTILLE_POSTGRES_DSN", LOCAL_POSTGRES)),
        "r2": R2Resource(
            endpoint=env_or("SCINTILLE_R2_ENDPOINT", "http://localhost:9000"),
            bucket=env_or("SCINTILLE_R2_BUCKET", "scintille-lake"),
            access_key_id=env_or("SCINTILLE_R2_ACCESS_KEY_ID", "scintille-local"),
            secret_access_key=env_or("SCINTILLE_R2_SECRET_ACCESS_KEY", "scintille-local-secret"),
        ),
    }
