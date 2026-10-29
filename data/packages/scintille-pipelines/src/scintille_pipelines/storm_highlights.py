"""A few published storms worth replaying, ranked by DuckDB SQL over the publication snapshot."""

from collections.abc import Sequence
from datetime import datetime
from importlib.resources import files
from typing import Any, Literal

import duckdb
import polars as pl
from scintille_contract.models import (
    SCHEMA_VERSION,
    StormHighlight,
    StormHighlights,
    StormMetric,
    StormSummary,
)

from scintille_pipelines.geocoding import Geocoder

type Kind = Literal["day", "week", "area", "longest", "intense", "largest", "stationary"]
type Area = Literal["americas", "europe", "africa", "asia"]
type Metric = Literal["flashes", "countries", "distance_km", "hours", "peak_rate", "area_km2"]

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
#: Fewer countries crossed is not worth telling.
MIN_COUNTRIES = 3
#: The figure each record is about; day, week and area winners show their best ranked one.
RECORDS: dict[Kind, Metric] = {
    "longest": "hours",
    "intense": "peak_rate",
    "largest": "area_km2",
    "stationary": "flashes",
}
RANKED: tuple[Metric, ...] = ("flashes", "countries", "distance_km", "hours")
METRICS = ("storm_id", "lat", "lon", "max_area_km2", "drift_km", "score", "offshore", "countries")
SUMMARY_SCHEMA: dict[str, pl.DataType] = {
    "storm_id": pl.String(),
    "slug": pl.String(),
    "t_start": pl.Datetime("us", "UTC"),
    "t_end": pl.Datetime("us", "UTC"),
    "flashes": pl.Int64(),
    "peak_rate": pl.Int64(),
    "distance_km": pl.Float64(),
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
        values = {row["storm_id"]: row for row in storms.iter_rows(named=True)}
        winners = {
            (row["kind"], row["area"]): row for row in ranked(storms, ref).iter_rows(named=True)
        }
        for kind, area in SLOTS:
            row = winners.get((kind, area))
            if row is not None and all(h.storm.slug != row["slug"] for h in chosen):
                storm = by_slug[row["slug"]]
                chosen.append(
                    StormHighlight(
                        kind=kind,
                        area=area,
                        storm=storm,
                        metric=metric(kind, row, values[storm.storm_id]),
                    )
                )
    return StormHighlights(
        schema_version=SCHEMA_VERSION,
        published_at=now,
        last_observation_time=ref,
        highlights=chosen,
    )


def metric(kind: Kind, ranks: dict[str, Any], storm: dict[str, Any]) -> StormMetric:
    """The figure a card shows: the record itself, or the winner's best ranked one."""
    storm = {**storm, "hours": (storm["t_end"] - storm["t_start"]).total_seconds() / 3600}
    storm["area_km2"] = storm["max_area_km2"]
    if kind in RECORDS:
        return StormMetric(name=RECORDS[kind], value=storm[RECORDS[kind]], rank=1)
    options = [
        (ranks[f"{name}_rank"], order, name)
        for order, name in enumerate(RANKED)
        if storm[name] is not None and (name != "countries" or storm[name] >= MIN_COUNTRIES)
    ]
    rank, _, name = min(options)
    return StormMetric(name=name, value=storm[name], rank=rank)


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
    joined = joined.join(names.select("storm_id", "offshore"), on="storm_id")
    return joined.join(countries_crossed(storms), on="storm_id", how="left").with_columns(
        pl.col("countries").fill_null(0)
    )


def countries_crossed(storms: pl.DataFrame) -> pl.DataFrame:
    """Distinct countries under the track centroids of each storm."""
    points = (
        storms.select("storm_id", "track")
        .explode("track")
        .select(
            "storm_id",
            lat=pl.col("track").struct.field("lat"),
            lon=pl.col("track").struct.field("lon"),
        )
        .drop_nulls()
    )
    found = Geocoder.load().country_index(points["lat"].to_numpy(), points["lon"].to_numpy())
    return (
        points.with_columns(country=pl.Series(found, dtype=pl.Int64))
        .filter(pl.col("country") >= 0)
        .group_by("storm_id")
        .agg(pl.col("country").n_unique().cast(pl.Int64).alias("countries"))
    )


def haversine_km(lat1: pl.Expr, lon1: pl.Expr, lat2: pl.Expr, lon2: pl.Expr) -> pl.Expr:
    a = ((lat2 - lat1).radians() / 2).sin().pow(2) + lat1.radians().cos() * lat2.radians().cos() * (
        (lon2 - lon1).radians() / 2
    ).sin().pow(2)
    return 2 * EARTH_KM * a.sqrt().arcsin()
