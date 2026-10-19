"""A few published storms worth replaying, ranked by DuckDB SQL over the publication snapshot."""

from collections.abc import Sequence
from datetime import datetime
from importlib.resources import files
from typing import Literal

import duckdb
import polars as pl
from scintille_contract.models import SCHEMA_VERSION, StormHighlight, StormHighlights, StormSummary

type Kind = Literal["day", "week", "area", "longest", "intense", "largest", "stationary"]
type Area = Literal["americas", "europe", "africa", "asia"]

AREAS: tuple[Area, ...] = ("americas", "europe", "africa", "asia")
#: Display order; each slot shows its winner unless an earlier slot already shows it.
SLOTS: tuple[tuple[Kind, Area | None], ...] = (
    ("day", None),
    ("week", None),
    *(("area", area) for area in AREAS),
    ("longest", None),
    ("intense", None),
    ("largest", None),
    ("stationary", None),
)
#: Below these a storm is too small to be worth a replay.
MIN_FLASHES = 1000
MIN_HOURS = 1.0
#: A stationary storm lasts this long with every track point this close to its centroid.
STATIONARY_HOURS = 3.0
STATIONARY_KM = 40.0
EARTH_KM = 6371.0
METRICS = ("storm_id", "lat", "lon", "max_area_km2", "drift_km", "score", "offshore")
SUMMARY_SCHEMA: dict[str, pl.DataType] = {
    "storm_id": pl.String(),
    "slug": pl.String(),
    "t_start": pl.Datetime("us", "UTC"),
    "t_end": pl.Datetime("us", "UTC"),
    "flashes": pl.Int64(),
    "peak_rate": pl.Int64(),
}
SQL = files(__package__).joinpath("sql", "storm_highlights.sql").read_text()


def ranked(storms: pl.DataFrame, ref: datetime) -> pl.DataFrame:
    with duckdb.connect() as con:
        con.register("storms", storms.to_arrow())
        params = {
            "ref": ref,
            "min_flashes": MIN_FLASHES,
            "min_hours": MIN_HOURS,
            "stationary_hours": STATIONARY_HOURS,
            "stationary_km": STATIONARY_KM,
        }
        return con.execute(SQL.format(storms="storms"), params).pl()


def highlights(
    published: Sequence[StormSummary], metrics: pl.DataFrame, now: datetime
) -> StormHighlights:
    ref = max((storm.t_end for storm in published), default=None)
    chosen: list[StormHighlight] = []
    if ref is not None:
        storms = pl.DataFrame(
            [s.model_dump(include=set(SUMMARY_SCHEMA)) for s in published],
            schema=SUMMARY_SCHEMA,
        ).join(metrics.select(METRICS), on="storm_id")
        by_slug = {storm.slug: storm for storm in published}
        winners = {
            (kind, area): slug
            for kind, area, slug in ranked(storms, ref).select("kind", "area", "slug").iter_rows()
        }
        for kind, area in SLOTS:
            slug = winners.get((kind, area))
            if slug is not None and all(h.storm.slug != slug for h in chosen):
                chosen.append(StormHighlight(kind=kind, area=area, storm=by_slug[slug]))
    return StormHighlights(
        schema_version=SCHEMA_VERSION,
        published_at=now,
        last_observation_time=ref,
        highlights=chosen,
    )


def storm_metrics(storms: pl.DataFrame, levels: pl.DataFrame, names: pl.DataFrame) -> pl.DataFrame:
    """Centroid, extent, drift, ADR 0009 score and offshore flag per storm, from the gold tables."""
    drift = (
        storms.select("storm_id", "lat", "lon", "track")
        .explode("track")
        .group_by("storm_id")
        .agg(
            haversine_km(
                pl.col("lat"),
                pl.col("lon"),
                pl.col("track").struct.field("lat"),
                pl.col("track").struct.field("lon"),
            )
            .max()
            .alias("drift_km")
        )
    )
    joined = storms.select("storm_id", "lat", "lon", "max_area_km2").join(drift, on="storm_id")
    joined = joined.join(levels.select("storm_id", "score"), on="storm_id")
    return joined.join(names.select("storm_id", "offshore"), on="storm_id")


def haversine_km(lat1: pl.Expr, lon1: pl.Expr, lat2: pl.Expr, lon2: pl.Expr) -> pl.Expr:
    a = ((lat2 - lat1).radians() / 2).sin().pow(2) + lat1.radians().cos() * lat2.radians().cos() * (
        (lon2 - lon1).radians() / 2
    ).sin().pow(2)
    return 2 * EARTH_KM * a.sqrt().arcsin()
