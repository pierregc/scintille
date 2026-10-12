import json
from itertools import pairwise
from pathlib import Path

import numpy as np
import pytest
from scintille_contract import coverage
from scintille_contract.models import CoverageMap
from scintille_contract.ownership import SATELLITES, Satellite, central_angle

COVERAGE = Path(__file__).parents[3] / "contract" / "coverage.geojson"
GLM_ONLY = tuple(s for s in SATELLITES if s.source != "mtg-li")
EQUATOR_SEEN = tuple(Satellite("glm-east", lon, 67.0) for lon in (-135.0, -45.0, 45.0, 135.0))


def test_committed_coverage_is_the_generated_one() -> None:
    assert json.loads(COVERAGE.read_text()) == json.loads(json.dumps(coverage.geojson()))


def test_coverage_matches_the_contract() -> None:
    parsed = CoverageMap.model_validate(coverage.geojson())
    kinds = [f.properties.kind for f in parsed.features]
    assert kinds == ["footprint"] * len(SATELLITES) + ["no-coverage"]
    assert [f.properties.source for f in parsed.features[:-1]] == [s.source for s in SATELLITES]


def test_covered_spans_merge_overlaps_across_the_antimeridian() -> None:
    assert coverage.covered_spans() == [pytest.approx((156.0, 440.0))]
    assert coverage.covered_spans(EQUATOR_SEEN) == []


def _inside(lon: float, lat: float, ring: list[list[float]]) -> bool:
    inside = False
    for (x1, y1), (x2, y2) in pairwise(ring):
        if (y1 > lat) != (y2 > lat) and lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside


def _in_multipolygon(lon: float, lat: float, polygons: list[list[list[list[float]]]]) -> bool:
    return any(
        _inside(lon, lat, outer) and not any(_inside(lon, lat, hole) for hole in holes)
        for outer, *holes in polygons
    )


def _signed_area(ring: list[list[float]]) -> float:
    return sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in pairwise(ring)) / 2


@pytest.mark.parametrize("satellites", [SATELLITES, GLM_ONLY, EQUATOR_SEEN])
def test_polygons_agree_with_the_rule(satellites: tuple[Satellite, ...]) -> None:
    features = coverage.geojson(satellites)["features"]
    rng = np.random.default_rng(5)
    lat = np.degrees(np.arcsin(rng.uniform(-1, 1, 3000)))
    lon = rng.uniform(-180, 180, 3000)
    seen = np.stack([central_angle(lat, lon, s.subpoint_lon) <= s.coverage_deg for s in satellites])
    expected = np.vstack([seen, ~seen.any(axis=0)]).T.tolist()
    mismatches = 0
    for x, y, want in zip(lon, lat, expected, strict=True):
        got = [_in_multipolygon(x, y, f["geometry"]["coordinates"]) for f in features]
        mismatches += got != want
    assert mismatches <= 3


@pytest.mark.parametrize("satellites", [SATELLITES, GLM_ONLY, EQUATOR_SEEN])
def test_rings_follow_rfc_7946_winding(satellites: tuple[Satellite, ...]) -> None:
    for feature in coverage.geojson(satellites)["features"]:
        for outer, *holes in feature["geometry"]["coordinates"]:
            assert outer[0] == outer[-1]
            assert _signed_area(outer) > 0
            assert all(_signed_area(hole) < 0 for hole in holes)
            assert all(-180 <= x <= 180 and -90 <= y <= 90 for x, y in outer)


def test_a_new_satellite_gets_a_footprint_and_shrinks_the_gap() -> None:
    def gap_area(satellites: tuple[Satellite, ...]) -> float:
        polygons = coverage.geojson(satellites)["features"][-1]["geometry"]["coordinates"]
        return sum(_signed_area(ring) for polygon in polygons for ring in polygon)

    features = coverage.geojson(SATELLITES)["features"]
    assert [f["properties"]["source"] for f in features] == [
        "glm-east",
        "glm-west",
        "mtg-li",
        None,
    ]
    assert gap_area(SATELLITES) < gap_area(GLM_ONLY)
