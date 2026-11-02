"""One autocommit Postgres connection that reopens after the server restarts (#380)."""

from typing import Any

import psycopg
from psycopg.abc import Params, QueryNoTemplate

CONNECT_TIMEOUT_S = 10


class Database:
    """A statement that meets a dropped connection fails; the next one reconnects."""

    def __init__(self, dsn: str, schema: QueryNoTemplate) -> None:
        self._dsn = dsn
        self._schema = schema
        self._conn = self._open()

    def _open(self) -> psycopg.Connection[Any]:
        conn = psycopg.connect(self._dsn, autocommit=True, connect_timeout=CONNECT_TIMEOUT_S)
        conn.execute(self._schema)
        return conn

    def execute(self, query: QueryNoTemplate, params: Params | None = None) -> psycopg.Cursor[Any]:
        if self._conn.closed:
            self._conn = self._open()
        return self._conn.execute(query, params)

    def close(self) -> None:
        self._conn.close()
