from datetime import UTC, datetime, timedelta

import polars as pl
import pytest
from dagster import AssetKey
from scintille_pipelines.definitions import defs
from scintille_pipelines.levels import LevelRule, classify, keep_live_maximum, level_of
from scintille_pipelines.storm_levels import StormLevelsConfig

T0 = datetime(2026, 7, 15, 18, tzinfo=UTC)
PROPOSAL = StormLevelsConfig().rule


def minutes(storm: str, source: str, counts: list[int]) -> pl.DataFrame:
    return pl.DataFrame(
        {
            "storm_id": storm,
            "source": source,
            "minute": [T0 + timedelta(minutes=m) for m in range(len(counts))],
            "flashes": counts,
        },
        schema_overrides={"minute": pl.Datetime("us", "UTC"), "flashes": pl.Int64},
    )


def test_defaults_are_the_adr_proposal() -> None:
    assert PROPOSAL.score == "flashes_x_peak"
    assert PROPOSAL.thresholds == (8, 25, 120, 450)
    assert PROPOSAL.names == ("Light", "Moderate", "Strong", "Intense", "Exceptional")
    assert PROPOSAL.count == "best_source"


def test_levels_start_at_their_threshold() -> None:
    scores = [0.0, 7.99, 8, 24.99, 25, 119.99, 120, 449.99, 450, 1e6]
    levels = pl.DataFrame({"score": scores}).select(level_of(pl.col("score"), PROPOSAL)).to_series()
    assert levels.to_list() == [1, 1, 2, 2, 3, 3, 4, 4, 5, 5]


def test_score_is_the_geometric_mean_of_flashes_and_peak() -> None:
    # 16 flashes, 4 per minute at most: score 8, the first Moderate.
    row = classify(minutes("a", "glm-east", [4, 4, 4, 4]), PROPOSAL).row(0, named=True)
    assert (row["flashes"], row["peak_rate"], row["score"]) == (16, 4, 8.0)
    assert (row["level"], row["level_name"]) == (2, "Moderate")
    below = classify(minutes("a", "glm-east", [4, 4, 4, 3]), PROPOSAL)
    assert below["level"][0] == 1


def test_counts_the_best_satellite_once() -> None:
    # The same storm seen by both: East 100 flashes peaking at 10, West 60 peaking at 20.
    both = pl.concat([minutes("a", "glm-east", [10] * 10), minutes("a", "glm-west", [20, 20, 20])])
    row = classify(both, PROPOSAL).row(0, named=True)
    assert row["level_source"] == "glm-west"
    assert (row["flashes"], row["peak_rate"]) == (60, 20)
    summed = classify(both, LevelRule("flashes", (100,), ("Low", "High"), "all_sources"))
    assert summed.row(0, named=True) | {"level_rule": None} == {
        "storm_id": "a",
        "level_source": "all",
        "flashes": 160,
        "peak_rate": 30,
        "score": 160.0,
        "level": 2,
        "level_name": "High",
        "level_rule": None,
    }


def test_adr_variants_are_config_only() -> None:
    storm = minutes("a", "glm-east", [10] * 30)  # 300 flashes, peak 10, score 54.8
    variant_a = StormLevelsConfig(
        thresholds=[10, 50, 450], names=["Light", "Moderate", "Strong", "Exceptional"]
    ).rule
    variant_b = StormLevelsConfig(score="flashes", thresholds=[25, 100, 750, 4000]).rule
    assert classify(storm, PROPOSAL)["level_name"][0] == "Strong"
    assert classify(storm, variant_a)["level_name"][0] == "Strong"
    assert classify(storm, variant_b)["level_name"][0] == "Strong"
    assert classify(minutes("a", "glm-east", [100] * 8), variant_b)["level_name"][0] == "Intense"
    assert str(variant_b) == "levels score=flashes count=best_source thresholds=25,100,750,4000"


@pytest.mark.parametrize(
    "rule",
    [
        dict(score="energy"),
        dict(count="any"),
        dict(names=["Light", "Strong"]),
        dict(thresholds=[8, 8, 120, 450]),
    ],
)
def test_rejects_bad_rules(rule: dict[str, object]) -> None:
    with pytest.raises(ValueError):
        _ = StormLevelsConfig(**rule).rule  # type: ignore[arg-type]


def test_live_level_never_drops() -> None:
    previous = pl.concat(
        [
            classify(minutes("live", "glm-east", [30] * 10), PROPOSAL),
            classify(minutes("closed", "glm-east", [30] * 10), PROPOSAL),
            classify(minutes("other", "glm-east", [30] * 10), PROPOSAL).with_columns(
                level_rule=pl.lit("old rule")
            ),
        ]
    ).with_columns(closed=pl.Series([False, True, False]))
    lower = pl.concat(
        [classify(minutes(s, "glm-east", [2] * 4), PROPOSAL) for s in ("live", "closed", "other")]
    )
    kept = keep_live_maximum(lower, previous).sort("storm_id")
    assert kept["storm_id"].to_list() == ["closed", "live", "other"]
    assert kept["level"].to_list() == [1, 3, 1]
    assert kept["flashes"].to_list() == [8, 300, 8]
    higher = classify(minutes("live", "glm-east", [60] * 60), PROPOSAL)
    assert keep_live_maximum(higher, previous)["level"][0] == 5


def test_registered_in_the_code_location() -> None:
    graph = defs.resolve_asset_graph()
    node = graph.get(AssetKey(["gold", "storm_levels"]))
    assert node.pools == {"storm-tracks"}
    assert AssetKey(["gold", "storms"]) in node.parent_keys
