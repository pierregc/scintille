"""Storm intensity levels (ADR 0009), counted on one satellite per storm."""

from dataclasses import dataclass
from typing import Literal, get_args

import polars as pl

Score = Literal["flashes_x_peak", "flashes"]
Count = Literal["best_source", "all_sources"]

LEVEL_COLUMNS = ("level_source", "flashes", "peak_rate", "score", "level", "level_name")


@dataclass(frozen=True)
class LevelRule:
    """Score, thresholds and names; level `k` starts at `thresholds[k - 2]`.

    `best_source` keeps the satellite with the highest score, so flashes seen by two
    satellites count once. `all_sources` sums them, for sources already deduplicated.
    """

    score: Score
    thresholds: tuple[float, ...]
    names: tuple[str, ...]
    count: Count = "best_source"

    def __post_init__(self) -> None:
        if self.score not in get_args(Score) or self.count not in get_args(Count):
            raise ValueError(f"unknown score or count: {self.score}, {self.count}")
        if len(self.names) != len(self.thresholds) + 1:
            raise ValueError("one name per level: len(names) == len(thresholds) + 1")
        if any(b <= a for a, b in zip(self.thresholds, self.thresholds[1:], strict=False)):
            raise ValueError("thresholds must increase")

    def __str__(self) -> str:
        cuts = ",".join(f"{t:g}" for t in self.thresholds)
        return f"levels score={self.score} count={self.count} thresholds={cuts}"


def _score(flashes: pl.Expr, peak: pl.Expr, score: Score) -> pl.Expr:
    if score == "flashes":
        return flashes.cast(pl.Float64)
    return (flashes * peak).cast(pl.Float64).sqrt()


def level_of(score: pl.Expr, rule: LevelRule) -> pl.Expr:
    level = pl.lit(1, pl.Int64)
    for t in rule.thresholds:
        level = level + (score >= t).cast(pl.Int64)
    return level


def classify(minutes: pl.DataFrame, rule: LevelRule) -> pl.DataFrame:
    """Level per storm from its flashes per (source, minute)."""
    if rule.count == "all_sources":
        minutes = minutes.group_by("storm_id", "minute").agg(
            pl.lit("all").alias("source"), pl.col("flashes").sum()
        )
    per_source = (
        minutes.group_by("storm_id", "source")
        .agg(pl.col("flashes").sum().alias("total"), pl.col("flashes").max().alias("peak_rate"))
        .with_columns(score=_score(pl.col("total"), pl.col("peak_rate"), rule.score))
        .sort("storm_id", "score", "total", "source", descending=[False, True, True, False])
    )
    return (
        per_source.group_by("storm_id", maintain_order=True)
        .first()
        .select(
            "storm_id",
            pl.col("source").alias("level_source"),
            pl.col("total").cast(pl.Int64).alias("flashes"),
            pl.col("peak_rate").cast(pl.Int64),
            "score",
            level_of(pl.col("score"), rule).alias("level"),
        )
        .with_columns(
            level_name=pl.col("level").replace_strict(
                range(1, len(rule.names) + 1), rule.names, return_dtype=pl.String
            ),
            level_rule=pl.lit(str(rule)),
        )
    )


def keep_live_maximum(levels: pl.DataFrame, previous: pl.DataFrame) -> pl.DataFrame:
    """A storm still active under the same rule never goes down a level.

    Each source's score only grows, but re-running earlier hours could lower it.
    """
    prior = previous.filter(~pl.col("closed")).select(
        "storm_id",
        pl.col("level_rule").alias("_rule"),
        *(pl.col(c).alias(f"_{c}") for c in LEVEL_COLUMNS),
    )
    keep = (pl.col("_rule") == pl.col("level_rule")) & (pl.col("_score") > pl.col("score"))
    return (
        levels.join(prior, on="storm_id", how="left")
        .with_columns(
            pl.when(keep).then(pl.col(f"_{c}")).otherwise(pl.col(c)).alias(c) for c in LEVEL_COLUMNS
        )
        .drop("_rule", *(f"_{c}" for c in LEVEL_COLUMNS))
    )
