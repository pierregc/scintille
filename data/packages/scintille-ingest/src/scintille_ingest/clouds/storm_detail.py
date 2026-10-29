"""Detail tiles kept under the strongest storms of each day once a frame's full pack expires."""

import asyncio
import math
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from pydantic import AwareDatetime, BaseModel

from scintille_ingest.runtime.live_feed import LiveStore

from . import tiles

TOP_STORMS = 10
"""Storms kept per UTC day of their start, by flashes times peak rate (the level score)."""
LEVELS = (4, 5)
"""About 2 and 1 km: the levels a close view needs over the storm."""
WINDOW = timedelta(hours=1)
"""Track positions this close to a frame count for it: a replay blends the two frames around it."""
KM_PER_DEGREE = 111.2


class StormSummary(BaseModel):
    """The fields read from `storms/index/<page>.json` (StormIndexPage in the contract), any
    version."""

    slug: str
    t_start: AwareDatetime
    flashes: int
    peak_rate: int


class StormIndexPage(BaseModel):
    total_pages: int
    storms: list[StormSummary]


class TrackPoint(BaseModel):
    time: AwareDatetime
    lat: float
    lon: float
    area_km2: float


class StormDetail(BaseModel):
    """The track of `storms/<slug>.json`."""

    track: list[TrackPoint]


@dataclass(frozen=True)
class Position:
    lat: float
    lon: float
    radius_km: float


def score(storm: StormSummary) -> int:
    return storm.flashes * storm.peak_rate


class StormTracks:
    """Track positions of the top storms, read from the published catalog (`storms/` in the live
    bucket): index pages from the newest back to the day before, then each storm's file."""

    def __init__(self, store: LiveStore, top: int = TOP_STORMS) -> None:
        self.store = store
        self.top = top

    async def positions(self, times: Iterable[datetime]) -> dict[datetime, list[Position]]:
        times = sorted(set(times))
        if not times:
            return {}
        days = {t.date() + timedelta(days=d) for t in times for d in (-1, 0)}
        storms = await self._top(days)
        docs = await asyncio.gather(*(self._detail(s.slug) for s in storms))
        return {
            t: [
                Position(p.lat, p.lon, math.sqrt(p.area_km2 / math.pi))
                for doc in docs
                if doc is not None
                for p in doc.track
                if abs(p.time - t) <= WINDOW
            ]
            for t in times
        }

    async def _top(self, days: set[date]) -> list[StormSummary]:
        latest = await self._page("latest")
        if latest is None:
            return []
        start = min(days)
        found: dict[str, StormSummary] = {}
        page: StormIndexPage | None = latest
        number = latest.total_pages - 1
        while page is not None:
            for storm in page.storms:
                if storm.t_start.date() in days:
                    found[storm.slug] = storm
            if not page.storms or min(s.t_start for s in page.storms).date() < start or number == 0:
                break
            number -= 1
            page = await self._page(str(number))
        by_day: dict[date, list[StormSummary]] = {}
        for storm in found.values():
            by_day.setdefault(storm.t_start.date(), []).append(storm)
        return [
            s
            for listed in by_day.values()
            for s in sorted(listed, key=score, reverse=True)[: self.top]
        ]

    async def _page(self, name: str) -> StormIndexPage | None:
        data = await self.store.get(f"index/{name}.json")
        return StormIndexPage.model_validate_json(data) if data else None

    async def _detail(self, slug: str) -> StormDetail | None:
        data = await self.store.get(f"{slug}.json")
        return StormDetail.model_validate_json(data) if data else None


def keys_under(positions: Iterable[Position], levels: Iterable[int] = LEVELS) -> set[tiles.Key]:
    """Tiles of `levels` that a disc around any position touches."""
    keys: set[tiles.Key] = set()
    for p in positions:
        dlat = p.radius_km / KM_PER_DEGREE
        dlon = dlat / max(math.cos(math.radians(p.lat)), 0.2)
        for z in levels:
            step = 180 / tiles.rows(z)
            y0 = max(math.floor((90 - min(p.lat + dlat, 90)) / step), 0)
            y1 = min(math.floor((90 - max(p.lat - dlat, -90)) / step), tiles.rows(z) - 1)
            x0 = math.floor((p.lon - dlon + 180) / step)
            x1 = math.floor((p.lon + dlon + 180) / step)
            for y in range(y0, y1 + 1):
                for x in range(x0, x1 + 1):
                    keys.add(tiles.Key(z, y, x % tiles.columns(z)))
    return keys
