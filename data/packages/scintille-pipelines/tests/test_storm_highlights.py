from datetime import UTC, datetime, timedelta

import polars as pl
from scintille_contract.models import StormSummary
from scintille_pipelines.storm_highlights import highlights, storm_metrics

T0 = datetime(2026, 7, 15, tzinfo=UTC)


def storm(
    slug: str,
    start: float,
    hours: float,
    *,
    peak: int = 10,
    lat: float = 45.0,
    lon: float = 10.0,
    area: float = 100.0,
    score: float = 10.0,
    offshore: bool = False,
) -> tuple[StormSummary, dict[str, object]]:
    summary = StormSummary(
        storm_id=f"id-{slug}",
        slug=slug,
        name=slug,
        label=slug,
        country_code=None,
        t_start=T0 + timedelta(hours=start),
        t_end=T0 + timedelta(hours=start + hours),
        closed=True,
        flashes=1000,
        peak_rate=peak,
        level=3,
        level_name="Strong",
        level_rule="test",
        sources=["mtg-li"],
    )
    row = {
        "storm_id": summary.storm_id,
        "lat": lat,
        "lon": lon,
        "max_area_km2": area,
        "score": score,
        "offshore": offshore,
    }
    return summary, row


def pick(*storms: tuple[StormSummary, dict[str, object]]) -> list[tuple[str, str | None, str]]:
    result = highlights([s for s, _ in storms], pl.DataFrame([r for _, r in storms]), T0)
    return [(h.kind, h.area, h.storm.slug) for h in result.highlights]


def test_each_slot_shows_its_winner_once() -> None:
    picked = pick(
        storm("paris", 10, 2, score=50),
        storm("rome", 12, 2, score=40, lat=41.9, lon=12.5),
        storm("lagos", 13, 2, score=30, lat=6.5, lon=3.4),
        storm("miami", 14, 2, score=20, lat=25.8, lon=-80.2),
        storm("long", -50, 9, score=1, peak=5),
        storm("intense", -40, 1, score=1, peak=900),
        storm("wide", -30, 1, score=1, area=50_000),
    )
    assert picked == [
        ("day", None, "paris"),
        ("area", "americas", "miami"),
        ("area", "africa", "lagos"),
        ("longest", None, "long"),
        ("intense", None, "intense"),
        ("largest", None, "wide"),
    ]


def test_a_runner_up_never_inherits_a_title() -> None:
    picked = pick(storm("best", 10, 2, score=50), storm("second", 12, 2, score=10))
    assert picked == [("day", None, "best")]


def test_windows_follow_the_latest_observation_not_the_clock() -> None:
    picked = pick(storm("old", -100, 2, score=100), storm("recent", 20, 2, score=1))
    assert picked[:2] == [("day", None, "recent"), ("week", None, "old")]


def test_short_storms_are_never_highlighted() -> None:
    assert pick(storm("brief", 0, 0.4, score=1000, peak=10_000)) == []


def test_night_and_land_raise_the_ranking() -> None:
    # 22:00 to 23:00 UTC is night in Europe; the same storm at noon is in daylight.
    night = storm("night", 22, 1, score=10)
    noon = storm("noon", 12, 1, score=11)
    assert pick(night, noon)[0] == ("day", None, "night")
    sea = storm("sea", 22, 1, score=11, offshore=True)
    assert pick(storm("land", 22, 1, score=10), sea)[0] == ("day", None, "land")


def test_empty_catalog_publishes_no_highlights() -> None:
    result = highlights([], pl.DataFrame(), T0)
    assert result.highlights == [] and result.last_observation_time is None


def test_metrics_join_gold_tables() -> None:
    storms = pl.DataFrame({"storm_id": ["a"], "lat": [1.0], "lon": [2.0], "max_area_km2": [3.0]})
    levels = pl.DataFrame({"storm_id": ["a"], "score": [4.0]})
    names = pl.DataFrame({"storm_id": ["a"], "offshore": [True]})
    assert storm_metrics(storms, levels, names).row(0) == ("a", 1.0, 2.0, 3.0, 4.0, True)
