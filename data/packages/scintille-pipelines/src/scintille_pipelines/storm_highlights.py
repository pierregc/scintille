"""A few published storms worth replaying, ranked by DuckDB SQL over the publication snapshot."""

from collections.abc import Sequence
from datetime import datetime
from importlib.resources import files
from typing import Literal

import duckdb
import polars as pl
from scintille_contract.models import SCHEMA_VERSION, StormHighlight, StormHighlights, StormSummary

type Kind = Literal["day", "week", "area", "longest", "intense", "largest"]
type Area = Literal["americas", "europe", "africa", "asia"]

AREAS: tuple[Area, ...] = ("americas", "europe", "africa", "asia")
#: Display order; each slot takes its best storm not already picked.
SLOTS: tuple[tuple[Kind, Area | None], ...] = (
    ("day", None),
    ("week", None),
    *(("area", area) for area in AREAS),
    ("longest", None),
    ("intense", None),
    ("largest", None),
)
METRICS = ("storm_id", "lat", "lon", "max_area_km2", "score", "offshore")
SUMMARY_SCHEMA: dict[str, pl.DataType] = {
    "storm_id": pl.String(),
    "slug": pl.String(),
    "t_start": pl.Datetime("us", "UTC"),
    "t_end": pl.Datetime("us", "UTC"),
    "peak_rate": pl.Int64(),
}
SQL = files(__package__).joinpath("sql", "storm_highlights.sql").read_text()


def ranked(storms: pl.DataFrame, ref: datetime) -> pl.DataFrame:
    with duckdb.connect() as con:
        con.register("storms", storms.to_arrow())
        return con.execute(SQL.format(storms="storms"), {"ref": ref}).pl()


def highlights(
    published: Sequence[StormSummary], metrics: pl.DataFrame, now: datetime
) -> StormHighlights:
    ref = max((storm.t_end for storm in published), default=None)
    chosen: list[StormHighlight] = []
    if ref is not None:
        storms = pl.DataFrame(
            [
                s.model_dump(include={"storm_id", "slug", "t_start", "t_end", "peak_rate"})
                for s in published
            ],
            schema=SUMMARY_SCHEMA,
        ).join(metrics.select(METRICS), on="storm_id")
        by_slug = {storm.slug: storm for storm in published}
        candidates: dict[tuple[str, str | None], list[str]] = {}
        for kind, area, slug in ranked(storms, ref).select("kind", "area", "slug").iter_rows():
            candidates.setdefault((kind, area), []).append(slug)
        for kind, area in SLOTS:
            used = {h.storm.slug for h in chosen}
            slug = next((s for s in candidates.get((kind, area), []) if s not in used), None)
            if slug is not None:
                chosen.append(StormHighlight(kind=kind, area=area, storm=by_slug[slug]))
    return StormHighlights(
        schema_version=SCHEMA_VERSION,
        published_at=now,
        last_observation_time=ref,
        highlights=chosen,
    )


def storm_metrics(storms: pl.DataFrame, levels: pl.DataFrame, names: pl.DataFrame) -> pl.DataFrame:
    """Centroid, extent, ADR 0009 score and offshore flag per storm, from the gold tables."""
    joined = storms.select("storm_id", "lat", "lon", "max_area_km2").join(
        levels.select("storm_id", "score"), on="storm_id"
    )
    return joined.join(names.select("storm_id", "offshore"), on="storm_id")
