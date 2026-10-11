from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import polars as pl
import pytest
from dagster import AssetKey, materialize
from pyiceberg.catalog import Catalog
from pyiceberg.catalog.sql import SqlCatalog
from scintille_lake.migrate import migrate, sync_table
from scintille_pipelines.definitions import defs
from scintille_pipelines.geocoding import Geocoder, base_slug, slugify, unique_slugs
from scintille_pipelines.resources import LakeResource
from scintille_pipelines.storm_names import STORM_NAMES, name_storms, storm_names
from scintille_pipelines.storms import STORMS

# (lat, lon, name, label, country code)
CASES = {
    "city": (48.86, 2.35, "Paris", "Paris, Île-de-France, France", "FR"),
    "suburbs": (43.65, 1.5, "Toulouse", "Toulouse, Occitanie, France", "FR"),
    "island": (42.15, 9.1, "Ajaccio", "Ajaccio, Corsica, France", "FR"),
    "big city wins": (48.3, 11.7, "Munich", "Munich, Bavaria, Germany", "DE"),
    "plains": (38.5, -98.5, "Great Bend", "Great Bend, Kansas, United States of America", "US"),
    "no place, region": (-5, -65, "Amazonas", "Amazonas, Brazil", "BR"),
    "no place, country": (23, 10, "Algeria", "Algeria", "DZ"),
    "territory": (4, -53, "Guyane", "Guyane, France", "FR"),
    "border, French side": (
        46.19,
        6.24,
        "Annemasse",
        "Annemasse, Auvergne-Rhône-Alpes, France",
        "FR",
    ),
    "border, Mexican side": (
        31.7,
        -106.45,
        "Ciudad Juárez",
        "Ciudad Juárez, Chihuahua, Mexico",
        "MX",
    ),
    "tri-border": (-25.6, -54.5, "Foz do Iguaçu", "Foz do Iguaçu, Paraná, Brazil", "BR"),
    "lake": (0.0, 32.8, "Kampala", "Kampala, Central Region, Uganda", "UG"),
    "coast": (43.55, 7.35, "Nice", "Mediterranean Sea, off Nice, France", None),
    "strait coast": (
        25.75,
        -79.95,
        "Miami",
        "Florida Strait, off Miami, United States of America",
        None,
    ),
    "gulf": (26, -90, "Gulf of Mexico", "Gulf of Mexico", None),
    "bay": (15, 89, "Bay of Bengal", "Bay of Bengal", None),
    "sea": (-40, 165, "Tasman Sea", "Tasman Sea", None),
    "open ocean": (30, -40, "North Atlantic Ocean", "North Atlantic Ocean", None),
    "antimeridian east": (0, 179.9, "North Pacific Ocean", "North Pacific Ocean", None),
    "antimeridian west": (-15, -179.9, "South Pacific Ocean", "South Pacific Ocean", None),
}


@pytest.mark.parametrize("case", CASES)
def test_hand_picked_places(case: str) -> None:
    lat, lon, name, label, code = CASES[case]
    row = Geocoder.load().locate([lat], [lon]).row(0, named=True)
    assert (row["name"], row["label"], row["country_code"]) == (name, label, code)
    assert row["offshore"] == (code is None)
    assert (row["sea"] is None) == (code is not None)


def test_locates_many_points_at_once() -> None:
    lats, lons = zip(*((c[0], c[1]) for c in CASES.values()), strict=True)
    names = Geocoder.load().locate(lats, lons)
    assert names["name"].to_list() == [c[2] for c in CASES.values()]
    assert Geocoder.load().locate([], []).is_empty()


def test_slugs() -> None:
    assert slugify("Ciudad Juárez") == "ciudad-juarez"
    assert slugify("Provence-Alpes-Côte d'Azur") == "provence-alpes-cote-d-azur"
    assert slugify("東京") == "storm"
    assert len(slugify("a" * 200)) == 60
    day = date(2026, 10, 5)
    assert base_slug(day, "Ajaccio", False, "Ajaccio") == "2026-10-05-ajaccio"
    assert base_slug(day, "Nice", True, "Nice") == "2026-10-05-off-nice"
    assert base_slug(day, "Gulf of Mexico", True, None) == "2026-10-05-gulf-of-mexico"
    assert unique_slugs(["a", "b", "a", "a"], ["b"]) == ["a", "b-2", "a-2", "a-3"]


T0 = datetime(2026, 10, 5, 14, tzinfo=UTC)


def storm(storm_id: str, minutes: int, lat: float, lon: float) -> dict[str, object]:
    return {
        "storm_id": storm_id,
        "storm_start": T0,
        "t_start": T0 + timedelta(minutes=minutes),
        "lat": lat,
        "lon": lon,
    }


def test_name_storms_orders_and_suffixes() -> None:
    storms = pl.DataFrame(
        [storm("b", 20, 48.86, 2.35), storm("a", 10, 48.85, 2.36), storm("c", 5, 26, -90)]
    )
    names = name_storms(storms, taken=["2026-10-05-gulf-of-mexico"])
    assert names["storm_id"].to_list() == ["c", "a", "b"]
    assert names["slug"].to_list() == [
        "2026-10-05-gulf-of-mexico-2",
        "2026-10-05-paris",
        "2026-10-05-paris-2",
    ]
    assert names.columns == STORM_NAMES.schema.column_names


class SqliteLake(LakeResource):
    path: str

    def catalog(self) -> Catalog:
        return SqlCatalog(
            "test", uri=f"sqlite:///{self.path}/catalog.db", warehouse=f"file://{self.path}"
        )


def add_storms(lake: SqliteLake, rows: list[dict[str, object]]) -> None:
    catalog = lake.catalog()
    migrate(catalog)
    sync_table(catalog, STORMS)
    table = catalog.load_table(STORMS.identifier)
    full = [
        {
            **r,
            "last_window": T0,
            "t_end": r["t_start"],
            "closed": False,
            "steps": 1,
            "flash_count": 100,
            "max_cell_flashes": 100,
            "max_area_km2": 10.0,
            "west": r["lon"],
            "south": r["lat"],
            "east": r["lon"],
            "north": r["lat"],
            "sources": ["mtg-li"],
            "split_from": None,
            "track": [],
            "params": "test",
        }
        for r in rows
    ]
    schema = table.schema().as_arrow()
    table.append(pl.DataFrame(full).to_arrow().select(schema.names).cast(schema))


def scan_names(lake: SqliteLake) -> pl.DataFrame:
    df = pl.from_arrow(lake.catalog().load_table(STORM_NAMES.identifier).scan().to_arrow())
    assert isinstance(df, pl.DataFrame)
    return df.sort("slug")


def test_materializes_stable_unique_slugs(tmp_path: Path) -> None:
    lake = SqliteLake(path=str(tmp_path))
    add_storms(lake, [storm("a", 3, 42.15, 9.1), storm("b", 30, 30, -40)])
    key = "2026-10-05-14:00"
    for _ in range(2):
        result = materialize([storm_names], partition_key=key, resources={"lake": lake})
        assert result.success
        assert all(c.passed for c in result.get_asset_check_evaluations())
    first = scan_names(lake)
    assert first["slug"].to_list() == ["2026-10-05-ajaccio", "2026-10-05-north-atlantic-ocean"]
    # Earlier slugs are kept, a new storm nearby takes a suffix.
    add_storms(lake, [storm("c", 40, 42.0, 9.0)])
    assert materialize([storm_names], partition_key=key, resources={"lake": lake}).success
    names = scan_names(lake)
    assert names["slug"].to_list() == [
        "2026-10-05-ajaccio",
        "2026-10-05-ajaccio-2",
        "2026-10-05-north-atlantic-ocean",
    ]
    assert names.filter(pl.col("storm_id") == "c")["day"].to_list() == [date(2026, 10, 5)]


def test_registered_in_the_code_location() -> None:
    graph = defs.resolve_asset_graph()
    assert graph.get(AssetKey(["gold", "storm_names"])).pools == {"storm-tracks"}
