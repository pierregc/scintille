"""PostgresOps against the local Postgres from compose.yaml."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import psycopg
import pytest
from scintille_ingest.runtime.identity import FileIdentity
from scintille_ingest.runtime.ops import PostgresOps
from scintille_ingest.runtime.state import PostgresState

pytestmark = pytest.mark.lake
DSN = "postgresql://postgres:postgres@localhost:55432/scintille"


def test_file_stats_match_ingest_files() -> None:
    state, ops = PostgresState(DSN), PostgresOps(DSN)
    source = f"test-{uuid4().hex[:8]}"
    keys = [f"test/{uuid4().hex}.nc" for _ in range(5)]
    for key in keys:
        state.advance(FileIdentity(key, "sha256:1"), source, "spooled", "b")
    state.advance(FileIdentity(keys[0], "sha256:2"), source, "spooled", "b")
    state.advance(FileIdentity(f"test/{uuid4().hex}.nc", "sha256:1"), source, "downloaded")
    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute(
            "UPDATE ingest_files SET updated_at = now() - interval '2 hours' WHERE key = %s",
            [keys[1]],
        )
        expected = conn.execute(
            "SELECT count(DISTINCT key) FILTER (WHERE updated_at > now() - interval '1 hour'),"
            " max(updated_at) FROM ingest_files WHERE source = %s AND state = 'spooled'",
            [source],
        ).fetchone()
    stats = ops.file_stats(datetime.now(UTC))[source]
    assert expected is not None
    assert (
        (stats.files_last_hour, stats.last_file_time)
        == (expected[0], expected[1])
        == (4, expected[1])
    )
    assert stats.files_in_budget_window == 5
    assert stats.monitoring_start is not None
    assert stats.monitoring_start < datetime.now(UTC) - timedelta(minutes=110)
    state.close()
    ops.close()


def test_catalog_operations_add_up_per_month_and_statuses_round_trip() -> None:
    ops = PostgresOps(DSN)
    month = f"t{uuid4().hex[:6]}"
    ops.add_catalog_operations(month, 3)
    ops.add_catalog_operations(month, 1)
    assert ops.catalog_operations(month) == 4
    assert ops.catalog_operations("never") == 0
    name, at = f"test-{uuid4().hex[:8]}", datetime(2026, 7, 15, tzinfo=UTC)
    ops.put_status(name, {"status": "pass"}, at)
    ops.put_status(name, {"status": "fail"}, at + timedelta(hours=1))
    assert ops.status(name) == (at + timedelta(hours=1), {"status": "fail"})
    ops.close()
