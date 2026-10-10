"""Per-file states: downloaded → published_live → spooled. Every transition is idempotent."""

from collections.abc import Mapping
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
    etag: str | None = None


class StateStore(Protocol):
    def get(self, identity: FileIdentity) -> FileRecord | None: ...

    def advance(
        self,
        identity: FileIdentity,
        source: str,
        state: FileState,
        batch_id: str | None = None,
        etag: str | None = None,
    ) -> None:
        """Moves a file forward, never backward, so replaying a step changes nothing; records the
        latest upstream ETag seen for its content."""
        ...

    def spooled_keys(self, source: str, versions: Mapping[str, str | None]) -> set[str]:
        """Which keys of `versions` (key → listed ETag) already reached the spool under that
        ETag; an unknown ETag on either side matches any."""
        ...


class MemoryState:
    """For tests and local runs without Postgres."""

    def __init__(self) -> None:
        self.records: dict[FileIdentity, FileRecord] = {}

    def get(self, identity: FileIdentity) -> FileRecord | None:
        return self.records.get(identity)

    def advance(
        self,
        identity: FileIdentity,
        source: str,
        state: FileState,
        batch_id: str | None = None,
        etag: str | None = None,
    ) -> None:
        old = self.records.get(identity)
        if old is None:
            self.records[identity] = FileRecord(identity, source, state, batch_id, etag)
            return
        forward = ORDER[state] > ORDER[old.state]
        self.records[identity] = FileRecord(
            identity,
            old.source,
            state if forward else old.state,
            (batch_id if forward else None) or old.batch_id,
            etag or old.etag,
        )

    def spooled_keys(self, source: str, versions: Mapping[str, str | None]) -> set[str]:
        return {
            r.identity.key
            for r in self.records.values()
            if r.source == source
            and r.state == "spooled"
            and r.identity.key in versions
            and _same_version(r.etag, versions[r.identity.key])
        }


def _same_version(stored: str | None, listed: str | None) -> bool:
    return stored is None or listed is None or stored == listed


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
ALTER TABLE ingest_files ADD COLUMN IF NOT EXISTS etag text;
"""


FORWARD = (
    "array_position(%(order)s::text[], EXCLUDED.state)"
    " > array_position(%(order)s::text[], ingest_files.state)"
)


class PostgresState:
    """Shared with Dagster's Postgres; one row per file identity."""

    def __init__(self, dsn: str) -> None:
        self._conn = psycopg.connect(dsn, autocommit=True)
        self._conn.execute(SCHEMA)

    def get(self, identity: FileIdentity) -> FileRecord | None:
        row = self._conn.execute(
            "SELECT source, state, batch_id, etag FROM ingest_files"
            " WHERE key = %s AND checksum = %s",
            [identity.key, identity.checksum],
        ).fetchone()
        return FileRecord(identity, row[0], row[1], row[2], row[3]) if row else None

    def advance(
        self,
        identity: FileIdentity,
        source: str,
        state: FileState,
        batch_id: str | None = None,
        etag: str | None = None,
    ) -> None:
        self._conn.execute(
            f"""
            INSERT INTO ingest_files (key, checksum, source, state, batch_id, etag, updated_at)
            VALUES (%(key)s, %(checksum)s, %(source)s, %(state)s, %(batch)s, %(etag)s, %(now)s)
            ON CONFLICT (key, checksum) DO UPDATE
            SET state = CASE WHEN {FORWARD} THEN EXCLUDED.state ELSE ingest_files.state END,
                batch_id = COALESCE(
                    CASE WHEN {FORWARD} THEN EXCLUDED.batch_id END, ingest_files.batch_id
                ),
                etag = COALESCE(EXCLUDED.etag, ingest_files.etag),
                updated_at = EXCLUDED.updated_at
            WHERE {FORWARD}
                OR (EXCLUDED.etag IS NOT NULL AND EXCLUDED.etag IS DISTINCT FROM ingest_files.etag)
            """,
            {
                "key": identity.key,
                "checksum": identity.checksum,
                "source": source,
                "state": state,
                "batch": batch_id,
                "etag": etag,
                "now": datetime.now(UTC),
                "order": list(ORDER),
            },
        )

    def spooled_keys(self, source: str, versions: Mapping[str, str | None]) -> set[str]:
        rows = self._conn.execute(
            """
            SELECT DISTINCT f.key
            FROM ingest_files f
            JOIN unnest(%s::text[], %s::text[]) AS listed(key, etag) ON f.key = listed.key
            WHERE f.source = %s AND f.state = 'spooled'
                AND (listed.etag IS NULL OR f.etag IS NULL OR f.etag = listed.etag)
            """,
            [list(versions), list(versions.values()), source],
        ).fetchall()
        return {row[0] for row in rows}

    def close(self) -> None:
        self._conn.close()
