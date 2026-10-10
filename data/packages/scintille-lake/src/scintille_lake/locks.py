"""One writer per partition: Postgres session advisory locks shared by lake-writer and backfills."""

from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from datetime import date

import psycopg


def partition_key(table: str, day: date, source: str) -> str:
    """e.g. `silver.flashes/2026-07-15/glm-east`."""
    return f"{table}/{day.isoformat()}/{source}"


@contextmanager
def partition_locks(dsn: str, keys: Iterable[str]) -> Iterator[None]:
    """Holds every lock in `keys`, taken in sorted order so two writers cannot deadlock."""
    ordered = sorted(set(keys))
    with psycopg.connect(dsn, autocommit=True) as conn:
        for key in ordered:
            conn.execute("SELECT pg_advisory_lock(hashtextextended(%s, 0))", [key])
        try:
            yield
        finally:
            for key in reversed(ordered):
                conn.execute("SELECT pg_advisory_unlock(hashtextextended(%s, 0))", [key])
