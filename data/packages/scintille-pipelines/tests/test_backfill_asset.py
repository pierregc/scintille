from datetime import date

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
