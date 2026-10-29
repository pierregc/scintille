"""Active storm cells (ADR 0021): the hours the catalog has not tracked, recomputed and linked."""

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

import polars as pl
from scintille_contract.active import ENDED_KEPT, EXPIRE_AFTER, OVERLAP, PATH_SPAN, SOURCE_GAP_AFTER
from scintille_contract.models import (
    SCHEMA_VERSION,
    SOURCE_VALUES,
    ActiveCell,
    ActiveStorms,
    EndedStorm,
    SourceFrontier,
)
from shapely import Polygon

from .clustering import unit_xyz
from .levels import _score, level_of
from .storm_cells import StormCellsConfig, labelled_hour
from .storm_levels import StormLevelsConfig, storm_minutes
from .storms import StormTracksConfig
from .tracking import HOUR, TIME, TRACK_SCHEMA, link

UPDATE_SECONDS = 300
MIN_LEVEL = 2
# A closed hour is recomputed until this long after its end, then kept as it is.
SETTLE = timedelta(minutes=15)
OWN_HOURS = 48
HULL_POINTS = 33
PATH_POINTS = 13
DIGITS = 4

STORM_INFO = pl.Schema(
    {
        "storm_id": pl.String(),
        "t_start": TIME,
        "split_from": pl.String(),
        "level_source": pl.String(),
        "flashes": pl.Int64(),
        "peak_rate": pl.Int64(),
        "level": pl.Int64(),
        "slug": pl.String(),
        "name": pl.String(),
    }
)
ASSIGNED = pl.Schema({"flash_id": pl.String(), "storm_id": pl.String()})


def floor_hour(t: datetime) -> datetime:
    return t.replace(minute=0, second=0, microsecond=0)


@dataclass(frozen=True)
class CatalogState:
    """The catalog as the feed sees it: end of its last tracked hour and that hour's storms.

    `storms` holds what the catalog knows of them (STORM_INFO); `slug` only once published.
    """

    tracked_until: datetime | None
    tracks: pl.DataFrame = field(default_factory=lambda: pl.DataFrame(schema=TRACK_SCHEMA))
    storms: pl.DataFrame = field(default_factory=lambda: pl.DataFrame(schema=STORM_INFO))


@dataclass(frozen=True)
class Update:
    """What one update reads: flashes from `ActiveFeed.window`, frontiers, catalog, hot spots."""

    now: datetime
    flashes: pl.DataFrame
    observed: dict[str, datetime]
    catalog: CatalogState
    hotspots: pl.DataFrame


@dataclass
class Hour:
    """One hour the catalog has not tracked: cells, the cell of each of its own flashes, path."""

    start: datetime
    cells: pl.DataFrame
    flashes: pl.DataFrame
    slices: pl.DataFrame
    frozen: bool
    tracks: pl.DataFrame | None = None


def hull_ring(wkt: str) -> list[list[float]]:
    """Closed [lon, lat] ring of a WKT hull, thinned to at most HULL_POINTS points."""
    inner = wkt[wkt.index("((") + 2 : wkt.rindex("))")]
    ring = [[round(float(v), DIGITS) for v in p.split()] for p in inner.split(",")]
    if len(ring) > HULL_POINTS:
        step = math.ceil((len(ring) - 1) / (HULL_POINTS - 1))
        ring = [*ring[:-1][::step], ring[0]]
    return ring


def _polygon(ring: list[list[float]], lon0: float) -> Polygon:
    return Polygon([((lon - lon0 + 180) % 360 - 180, lat) for lon, lat in ring])


def slices(flashes: pl.DataFrame) -> pl.DataFrame:
    """Centroid of each cell's flashes per 10 minute slice, at their mean event time."""
    xyz = unit_xyz(flashes["lat"].to_numpy(), flashes["lon"].to_numpy())
    return (
        flashes.with_columns(x=xyz[:, 0], y=xyz[:, 1], z=xyz[:, 2])
        .group_by("cell_id", pl.col("event_time").dt.truncate("10m").alias("slice"))
        .agg(
            pl.col("event_time").mean().alias("time"),
            pl.col("x").mean(),
            pl.col("y").mean(),
            pl.col("z").mean(),
            pl.len().cast(pl.Int64).alias("flash_count"),
        )
        .with_columns(
            lat=pl.arctan2("z", (pl.col("x") ** 2 + pl.col("y") ** 2).sqrt()).degrees(),
            lon=pl.arctan2("y", "x").degrees(),
        )
        .select("cell_id", "slice", "time", "lat", "lon", "flash_count")
    )


def live_levels(
    minutes: pl.DataFrame, catalog: pl.DataFrame, config: StormLevelsConfig
) -> pl.DataFrame:
    """ADR 0009 level per storm from the open hours' counts and the catalog's for earlier ones."""
    rule = config.rule
    own = minutes.group_by("storm_id", "source").agg(
        pl.col("flashes").sum().alias("total"), pl.col("flashes").max().alias("peak")
    )
    known = catalog.select(
        "storm_id",
        pl.col("level_source").alias("source"),
        pl.col("flashes").alias("total"),
        pl.col("peak_rate").alias("peak"),
    ).drop_nulls()
    both = pl.concat([own, known], how="vertical_relaxed")
    if rule.count == "all_sources":
        both = both.with_columns(source=pl.lit("all"))
    return (
        both.group_by("storm_id", "source")
        .agg(pl.col("total").sum(), pl.col("peak").max())
        .with_columns(score=_score(pl.col("total"), pl.col("peak"), rule.score))
        .sort("storm_id", "score", "total", "source", descending=[False, True, True, False])
        .group_by("storm_id", maintain_order=True)
        .first()
        .select(
            "storm_id",
            pl.col("total").cast(pl.Int64).alias("flashes"),
            level_of(pl.col("score"), rule).alias("level"),
        )
    )


class ActiveFeed:
    """Snapshots of storms/active.json, one per update, from the catalog's own functions.

    Keeps the hours it computed until the catalog tracks them, and the last published
    snapshot, so ids, levels, `ended` and `previous_ids` carry over between updates.
    """

    def __init__(
        self,
        previous: ActiveStorms | None = None,
        cells: StormCellsConfig | None = None,
        tracks: StormTracksConfig | None = None,
        levels: StormLevelsConfig | None = None,
    ) -> None:
        self.previous = previous
        self.cells = cells or StormCellsConfig()
        self.tracks = tracks or StormTracksConfig()
        self.levels = levels or StormLevelsConfig()
        self.hours: dict[datetime, Hour] = {}
        self.base: tuple[datetime, pl.DataFrame] | None = None
        self.assigned = pl.DataFrame(schema=ASSIGNED)
        self._pending = self.assigned
        self._chain: tuple[str, datetime, int] | None = None
        self._merged_into: dict[str, str] = {}
        self._scores: dict[datetime, list[pl.DataFrame]] = {}

    @property
    def overlap(self) -> timedelta:
        return timedelta(minutes=self.cells.overlap_minutes)

    def todo(self, now: datetime, tracked_until: datetime | None) -> list[datetime]:
        """Hours the next update recomputes: the open one, and the last one until it settles."""
        open_hour = floor_hour(now)
        last = open_hour - HOUR
        hours = [open_hour]
        settled = last in self.hours and self.hours[last].frozen
        if (tracked_until is None or last >= tracked_until) and not settled:
            hours.insert(0, last)
        return hours

    def window(self, now: datetime, tracked_until: datetime | None) -> datetime:
        """Earliest flash the next update needs."""
        return min(self.todo(now, tracked_until)) - self.overlap

    def update(self, data: Update) -> ActiveStorms:
        """The next snapshot; `published` must follow once it is written."""
        now, catalog = data.now, data.catalog
        tracked = catalog.tracked_until
        for start in [h for h in self.hours if tracked is not None and h < tracked]:
            del self.hours[start]
        flashes = data.flashes.sort("event_time", "flash_id")
        todo = self.todo(now, tracked)
        for start in todo:
            self.hours[start] = self._compute(flashes, start, now, data.hotspots)
        self._link(catalog)
        observed = self._observed(data)
        open_hour = floor_hour(now)
        recent = [h for h in self.hours.values() if h.start >= open_hour - 2 * HOUR]
        assigned = [
            h.flashes.join(self._tracks(h).select("cell_id", "storm_id"), on="cell_id")
            for h in recent
        ]
        self._pending = pl.concat(
            [a.select(ASSIGNED.names()) for a in assigned] or [pl.DataFrame(schema=ASSIGNED)]
        )
        for start in todo:
            frame = self._tracks(self.hours[start]).select("storm_id", "hour_flash_count")
            self._scores.setdefault(start, []).append(frame)
        candidates = self._candidates(catalog, observed, now)
        snapshot = self._reconcile(candidates, catalog, observed, now)
        self._trim()
        return snapshot

    def published(self, snapshot: ActiveStorms) -> None:
        """The snapshot is on R2: the next one follows from it."""
        self.previous = snapshot
        self.assigned = self._pending

    def id_scores(self, catalog: CatalogState) -> dict[str, float] | None:
        """Share of flashes whose storm had its final id, once the catalog tracks the hour:
        the worst update and the whole hour (ADR 0021 targets: 85 % and 90 %)."""
        if catalog.tracked_until is None:
            return None
        hour = catalog.tracked_until - HOUR
        for start in [h for h in self._scores if h < hour - 6 * HOUR]:
            del self._scores[start]
        frames = self._scores.pop(hour, [])
        if not frames:
            return None
        final = set(catalog.tracks["storm_id"].to_list())
        shares, kept, total = [], 0, 0
        for frame in frames:
            weight = frame["hour_flash_count"].fill_null(0)
            hit = int(weight.filter(frame["storm_id"].is_in(final)).sum())
            all_ = int(weight.sum())
            if all_:
                shares.append(hit / all_)
            kept, total = kept + hit, total + all_
        if not total:
            return None
        return {"worst_update": min(shares), "hour": kept / total, "updates": len(frames)}

    def _compute(
        self, flashes: pl.DataFrame, start: datetime, now: datetime, hotspots: pl.DataFrame
    ) -> Hour:
        cells, window = labelled_hour(
            flashes, start, self.overlap, self.cells.params, self.cells.rule, hotspots
        )
        own = window.filter(pl.col("event_time") >= start, pl.col("label") >= 0).join(
            cells.select("label", "cell_id"), on="label"
        )
        return Hour(
            start=start,
            cells=cells.drop("label"),
            flashes=own.select("flash_id", "cell_id"),
            slices=slices(own),
            frozen=now >= start + HOUR + SETTLE,
        )

    def _link(self, catalog: CatalogState) -> None:
        """Links the own hours in order, from the catalog's last hour when it is adjacent."""
        dirty = False
        previous: pl.DataFrame | None = None
        for start in sorted(self.hours):
            hour = self.hours[start]
            if previous is None:
                if start == catalog.tracked_until:
                    previous = catalog.tracks
                    chain = ("catalog", start, catalog.tracks.height)
                elif self.base is not None and self.base[0] == start - HOUR:
                    previous = self.base[1]
                    chain = ("base", start, previous.height)
                else:
                    previous = pl.DataFrame(schema=TRACK_SCHEMA)
                    chain = ("new", start, 0)
                dirty = chain != self._chain
                self._chain = chain
            elif start - HOUR not in self.hours:
                previous = pl.DataFrame(schema=TRACK_SCHEMA)
                dirty = True
            if dirty or hour.tracks is None:
                hour.tracks = link(previous, hour.cells, self.tracks.params)
                dirty = True
            previous = hour.tracks

    def _tracks(self, hour: Hour) -> pl.DataFrame:
        assert hour.tracks is not None
        return hour.tracks

    def _trim(self) -> None:
        while len(self.hours) > OWN_HOURS:
            oldest = min(self.hours)
            self.base = (oldest, self._tracks(self.hours.pop(oldest)))
        open_hour = max(self.hours, default=None)
        for hour in self.hours.values():
            if open_hour is not None and hour.start < open_hour - 2 * HOUR:
                hour.flashes = hour.flashes.clear()

    def _observed(self, data: Update) -> dict[str, datetime]:
        """Newest data per source; never earlier than the flashes or the last snapshot."""
        observed = dict(data.observed)
        newest = data.flashes.group_by("source").agg(pl.col("event_time").max())
        for source, time in newest.iter_rows():
            observed[source] = max(observed.get(source, time), time)
        if self.previous is not None:
            for frontier in self.previous.sources:
                old = frontier.observed_until
                if old is not None:
                    observed[frontier.source] = max(observed.get(frontier.source, old), old)
        return observed

    def _candidates(
        self, catalog: CatalogState, observed: dict[str, datetime], now: datetime
    ) -> dict[str, dict[str, Any]]:
        """Storms active now from the recent hours, any level, with their current cell."""
        open_hour = floor_hour(now)
        own = [self._tracks(h) for h in sorted(self.hours.values(), key=lambda h: h.start)]
        rows = pl.concat([catalog.tracks.select(TRACK_SCHEMA.names()).cast(TRACK_SCHEMA), *own])
        merged = {m for ms in rows["merged"].to_list() for m in ms}
        self._merged_into = {
            m: storm for storm, ms in rows.select("storm_id", "merged").iter_rows() for m in ms
        }
        latest = (
            rows.filter(pl.col("window_start") >= open_hour - 2 * HOUR)
            .sort("window_start")
            .group_by("storm_id", maintain_order=True)
            .last()
            .filter(~pl.col("storm_id").is_in(list(merged)))
        )
        own_rows = pl.concat(own) if own else rows.clear()
        cells = pl.concat([h.cells for h in self.hours.values()], how="diagonal_relaxed")
        minutes = (
            storm_minutes(own_rows, cells)
            if own_rows.height
            else pl.DataFrame(
                schema={
                    "storm_id": pl.String(),
                    "source": pl.String(),
                    "minute": TIME,
                    "flashes": pl.Int64(),
                }
            )
        )
        level = live_levels(minutes, catalog.storms, self.levels)
        first = (
            own_rows.sort("window_start")
            .group_by("storm_id", maintain_order=True)
            .agg(pl.col("t_start").min().alias("own_start"), pl.col("split_from").first())
        )
        paths = pl.concat(
            [
                h.slices.join(self._tracks(h).select("cell_id", "storm_id"), on="cell_id")
                for h in self.hours.values()
            ]
        ).filter(pl.col("time") >= now - PATH_SPAN)
        info = catalog.storms.rename({"t_start": "catalog_start", "split_from": "catalog_split"})
        # The catalog writes its tracks before its storms: their last cell bounds the first flash.
        before = catalog.tracks.group_by("storm_id").agg(pl.col("t_start").min().alias("tracked"))
        table = (
            latest.join(first, on="storm_id", how="left", suffix="_own")
            .join(before, on="storm_id", how="left")
            .join(level.rename({"level": "computed"}), on="storm_id", how="left")
            .join(info.drop("flashes", "level_source", "peak_rate"), on="storm_id", how="left")
        )
        by_storm = {
            storm: part.sort("slice")
            for (storm,), part in paths.partition_by("storm_id", as_dict=True).items()
        }
        tracked = catalog.tracked_until
        out: dict[str, dict[str, Any]] = {}
        for row in table.iter_rows(named=True):
            sources = sorted(row["sources"])
            until = max((observed[s] for s in sources if s in observed), default=None)
            t_end = row["t_end"]
            if until is None or t_end > until or until - t_end >= EXPIRE_AFTER:
                continue
            if now - until > SOURCE_GAP_AFTER:
                continue
            final = tracked is not None and row["storm_start"] < tracked
            starts = [
                t
                for t in (row["t_start"], row["own_start"], row["catalog_start"], row["tracked"])
                if t is not None
            ]
            levels_ = [v for v in (row["computed"], row["level"]) if v is not None]
            path = by_storm.get(row["storm_id"])
            out[row["storm_id"]] = {
                "id": row["storm_id"],
                "provisional": not final,
                "previous_ids": [],
                "slug": row["slug"] if final else None,
                "name": row["name"] if final else None,
                "level": max(levels_, default=1),
                "flashes": row["flashes"] or 0,
                "t_start": min(starts),
                "t_end": t_end,
                "lat": round(row["lat"], DIGITS),
                "lon": round(row["lon"], DIGITS),
                "bounds": {k: round(row[k], DIGITS) for k in ("west", "south", "east", "north")},
                "area_km2": round(row["area_km2"], 1),
                "hull": hull_ring(row["hull"]),
                "sources": sources,
                "split_from": row["split_from_own"] or row["catalog_split"] or row["split_from"],
                "merged": sorted(row["merged"]),
                "path": []
                if path is None
                else [
                    {
                        "time": p["time"],
                        "lat": round(p["lat"], DIGITS),
                        "lon": round(p["lon"], DIGITS),
                        "flash_count": p["flash_count"],
                    }
                    for p in path.iter_rows(named=True)
                ],
                "_first_own": min(self.hours, default=open_hour),
            }
        return out

    def _replacement(self, old: ActiveCell, candidates: dict[str, dict[str, Any]]) -> str | None:
        """The storm now holding most of a vanished storm's flashes, else whose hull overlaps
        its cell most."""
        lost = self.assigned.filter(pl.col("storm_id") == old.id).select("flash_id")
        if lost.height:
            now = lost.join(self._pending, on="flash_id").filter(
                pl.col("storm_id").is_in(list(candidates))
            )
            if now.height:
                counts = (
                    now.group_by("storm_id")
                    .len()
                    .sort(["len", "storm_id"], descending=[True, False])
                )
                return str(counts["storm_id"][0])
        shape = _polygon([list(p) for p in old.hull], old.lon)
        best, area = None, 0.0
        for storm, cell in sorted(candidates.items()):
            other = _polygon(cell["hull"], old.lon)
            if not shape.intersects(other):
                continue
            overlap = shape.intersection(other).area
            if overlap > area:
                best, area = storm, overlap
        return best

    def _reconcile(
        self,
        candidates: dict[str, dict[str, Any]],
        catalog: CatalogState,
        observed: dict[str, datetime],
        now: datetime,
    ) -> ActiveStorms:
        """Carries ids, levels and paths over from the last snapshot, and ends what left."""
        previous = self.previous
        tracked = catalog.tracked_until
        cells = dict(candidates)
        ended: list[EndedStorm] = []
        old_cells = {c.id: c for c in previous.cells} if previous else {}
        for storm, cell in cells.items():
            old = old_cells.get(storm)
            if old is None:
                continue
            cell["level"] = max(cell["level"], old.level)
            cell["previous_ids"] = list(old.previous_ids)
            cell["provisional"] = cell["provisional"] and old.provisional
            cell["split_from"] = cell["split_from"] or old.split_from
            cell["t_start"] = min(cell["t_start"], old.t_start)
            kept = [
                p.model_dump()
                for p in old.path
                if now - PATH_SPAN <= p.time < cell["_first_own"] and p.time <= cell["t_end"]
            ]
            cell["path"] = kept + cell["path"]
        for old in old_cells.values():
            if old.id in cells:
                continue
            reason, into = self._ending(old, candidates, observed, tracked, now)
            if reason is None:
                carried = old.model_dump()
                carried["path"] = [p for p in carried["path"] if p["time"] >= now - PATH_SPAN]
                cells[old.id] = carried
                continue
            if into is not None:
                target = cells[into]
                target["level"] = max(target["level"], old.level)
                if reason == "replaced":
                    ids = [old.id, *old.previous_ids, *target["previous_ids"]]
                    target["previous_ids"] = [i for i in dict.fromkeys(ids) if i != into]
            ended.append(
                EndedStorm(id=old.id, reason=reason, into=into, t_end=old.t_end, ended_at=now)
            )
        listed = sorted(
            (c for c in cells.values() if c["level"] >= MIN_LEVEL),
            key=lambda c: (-c["level"], -c["flashes"], c["id"]),
        )
        shown = {c["id"] for c in listed}
        gone = {e.id for e in ended}
        kept_ended = [
            e
            for e in (previous.ended if previous else [])
            if now - e.ended_at <= ENDED_KEPT and e.id not in shown and e.id not in gone
        ]
        for cell in listed:
            cell.pop("_first_own", None)
            cell["path"] = cell["path"][-PATH_POINTS:]
        return ActiveStorms(
            schema_version=SCHEMA_VERSION,
            published_at=now,
            authoritative_until=tracked,
            update_seconds=UPDATE_SECONDS,
            min_level=MIN_LEVEL,
            sources=[
                SourceFrontier(source=s, observed_until=observed.get(s)) for s in SOURCE_VALUES
            ],
            cells=[ActiveCell.model_validate(c) for c in listed],
            ended=sorted([*ended, *kept_ended], key=lambda e: (e.ended_at, e.id), reverse=True),
        )

    def _ending(
        self,
        old: ActiveCell,
        candidates: dict[str, dict[str, Any]],
        observed: dict[str, datetime],
        tracked: datetime | None,
        now: datetime,
    ) -> tuple[Any, str | None]:
        """Why a listed storm left, and the storm that continues it; (None, None) keeps it."""
        into = self._merged_into.get(old.id)
        if into is not None:
            return ("merged", into) if into in candidates else ("expired", None)
        until = max((observed[s] for s in old.sources if s in observed), default=None)
        if until is None or until - old.t_end >= EXPIRE_AFTER:
            return "expired", None
        if now - until > SOURCE_GAP_AFTER:
            return "source-gap", None
        target = self._replacement(old, candidates)
        if target is not None:
            return "replaced", target
        if old.provisional and tracked is not None and old.t_start < tracked - OVERLAP:
            return "expired", None
        return None, None
