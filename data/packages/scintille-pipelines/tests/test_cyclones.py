from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from scintille_contract.models import CycloneFeed
from scintille_pipelines.cyclones import (
    PATH,
    cycles,
    display_name,
    marker_url,
    merge,
    parse_ibtracs,
    parse_vitals,
    read_cycles,
    read_feed,
    update,
    vitals_url,
)
from scintille_pipelines.definitions import defs

H = timedelta(hours=1)
NOON = datetime(2026, 11, 17, 12, tzinfo=UTC)
VITALS = """\
JTWC 04P FOUR      20261115 0600 084S 1589W 285 011 1001 1008 0250 18 083 0167 0111 0093 -999 M
JTWC 04P XAVIER    20261117 1800 096S 1638W 225 016 0929 1008 0222 66 022 0139 0139 0139 0093 S
NHC  04C PENA      20261112 1200 098N 1732W 270 077 1006 1010 0334 15 056 -999 -999 -999 -999 S
NHC  92L INVEST    20261112 1200 098N 0732W 270 077 1006 1010 0334 15 056 -999 -999 -999 -999 S
JTWC 04P CHENGE    20251024 1200 090S 0546E 285 011 1001 1008 0235 18 075 0135 0115 -999 -999 M
garbage
"""
XAVIER_12 = (
    "JTWC 04P XAVIER    20261117 1200 093S 1638W 250 021 0936 1008 0370"
    " 64 022 0139 0148 0148 0111 D"
)
XAVIER_18 = VITALS.splitlines()[1]


class MemoryStore:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.puts = 0

    def put(self, path: str, data: bytes, headers: dict[str, str]) -> None:
        self.objects[path] = data
        self.puts += 1

    def get(self, path: str) -> bytes | None:
        return self.objects.get(path)

    def exists(self, path: str) -> bool:
        return path in self.objects


def server(files: dict[datetime, str | None]):  # type: ignore[no-untyped-def]
    """Cycles with vitals (text) or without a storm (None); other cycles do not exist yet."""
    urls: dict[str, str] = {}
    for cycle, text in files.items():
        urls[marker_url(cycle)] = "idx"
        if text is not None:
            urls[vitals_url(cycle)] = text
    return urls.get


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


def test_display_name_uses_the_number_until_the_storm_is_named() -> None:
    assert display_name("FOUR", "04P") == "04P"
    assert display_name("TWENTY-ON", "21E") == "21E"
    assert display_name("THIRTYONE", "31W") == "31W"
    assert display_name("IN-FA", "30W") == "In-Fa"
    assert display_name("ONE", "02B") == "One"
    assert display_name("", "05S") == "05S"


def test_merge_builds_one_track_per_storm_and_splits_seasons() -> None:
    now = datetime(2026, 11, 18, tzinfo=UTC)
    tracks = merge([], parse_vitals(VITALS), NOON + 6 * H, now)
    assert [(c.id, c.name, c.basin, c.agency) for c in tracks] == [
        ("20261112-04c", "Pena", "C", "NHC"),
        ("20261115-04p", "Xavier", "P", "JTWC"),
    ]
    xavier = tracks[1]
    assert [f.wind_kt for f in xavier.track] == [35, 128]
    assert xavier.active and not tracks[0].active


def test_merge_replaces_a_reissued_fix_and_keeps_the_id() -> None:
    now = datetime(2026, 11, 18, tzinfo=UTC)
    first = merge([], parse_vitals(XAVIER_12), NOON, now)
    reissued = XAVIER_12.replace(" 64 022", " 70 022")
    tracks = merge(first, parse_vitals(reissued + "\n" + XAVIER_18), NOON + 6 * H, now)
    assert [c.id for c in tracks] == ["20261117-04p"]
    assert [f.wind_kt for f in tracks[0].track] == [136, 128]


def test_merge_ends_a_storm_absent_from_two_cycles_and_drops_old_ones() -> None:
    first = merge([], parse_vitals(XAVIER_12), NOON, NOON)
    assert merge(first, [], NOON + 6 * H, NOON + 9 * H)[0].active
    assert not merge(first, [], NOON + 12 * H, NOON + 15 * H)[0].active
    assert merge(first, [], NOON + 12 * H, NOON + timedelta(days=61)) == []


def test_cycles_are_the_latest_six_hourly_times() -> None:
    assert cycles(datetime(2026, 11, 17, 14, 50, tzinfo=UTC), 2) == [NOON, NOON - 6 * H]


def test_read_cycles_tells_an_unpublished_cycle_from_one_without_storms() -> None:
    times = [NOON + 6 * H, NOON, NOON - 6 * H]
    fixes, newest = read_cycles(times, server({NOON: XAVIER_12, NOON - 6 * H: None}))
    assert newest == NOON and len(fixes) == 1
    fixes, newest = read_cycles(times, server({NOON: None, NOON - 6 * H: XAVIER_12}))
    assert newest == NOON and len(fixes) == 1
    assert read_cycles(times, server({})) == ([], None)


def test_update_writes_only_when_the_feed_changes() -> None:
    store = MemoryStore()
    fetch = server({NOON: XAVIER_12})
    feed, written = update(store, fetch, NOON + 3 * H)
    assert written and store.puts == 1
    assert feed.source_cycle == NOON and feed.cyclones[0].name == "Xavier"
    assert read_feed(store) == feed
    again, written = update(store, fetch, NOON + 4 * H)
    assert not written and store.puts == 1 and again == feed
    later = server({NOON: XAVIER_12, NOON + 6 * H: XAVIER_18})
    feed, written = update(store, later, NOON + 9 * H)
    assert written and len(feed.cyclones[0].track) == 2
    assert feed.generated_at == NOON + 9 * H


def test_update_fails_when_no_cycle_is_found_and_keeps_the_feed() -> None:
    store = MemoryStore()
    update(store, server({NOON: XAVIER_12}), NOON + 3 * H)
    body = store.objects[PATH]
    with pytest.raises(RuntimeError, match="no advisory cycle"):
        update(store, server({}), NOON + 3 * H)
    assert store.objects[PATH] == body


def test_update_dry_run_writes_nothing() -> None:
    store = MemoryStore()
    feed, written = update(store, server({NOON: XAVIER_12}), NOON + 3 * H, dry_run=True)
    assert written and feed.cyclones and store.puts == 0


def test_parse_ibtracs_keeps_six_hourly_fixes_of_the_us_agencies() -> None:
    columns = (
        "SID,BASIN,SUBBASIN,NAME,ISO_TIME,USA_ATCF_ID,USA_LAT,USA_LON,USA_WIND,"
        "USA_R34_NE,USA_R34_SE,USA_R34_SW,USA_R34_NW,STORM_SPEED,STORM_DIR"
    )
    text = "\n".join(
        [
            columns,
            " , , , , , ,degrees_north,degrees_east,kts,nmile,nmile,nmile,nmile,kts,degrees",
            "a,SP,MM,XAVIER,2026-11-15 06:00:00,SH042027,-8.4,-158.9,35,90, ,60, ,6,275",
            "a,SP,MM,XAVIER,2026-11-15 09:00:00,SH042027,-8.4,-159.2,35, , , , ,6,280",
            "b,NI,BB,AKVAN,2026-11-16 18:00:00,IO052026,11.0,87.0,30, , , , ,10,5",
            "c,WP,MM,NOT_NAMED,2026-11-16 18:00:00,WP322026,11.0,187.0,25, , , , , , ",
            "d,WP,MM,INVEST,2026-11-16 18:00:00,WP952026,11.0,140.0,20, , , , ,3,90",
            "e,SI,MM,OTHER,2026-11-16 18:00:00, , , , , , , , ,3,90",
        ]
    )
    fixes = parse_ibtracs(text)
    assert [(f.number, f.name, f.agency) for f in fixes] == [
        ("04P", "XAVIER", "JTWC"),
        ("05B", "AKVAN", "JTWC"),
        ("32W", "", "JTWC"),
    ]
    assert (fixes[0].r34_km, fixes[0].heading, fixes[0].speed_ms) == (139, 275, 3.1)
    assert fixes[2].lon == -173.0 and fixes[2].speed_ms is None


def test_older_fixes_extend_a_track_backwards_without_a_second_storm() -> None:
    store = MemoryStore()
    older = [f for f in parse_vitals(VITALS) if f.name == "FOUR"]
    feed, _ = update(store, server({NOON: XAVIER_12}), NOON + 3 * H, older=older)
    assert [(c.id, c.name, len(c.track)) for c in feed.cyclones] == [("20261115-04p", "Xavier", 2)]


def test_the_feed_runs_every_hour() -> None:
    schedule = defs.get_schedule_def("hourly_cyclones_schedule")
    assert schedule.cron_schedule == "50 * * * *"
    assert defs.get_job_def("hourly_cyclones").asset_layer.executable_asset_keys


def test_the_fixture_follows_the_contract() -> None:
    path = Path(__file__).parents[4] / "fixtures/cyclones/tracks.json"
    feed = CycloneFeed.model_validate_json(path.read_text())
    assert [c.name for c in feed.cyclones if c.active] == ["Dolly", "Nida"]
