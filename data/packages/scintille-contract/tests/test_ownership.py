import json
from itertools import pairwise
from pathlib import Path

import numpy as np
from scintille_contract import ownership
from scintille_contract.ownership import SATELLITES, Satellite, owner_index, owners
from shapely import Point

MASK = Path(__file__).parents[3] / "contract" / "ownership.geojson"


def test_each_point_belongs_to_the_nearest_subpoint() -> None:
    assert owners([0, 0, 30, 45], [-106.0, -106.2, -90.0, -150.0]) == [
        "glm-east",
        "glm-west",
        "glm-east",
        "glm-west",
    ]


def test_points_no_satellite_sees_have_no_owner() -> None:
    assert owners([0, 80, 0], [120.0, -100.0, 90.0]) == [None, None, None]


def test_the_antimeridian_side_belongs_to_goes_west() -> None:
    assert owners([0, 0], [179.0, -179.0]) == ["glm-west", "glm-west"]


def test_mtg_takes_the_atlantic_east_of_the_halfway_meridian() -> None:
    boundary = (-75.2 + 0.0) / 2
    assert owners([10, 10, -20], [boundary - 0.1, boundary + 0.1, 30.0]) == [
        "glm-east",
        "mtg-li",
        "mtg-li",
    ]
    assert owners([10], [-120.0]) == ["glm-west"]


def test_mtg_keeps_the_far_north_west_glm_east_does_not_see() -> None:
    assert owners([62, 66], [-45.0, -45.0]) == ["glm-east", "mtg-li"]


def test_the_mtg_zone_wraps_around_the_edge_of_glm_east() -> None:
    mtg = [s.source for s in SATELLITES].index("mtg-li")
    (polygon,) = ownership.zone(mtg)
    assert not polygon.contains(Point(-45.0, 62.0))
    assert polygon.contains(Point(-45.0, 66.0))
    assert polygon.contains(Point(-30.0, 62.0))


def test_a_smaller_coverage_hands_its_far_points_to_the_other_satellite() -> None:
    narrow = (Satellite("glm-east", -75.2, 67.0), Satellite("mtg-li", 0.0, 40.0))
    assert owners([45, 0], [-30.0, -30.0], narrow) == ["glm-east", "mtg-li"]


def test_committed_mask_is_the_generated_one() -> None:
    assert json.loads(MASK.read_text()) == json.loads(json.dumps(ownership.geojson()))


def _inside(lon: float, lat: float, ring: list[list[float]]) -> bool:
    inside = False
    for (x1, y1), (x2, y2) in pairwise(ring):
        if (y1 > lat) != (y2 > lat) and lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside


def test_mask_polygons_agree_with_the_rule() -> None:
    mask = ownership.geojson()
    rng = np.random.default_rng(3)
    lat = np.degrees(np.arcsin(rng.uniform(-1, 1, 3000)))
    lon = rng.uniform(-180, 180, 3000)
    expected = owner_index(lat, lon)
    names = [f["properties"]["source"] for f in mask["features"]]
    mismatches = 0
    for x, y, want in zip(lon, lat, expected, strict=True):
        got = [
            i
            for i, f in enumerate(mask["features"])
            if any(_inside(x, y, poly[0]) for poly in f["geometry"]["coordinates"])
        ]
        mismatches += got != ([want] if want >= 0 else [])
    assert len(names) == len(SATELLITES)
    assert mismatches <= 3
