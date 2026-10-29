"""Offline reverse geocoding of storm centroids, and storm slugs."""

import gzip
import json
import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date
from functools import cache
from importlib.resources import files
from typing import Any

import numpy as np
import polars as pl
import shapely
from scipy.spatial import cKDTree  # type: ignore[import-untyped]
from shapely.geometry import shape

EARTH_RADIUS_KM = 6371.0
#: A land storm is named after a place this close, otherwise after the place's region.
PLACE_KM = 50.0
REGION_KM = 200.0
#: An offshore storm this close to a place is "off <place>", otherwise named after the sea.
COAST_KM = 40.0
#: A place 10 times more populous wins if it is at most this much further.
KM_PER_DECADE = 20.0
NEIGHBOURS = 64
SLUG_MAX = 60

GEOCODE_SCHEMA = pl.Schema(
    {
        "name": pl.String(),
        "label": pl.String(),
        "place": pl.String(),
        "place_km": pl.Float64(),
        "region": pl.String(),
        "country_code": pl.String(),
        "country_name": pl.String(),
        "sea": pl.String(),
        "offshore": pl.Boolean(),
    }
)


def _read(name: str) -> bytes:
    return gzip.decompress(files(__package__).joinpath("geodata", name).read_bytes())


def _features(name: str) -> list[dict[str, Any]]:
    features: list[dict[str, Any]] = json.loads(_read(name))["features"]
    return features


def _unit(lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    phi, lam = np.radians(lat), np.radians(lon)
    return np.column_stack([np.cos(phi) * np.cos(lam), np.cos(phi) * np.sin(lam), np.sin(phi)])


def _chord_to_km(chord: np.ndarray) -> np.ndarray:
    return 2 * EARTH_RADIUS_KM * np.arcsin(np.clip(chord / 2, 0, 1))


def geodata_version() -> str:
    manifest = files(__package__).joinpath("geodata", "manifest.json").read_text()
    version: str = json.loads(manifest)["version"]
    return version


@dataclass(frozen=True)
class Geocoder:
    """Natural Earth borders and seas, GeoNames places (cities above 15,000 people)."""

    countries: shapely.STRtree
    country_codes: list[str | None]
    country_names: list[str]
    seas: shapely.STRtree
    sea_names: list[str]
    sea_areas: np.ndarray
    places: cKDTree
    place_names: list[str]
    place_countries: list[str]
    place_regions: list[str]
    place_scores: np.ndarray

    @classmethod
    @cache
    def load(cls) -> "Geocoder":
        borders = _features("countries.geojson.gz")
        seas = _features("marine.geojson.gz")
        sea_geoms = [shape(f["geometry"]) for f in seas]
        df = pl.read_csv(
            _read("places.tsv.gz"),
            separator="\t",
            quote_char=None,
            schema_overrides={"country": pl.String(), "region": pl.String()},
        ).with_columns(pl.col("country", "region").fill_null(""))
        return cls(
            countries=shapely.STRtree([shape(f["geometry"]) for f in borders]),
            country_codes=[f["properties"]["code"] for f in borders],
            country_names=[f["properties"]["name"] for f in borders],
            seas=shapely.STRtree(sea_geoms),
            sea_names=[f["properties"]["name"] for f in seas],
            sea_areas=shapely.area(sea_geoms),
            places=cKDTree(_unit(df["lat"].to_numpy(), df["lon"].to_numpy())),
            place_names=df["name"].to_list(),
            place_countries=df["country"].to_list(),
            place_regions=df["region"].to_list(),
            place_scores=np.log10(np.maximum(df["population"].to_numpy(), 1)),
        )

    def _country(self, points: np.ndarray) -> np.ndarray:
        found = np.full(len(points), -1)
        point, country = self.countries.query(points, predicate="within")
        found[point] = country
        return found

    def country_index(self, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
        """Index of the country under each point, -1 at sea."""
        return self._country(np.asarray(shapely.points(lon, lat)))

    def _sea(self, points: np.ndarray) -> np.ndarray:
        found = np.full(len(points), -1)
        point, sea = self.seas.query(points, predicate="within")
        # The smallest containing area, so a gulf wins over its ocean.
        order = np.lexsort((self.sea_areas[sea], point))
        first = np.unique(point[order], return_index=True)[1]
        found[point[order][first]] = sea[order][first]
        missing = np.flatnonzero(found < 0)
        if missing.size:
            point, sea = self.seas.query_nearest(points[missing])
            found[missing[point]] = sea
        return found

    def _notable(self, dist: np.ndarray, ids: np.ndarray, allowed: np.ndarray) -> int:
        """Best population/distance trade-off among the allowed neighbours, or -1."""
        score = np.where(allowed, self.place_scores[ids] - dist / KM_PER_DECADE, -np.inf)
        best = int(np.argmax(score))
        return best if allowed[best] else -1

    def locate(self, lat: Iterable[float], lon: Iterable[float]) -> pl.DataFrame:
        """One row of names per point (see `GEOCODE_SCHEMA`)."""
        lats, lons = np.asarray(list(lat), float), np.asarray(list(lon), float)
        if lats.size == 0:
            return pl.DataFrame(schema=GEOCODE_SCHEMA)
        points = np.asarray(shapely.points(lons, lats))
        country = self._country(points)
        sea = np.full(len(points), -1)
        offshore = np.flatnonzero(country < 0)
        sea[offshore] = self._sea(points[offshore])
        chord, index = self.places.query(_unit(lats, lons), k=NEIGHBOURS)
        km = _chord_to_km(chord)
        rows = []
        for i in range(len(points)):
            ids, dist = index[i], km[i]
            if country[i] >= 0:
                cname = self.country_names[country[i]]
                same = np.array([self.place_countries[j] == cname for j in ids])
                near = self._notable(dist, ids, same & (dist <= PLACE_KM))
                regional = int(np.argmax(same)) if same.any() else -1
                if regional >= 0 and dist[regional] > REGION_KM:
                    regional = -1
                rows.append(self._land(cname, country[i], ids, dist, near, regional))
            else:
                coast = self._notable(dist, ids, dist <= COAST_KM)
                rows.append(self._sea_row(self.sea_names[sea[i]], ids, dist, coast))
        return pl.DataFrame(rows, schema=GEOCODE_SCHEMA, orient="row")

    def _land(
        self,
        country_name: str,
        country: int,
        ids: np.ndarray,
        dist: np.ndarray,
        near: int,
        regional: int,
    ) -> tuple[Any, ...]:
        code = self.country_codes[country]
        if near >= 0:
            j = ids[near]
            place, region = self.place_names[j], self.place_regions[j] or None
            label = _join(place, region, country_name)
            return (place, label, place, float(dist[near]), region, code, country_name, None, False)
        if regional >= 0 and self.place_regions[ids[regional]]:
            region = self.place_regions[ids[regional]]
            label = _join(region, country_name)
            return (region, label, None, None, region, code, country_name, None, False)
        return (country_name, country_name, None, None, None, code, country_name, None, False)

    def _sea_row(self, sea: str, ids: np.ndarray, dist: np.ndarray, coast: int) -> tuple[Any, ...]:
        if coast >= 0:
            j = ids[coast]
            place = self.place_names[j]
            label = f"{sea}, off {_join(place, self.place_countries[j] or None)}"
            return (place, label, place, float(dist[coast]), None, None, None, sea, True)
        return (sea, sea, None, None, None, None, None, sea, True)


def _join(*parts: str | None) -> str:
    out: list[str] = []
    for part in parts:
        if part and part not in out:
            out.append(part)
    return ", ".join(out)


def slugify(text: str) -> str:
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")
    return slug[:SLUG_MAX].rstrip("-") or "storm"


def base_slug(day: date, name: str, offshore: bool, place: str | None) -> str:
    """`YYYY-MM-DD-<place>`, or `YYYY-MM-DD-off-<place>` for a storm off the coast."""
    words = f"off {name}" if offshore and place else name
    return f"{day.isoformat()}-{slugify(words)}"


def unique_slugs(bases: Iterable[str], taken: Iterable[str]) -> list[str]:
    """Each base slug, with `-2`, `-3`… when already taken, in order."""
    used = set(taken)
    out = []
    for base in bases:
        slug, n = base, 1
        while slug in used:
            n += 1
            slug = f"{base}-{n}"
        used.add(slug)
        out.append(slug)
    return out
