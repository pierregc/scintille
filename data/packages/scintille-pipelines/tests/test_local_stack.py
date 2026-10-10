"""Against the local stack from compose.yaml (Lakekeeper and Postgres)."""

from datetime import date

import pytest
from dagster import materialize
from scintille_pipelines.assets import daily_flash_counts
from scintille_pipelines.backfill import spooled_keys
from scintille_pipelines.resources import LakeResource, PostgresResource

pytestmark = pytest.mark.lake


def test_materializes_against_lakekeeper() -> None:
    result = materialize(
        [daily_flash_counts], partition_key="2026-07-15", resources={"lake": LakeResource()}
    )
    assert result.success


def test_partition_lock_is_exclusive() -> None:
    postgres = PostgresResource()
    key = "silver.flashes/2026-07-15/glm-east"
    with postgres.partition_lock(key) as held:
        assert held
        with postgres.partition_lock(key, wait=False) as other:
            assert not other
    with postgres.partition_lock(key, wait=False) as after:
        assert after


def test_spooled_keys_of_a_day() -> None:
    postgres = PostgresResource()
    name = "OR_GLM-L2-LCFA_G18_s20261960000000_e20261960000200_c20261960000220.nc"
    keys = [f"GLM-L2-LCFA/2026/196/00/{name}", "GLM-L2-LCFA/2026/197/00/s2026196.nc"]
    with postgres.connect() as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS ingest_files (key text NOT NULL, checksum text NOT NULL,"
            " source text NOT NULL, state text NOT NULL, batch_id text,"
            " updated_at timestamptz NOT NULL, PRIMARY KEY (key, checksum))"
        )
        for key in keys:
            conn.execute(
                "INSERT INTO ingest_files VALUES (%s, 'sha256:t', 'glm-west', 'spooled', NULL,"
                " now()) ON CONFLICT DO NOTHING",
                [key],
            )
    assert spooled_keys(postgres, date(2026, 7, 15), "glm-west") >= {keys[0]}
    assert keys[1] not in spooled_keys(postgres, date(2026, 7, 15), "glm-west")
    assert keys[0] not in spooled_keys(postgres, date(2026, 7, 15), "glm-east")
