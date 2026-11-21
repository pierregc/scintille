from datetime import UTC, datetime

from scintille_pipelines.cyclones import build_feed, parse_vitals, uncrossed

VITALS = """\
JTWC 04P FOUR      20261115 0600 084S 1589W 285 011 1001 1008 0250 18 083 0167 0111 0093 -999 M
JTWC 04P XAVIER    20261117 1800 096S 1638W 225 016 0929 1008 0222 66 022 0139 0139 0139 0093 S
NHC  04C PENA      20261112 1200 098N 1732W 270 077 1006 1010 0334 15 056 -999 -999 -999 -999 S
NHC  92L INVEST    20261112 1200 098N 0732W 270 077 1006 1010 0334 15 056 -999 -999 -999 -999 S
JTWC 04P CHENGE    20251024 1200 090S 0546E 285 011 1001 1008 0235 18 075 0135 0115 -999 -999 M
garbage
"""


def test_parse_vitals_reads_position_wind_and_radius() -> None:
    fixes = parse_vitals(VITALS)
    assert [f.name for f in fixes] == ["FOUR", "XAVIER", "PENA", "CHENGE"]
    peak = fixes[1]
    assert (peak.lat, peak.lon) == (-9.6, -163.8)
    assert peak.time == datetime(2026, 11, 17, 18, tzinfo=UTC)
    assert peak.wind_kt == 128
    assert peak.r34_km == 128
    assert (peak.heading, peak.speed_ms) == (225, 1.6)
    assert fixes[2].r34_km is None


def test_build_feed_groups_a_storm_and_splits_seasons() -> None:
    now = datetime(2026, 11, 21, 12, tzinfo=UTC)
    feed = build_feed(parse_vitals(VITALS), now, datetime(2026, 11, 1, tzinfo=UTC))
    cyclones = feed["cyclones"]
    assert isinstance(cyclones, list)
    assert [(c["id"], c["name"], c["basin"]) for c in cyclones] == [
        ("20261112-04c", "Pena", "C"),
        ("20261115-04p", "Xavier", "P"),
    ]
    assert len(cyclones[1]["track"]) == 2
    assert cyclones[1]["track"][1] == [1794938400, -9.6, -163.8, 128, 128, 225, 1.6]


def test_uncrossed_drops_a_line_holding_another_storms_wind() -> None:
    crossed = """\
JTWC 30W IN-FA     20261028 0000 149N 1599E 280 037 0945 1011 0454 61 046 0167 0148 0148 0167 D
JTWC 30W IN-FA     20261028 0000 149N 1599E 280 037 0945 1011 0454 36 027 0148 0130 0111 -999 D
JTWC 02B ARNAB     20261028 0000 164N 0814E 275 042 0977 1002 0185 36 027 0148 0130 0111 -999 D
"""
    kept = uncrossed(parse_vitals(crossed))
    assert [(f.name, f.wind_kt) for f in kept] == [("IN-FA", 119), ("ARNAB", 70)]
