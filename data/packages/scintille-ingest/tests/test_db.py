from typing import Any

import psycopg
import pytest
from scintille_ingest.runtime.db import Database


class FakeConnection:
    def __init__(self) -> None:
        self.closed = False
        self.statements: list[str] = []

    def execute(self, query: str, params: Any = None) -> str:
        if self.closed:
            raise psycopg.OperationalError("the connection is closed")
        self.statements.append(query)
        return query


def test_reopens_a_dropped_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    opened: list[FakeConnection] = []

    def connect(*args: Any, **kwargs: Any) -> FakeConnection:
        opened.append(FakeConnection())
        return opened[-1]

    monkeypatch.setattr(psycopg, "connect", connect)
    database = Database("postgresql://test", "CREATE TABLE IF NOT EXISTS t ()")
    opened[0].closed = True
    database.execute("SELECT 1")
    assert len(opened) == 2
    assert opened[1].statements == ["CREATE TABLE IF NOT EXISTS t ()", "SELECT 1"]
