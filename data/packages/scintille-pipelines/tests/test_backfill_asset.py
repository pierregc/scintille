from datetime import date
from pathlib import Path

import yaml  # type: ignore[import-untyped]
from dagster import AssetKey, instance_for_test
from scintille_pipelines.backfill import bucket_for, partitions
from scintille_pipelines.definitions import defs


def test_picks_the_satellite_operating_each_slot() -> None:
    assert bucket_for("glm-east", date(2025, 4, 6)) == "noaa-goes16"
    assert bucket_for("glm-east", date(2025, 4, 7)) == "noaa-goes19"
    assert bucket_for("glm-west", date(2022, 12, 31)) == "noaa-goes17"
    assert bucket_for("glm-west", date(2026, 7, 15)) == "noaa-goes18"


def test_partitions_are_day_by_source() -> None:
    assert set(partitions.partition_dimension_names) == {"day", "source"}
    graph = defs.get_repository_def().asset_graph
    assert any(key.path == ["silver", "flashes_backfill"] for key in graph.get_all_asset_keys())


def test_backfill_runs_share_the_noaa_pool() -> None:
    graph = defs.resolve_asset_graph()
    node = graph.get(AssetKey(["silver", "flashes_backfill"]))
    assert node.pools == {"noaa"}


def test_the_queue_admits_one_noaa_run_at_a_time() -> None:
    config = yaml.safe_load((Path(__file__).parents[1] / "dagster_home/dagster.yaml").read_text())
    assert config["concurrency"]["pools"] == {"granularity": "run", "default_limit": 1}
    with instance_for_test(overrides={"concurrency": config["concurrency"]}) as instance:
        storage = instance.event_log_storage
        assert storage.initialize_concurrency_limit_to_default("noaa")
        assert storage.get_concurrency_info("noaa").slot_count == 1
        assert storage.claim_concurrency_slot("noaa", "run-1", "step").is_claimed
        assert not storage.claim_concurrency_slot("noaa", "run-2", "step").is_claimed
