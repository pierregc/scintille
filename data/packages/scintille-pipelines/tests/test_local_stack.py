"""Against the local stack from compose.yaml (Lakekeeper and Postgres)."""

import pytest
from dagster import materialize
from scintille_pipelines.assets import daily_flash_counts
from scintille_pipelines.resources import LakeResource, PostgresResource
from scintille_pipelines.storm_cells import storm_cells
from scintille_pipelines.storm_names import storm_names
from scintille_pipelines.storms import storm_tracks, storms

pytestmark = pytest.mark.lake


def test_materializes_against_lakekeeper() -> None:
    result = materialize(
        [daily_flash_counts], partition_key="2026-07-15", resources={"lake": LakeResource()}
    )
    assert result.success


def test_storm_cells_rerun_against_lakekeeper() -> None:
    for _ in range(2):
        result = materialize(
            [storm_cells, storm_tracks, storms, storm_names],
            partition_key="2026-07-15-18:00",
            resources={"lake": LakeResource()},
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
