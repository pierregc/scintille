"""Spike: tropical cyclone tracks from NCEP TC vitals, as one small JSON feed."""

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

ATTRIBUTION = "NOAA NCEP TC vitals (NHC, CPHC, JTWC)"
SCHEMA_VERSION = "0.1.0"
MS_TO_KT = 1.943844
# A storm number comes back every season: a longer silence starts another storm.
SAME_STORM = timedelta(days=5)
MISSING = -999


@dataclass(frozen=True)
class Fix:
    agency: str
    number: str
    name: str
    time: datetime
    lat: float
    lon: float
    heading: int | None
    speed_ms: float | None
    pressure_hpa: int | None
    wind_kt: int | None
    r34_km: int | None


def _number(text: str) -> int | None:
    try:
        value = int(text)
    except ValueError:
        return None
    return None if value == MISSING else value


def _angle(text: str, negative: str) -> float:
    return int(text[:-1]) / 10 * (-1 if text[-1] == negative else 1)


def parse_vitals(text: str) -> list[Fix]:
    """Fixes of named or numbered cyclones; invests (90 to 99) and broken lines are skipped."""
    fixes = []
    for line in text.splitlines():
        f = line.split()
        if len(f) < 13 or not f[1][:2].isdigit() or int(f[1][:2]) >= 90:
            continue
        try:
            time = datetime.strptime(f[3] + f[4], "%Y%m%d%H%M").replace(tzinfo=UTC)
            lat, lon = _angle(f[5], "S"), _angle(f[6], "W")
        except ValueError:
            continue
        speed, wind = _number(f[8]), _number(f[12])
        radii = [r for r in map(_number, f[14:18]) if r is not None]
        fixes.append(
            Fix(
                agency=f[0],
                number=f[1],
                name=f[2],
                time=time,
                lat=lat,
                lon=lon,
                heading=_number(f[7]),
                speed_ms=None if speed is None else speed / 10,
                pressure_hpa=_number(f[9]),
                wind_kt=None if wind is None else round(wind * MS_TO_KT),
                r34_km=round(sum(radii) / len(radii)) if radii else None,
            )
        )
    return fixes


def uncrossed(fixes: list[Fix]) -> list[Fix]:
    """Drops lines an archive wrote across two storms: one storm's time, another's wind."""
    seen: dict[tuple[datetime, int | None, int | None], set[str]] = {}
    count: dict[tuple[str, datetime], int] = {}
    for fix in fixes:
        seen.setdefault((fix.time, fix.wind_kt, fix.r34_km), set()).add(fix.number)
        count[fix.number, fix.time] = count.get((fix.number, fix.time), 0) + 1
    return [
        fix
        for fix in fixes
        if count[fix.number, fix.time] == 1 or len(seen[fix.time, fix.wind_kt, fix.r34_km]) == 1
    ]


def build_feed(fixes: list[Fix], now: datetime, since: datetime) -> dict[str, object]:
    """One track per storm seen since `since`.

    Rows are `[unix_s, lat, lon, wind_kt, r34_km, heading, speed_ms]`.
    """
    storms: list[list[Fix]] = []
    latest: dict[str, list[Fix]] = {}
    for fix in sorted(uncrossed(list(dict.fromkeys(fixes))), key=lambda x: x.time):
        track = latest.get(fix.number)
        if track is None or fix.time - track[-1].time > SAME_STORM:
            track = latest[fix.number] = []
            storms.append(track)
        if track and track[-1].time == fix.time:
            track[-1] = fix
        else:
            track.append(fix)
    cyclones = [
        {
            "id": f"{track[0].time:%Y%m%d}-{track[0].number.lower()}",
            "number": track[0].number,
            "name": track[-1].name.title(),
            "basin": track[0].number[-1],
            "agency": track[-1].agency,
            "track": [
                [int(x.time.timestamp()), x.lat, x.lon, x.wind_kt, x.r34_km, x.heading, x.speed_ms]
                for x in track
            ],
        }
        for track in storms
        if track[-1].time >= since
    ]
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "attribution": ATTRIBUTION,
        "cyclones": cyclones,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="TC vitals files to a cyclone feed on stdout.")
    parser.add_argument("vitals", nargs="+", type=Path)
    parser.add_argument("--days", type=int, default=60)
    args = parser.parse_args()
    now = datetime.now(UTC)
    fixes = [fix for path in args.vitals for fix in parse_vitals(path.read_text())]
    feed = build_feed(fixes, now, now - timedelta(days=args.days))
    json.dump(feed, sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    main()
