"""Per-file states: downloaded → published_live → spooled. Every transition is idempotent."""

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal, Protocol

import psycopg

from .identity import FileIdentity

FileState = Literal["downloaded", "published_live", "spooled"]
ORDER: dict[FileState, int] = {"downloaded": 0, "published_live": 1, "spooled": 2}


@dataclass(frozen=True)
class FileRecord:
    identity: FileIdentity
    source: str
    state: FileState
    batch_id: str | None


class StateStore(Protocol):
    def get(self, identity: FileIdentity) -> FileRecord | None: ...

    def advance(
        self, identity: FileIdentity, source: str, state: FileState, batch_id: str | None = None
    ) -> None:
        """Moves a file forward; never backward, so replaying a step changes nothing."""
        ...

    def spooled_keys(self, source: str, keys: list[str]) -> set[str]:
        """Which of `keys` already reached the spool, whatever their checksum."""
        ...


class MemoryState:
    """For tests and local runs without Postgres."""

    def __init__(self) -> None:
        self.records: dict[FileIdentity, FileRecord] = {}

    def get(self, identity: FileIdentity) -> FileRecord | None:
        return self.records.get(identity)

    def advance(
        self, identity: FileIdentity, source: str, state: FileState, batch_id: str | None = None
    ) -> None:
        old = self.records.get(identity)
        if old and ORDER[old.state] >= ORDER[state]:
            return
        kept = old.batch_id if old else None
        self.records[identity] = FileRecord(identity, source, state, batch_id or kept)

    def spooled_keys(self, source: str, keys: list[str]) -> set[str]:
        wanted = set(keys)
        return {
            r.identity.key
            for r in self.records.values()
            if r.source == source and r.state == "spooled" and r.identity.key in wanted
        }


SCHEMA = """
CREATE TABLE IF NOT EXISTS ingest_files (
    key text NOT NULL,
    checksum text NOT NULL,
    source text NOT NULL,
    state text NOT NULL CHECK (state IN ('downloaded', 'published_live', 'spooled')),
    batch_id text,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (key, checksum)
);
CREATE INDEX IF NOT EXISTS ingest_files_source_key ON ingest_files (source, key);
"""


class PostgresState:
    """Shared with Dagster's Postgres; one row per file identity."""

    def __init__(self, dsn: str) -> None:
        self._conn = psycopg.connect(dsn, autocommit=True)
        self._conn.execute(SCHEMA)

    def get(self, identity: FileIdentity) -> FileRecord | None:
        row = self._conn.execute(
            "SELECT source, state, batch_id FROM ingest_files WHERE key = %s AND checksum = %s",
            [identity.key, identity.checksum],
        ).fetchone()
        return FileRecord(identity, row[0], row[1], row[2]) if row else None

    def advance(
        self, identity: FileIdentity, source: str, state: FileState, batch_id: str | None = None
    ) -> None:
        self._conn.execute(
            """
            INSERT INTO ingest_files (key, checksum, source, state, batch_id, updated_at)
            VALUES (%(key)s, %(checksum)s, %(source)s, %(state)s, %(batch)s, %(now)s)
            ON CONFLICT (key, checksum) DO UPDATE
            SET state = EXCLUDED.state,
                batch_id = COALESCE(EXCLUDED.batch_id, ingest_files.batch_id),
                updated_at = EXCLUDED.updated_at
            WHERE array_position(%(order)s::text[], EXCLUDED.state)
                > array_position(%(order)s::text[], ingest_files.state)
            """,
            {
                "key": identity.key,
                "checksum": identity.checksum,
                "source": source,
                "state": state,
                "batch": batch_id,
                "now": datetime.now(UTC),
                "order": list(ORDER),
            },
        )

    def spooled_keys(self, source: str, keys: list[str]) -> set[str]:
        rows = self._conn.execute(
            "SELECT DISTINCT key FROM ingest_files WHERE source = %s AND state = 'spooled'"
            " AND key = ANY(%s)",
            [source, keys],
        ).fetchall()
        return {row[0] for row in rows}

    def close(self) -> None:
        self._conn.close()
