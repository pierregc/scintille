"""Storm search in D1 (ADR 0027): published storms with their path, radius and tiles, synced by
digest from the hourly catalog run."""

import gzip
import hashlib
import json
import logging
import math
import os
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from itertools import pairwise
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

from scintille_contract.models import StormSummary

EARTH_KM = 6371.0
KM_PER_DEG = math.pi * EARTH_KM / 180
#: Covers the bulge of hourly great-circle arcs beyond their endpoints' box.
ARC_MARGIN_KM = 10.0
#: Replays live 60 days (R2 lifecycle); search keeps two days less.
RETENTION = timedelta(days=58)
DAY = 86400
SCHEMA = 1
STATE_PATH = "_pipeline/storms/search-state.json.gz"
#: Free D1 accepts 100,000 written rows a day; the rest is left for manual work.
DAILY_ROWS = 60_000
BATCH_ROWS = 1_500
DATABASE = "scintille-search"
log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Grid:
    deg: int
    offset: int

    @property
    def rows(self) -> int:
        return 180 // self.deg

    @property
    def cols(self) -> int:
        return 360 // self.deg

    def row(self, lat: float) -> int:
        return min(self.rows - 1, max(0, math.floor((lat + 90) / self.deg)))

    def tile(self, lat: float, lon: float) -> int:
        col = math.floor((_wrap(lon) + 180) / self.deg) % self.cols
        return self.offset + self.row(lat) * self.cols + col

    def box(self, south: float, north: float, west: float, east: float) -> set[int]:
        """Tiles of a box whose longitudes may run past ±180."""
        rows = range(self.row(max(-90.0, south)), self.row(min(90.0, north)) + 1)
        if east - west >= 360 or max(abs(south), abs(north)) >= 89.9:
            cols: Iterable[int] = range(self.cols)
        else:
            first = math.floor((west + 180) / self.deg)
            last = math.floor((east + 180) / self.deg)
            cols = {c % self.cols for c in range(first, last + 1)}
        return {self.offset + r * self.cols + c for r in rows for c in cols}


FINE = Grid(2, 0)
COARSE = Grid(10, 20_000)
#: Wider queries read the 10° grid.
FINE_MAX_KM = 500


def _wrap(lon: float) -> float:
    return ((lon + 180) % 360 + 360) % 360 - 180


def grid_for(km: float) -> Grid:
    return FINE if km <= FINE_MAX_KM else COARSE


def query_tiles(lat: float, lon: float, km: float) -> list[int]:
    """Tiles of the box around a disc of `km` around a point; the Worker has the same function."""
    grid = grid_for(km)
    d_lat = km / KM_PER_DEG
    south, north = max(-90.0, lat - d_lat), min(90.0, lat + d_lat)
    widest = max(abs(south), abs(north))
    d_lon = 180.0 if widest >= 89.9 else km / (KM_PER_DEG * math.cos(math.radians(widest)))
    if d_lon >= 180:
        return sorted(grid.box(south, north, -180.0, 180.0 + 360))
    return sorted(grid.box(south, north, lon - d_lon, lon + d_lon))


def path_tiles(path: Sequence[tuple[float, float]], radius_km: float, grid: Grid) -> set[int]:
    """Tiles met by the path's points and arcs, each widened by the storm radius."""
    reach = radius_km + ARC_MARGIN_KM
    tiles: set[int] = set()
    for (lat_a, lon_a), (lat_b, lon_b) in list(pairwise(path)) or [(path[0], path[0])]:
        lon_b = lon_a + _wrap(lon_b - lon_a)
        d_lat = reach / KM_PER_DEG
        south, north = min(lat_a, lat_b) - d_lat, max(lat_a, lat_b) + d_lat
        widest = min(90.0, max(abs(south), abs(north)))
        d_lon = 360.0 if widest >= 89.9 else reach / (KM_PER_DEG * math.cos(math.radians(widest)))
        tiles |= grid.box(south, north, min(lon_a, lon_b) - d_lon, max(lon_a, lon_b) + d_lon)
    return tiles


def days(t_start: datetime, t_end: datetime) -> range:
    """UTC days, as days since the epoch, from the storm's start to its end."""
    return range(int(t_start.timestamp()) // DAY, int(t_end.timestamp()) // DAY + 1)


def score(storm: StormSummary) -> float:
    """ADR 0009 score: square root of flashes times peak rate."""
    return math.sqrt(storm.flashes * storm.peak_rate)


@dataclass(frozen=True)
class SearchRow:
    slug: str
    t_start: int
    t_end: int
    level: int
    score: float
    summary: str
    path: str
    radius_km: float
    tiles: frozenset[tuple[int, int]]
    digest: str

    def values(self) -> dict[str, Any]:
        return {
            "slug": self.slug,
            "t_start": self.t_start,
            "t_end": self.t_end,
            "level": self.level,
            "score": self.score,
            "summary": self.summary,
            "path": self.path,
            "radius_km": self.radius_km,
            "digest": self.digest,
        }


def search_row(storm: StormSummary, track: Sequence[Mapping[str, Any]]) -> SearchRow:
    points = sorted(track, key=lambda point: point["time"])
    if not points:
        raise ValueError(f"storm without track: {storm.slug}")
    path = [(round(p["lat"], 3), round(p["lon"], 3)) for p in points]
    area = max((p.get("area_km2") or 0.0) for p in points)
    radius = round(math.sqrt(area / math.pi), 1)
    tiles = frozenset(
        (day, tile)
        for day in days(storm.t_start, storm.t_end)
        for grid in (FINE, COARSE)
        for tile in path_tiles(path, radius, grid)
    )
    summary = storm.model_dump_json()
    path_json = json.dumps(path, separators=(",", ":"))
    digest = hashlib.sha256(
        "\n".join([summary, path_json, str(radius), json.dumps(sorted(tiles))]).encode()
    ).hexdigest()[:16]
    return SearchRow(
        slug=storm.slug,
        t_start=int(storm.t_start.timestamp()),
        t_end=int(storm.t_end.timestamp()),
        level=storm.level,
        score=round(score(storm), 3),
        summary=summary,
        path=path_json,
        radius_km=radius,
        tiles=tiles,
        digest=digest,
    )


def retained(storm: StormSummary, now: datetime) -> bool:
    return storm.t_start >= now.astimezone(UTC) - RETENTION


class D1Error(RuntimeError):
    pass


@dataclass(frozen=True)
class Result:
    rows: list[dict[str, Any]]
    rows_read: int
    rows_written: int


class Database(Protocol):
    def run(self, statements: Sequence[tuple[str, Sequence[str]]]) -> list[Result]:
        """Runs statements in one transaction."""
        ...


class D1Rest:
    """D1 through the Cloudflare REST API, with a token limited to D1."""

    def __init__(self, account: str, database: str, token: str) -> None:
        self.url = f"https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{database}"
        self.token = token

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> "D1Rest | None":
        token = env.get("SCINTILLE_D1_TOKEN")
        account = env.get("SCINTILLE_CF_ACCOUNT_ID") or (
            (urlparse(env.get("SCINTILLE_R2_ENDPOINT", "")).hostname or "").split(".")[0]
        )
        if not token or not account:
            return None
        name = env.get("SCINTILLE_D1_DATABASE", DATABASE)
        listing = _call(
            f"https://api.cloudflare.com/client/v4/accounts/{account}/d1/database?name={quote(name)}",
            token,
        )
        found = [db for db in listing if isinstance(db, dict) and db.get("name") == name]
        if len(found) != 1:
            raise D1Error(f"D1 database {name} not found")
        return cls(account, str(found[0]["uuid"]), token)

    def run(self, statements: Sequence[tuple[str, Sequence[str]]]) -> list[Result]:
        body = {"batch": [{"sql": sql, "params": list(params)} for sql, params in statements]}
        results = _call(f"{self.url}/query", self.token, body)
        return [
            Result(
                rows=item.get("results") or [],
                rows_read=int(item.get("meta", {}).get("rows_read", 0)),
                rows_written=int(item.get("meta", {}).get("rows_written", 0)),
            )
            for item in results
        ]


def _call(url: str, token: str, body: object | None = None) -> list[Any]:
    request = Request(
        url,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="GET" if body is None else "POST",
    )
    try:
        with urlopen(request, timeout=60) as response:
            payload = json.load(response)
    except HTTPError as error:
        raise D1Error(f"D1 HTTP {error.code}: {error.read()[:500]!r}") from error
    except (URLError, TimeoutError, ValueError) as error:
        raise D1Error(f"D1 unreachable: {error}") from error
    if not payload.get("success"):
        raise D1Error(f"D1 error: {payload.get('errors')}")
    result = payload.get("result")
    return result if isinstance(result, list) else []


SCHEMA_SQL = (
    "CREATE TABLE IF NOT EXISTS storms (slug TEXT PRIMARY KEY, t_start INTEGER NOT NULL, "
    "t_end INTEGER NOT NULL, level INTEGER NOT NULL, score REAL NOT NULL, summary TEXT NOT NULL, "
    "path TEXT NOT NULL, radius_km REAL NOT NULL, digest TEXT NOT NULL) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS storm_tiles (day INTEGER NOT NULL, tile INTEGER NOT NULL, "
    "slug TEXT NOT NULL, PRIMARY KEY (day, tile, slug)) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID",
)
COLUMNS = ("slug", "t_start", "t_end", "level", "score", "summary", "path", "radius_km", "digest")
UPSERT_STORMS = (
    f"INSERT INTO storms ({', '.join(COLUMNS)}) SELECT "
    + ", ".join(f"json_extract(value, '$.{c}')" for c in COLUMNS)
    + " FROM json_each(?1) WHERE true ON CONFLICT (slug) DO UPDATE SET "
    + ", ".join(f"{c} = excluded.{c}" for c in COLUMNS[1:])
)
DELETE_STORMS = "DELETE FROM storms WHERE slug IN (SELECT value FROM json_each(?1))"
INSERT_TILES = (
    "INSERT OR IGNORE INTO storm_tiles (day, tile, slug) SELECT json_extract(value, '$[0]'), "
    "json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?1)"
)
DELETE_TILES = (
    "DELETE FROM storm_tiles WHERE (day, tile, slug) IN (SELECT json_extract(value, '$[0]'), "
    "json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?1))"
)
UPSERT_META = (
    "INSERT INTO meta (key, value) SELECT key, value FROM json_each(?1) WHERE true "
    "ON CONFLICT (key) DO UPDATE SET value = excluded.value"
)


@dataclass
class State:
    """What D1 holds, by slug: digest, start time and tiles. Saved after each committed batch."""

    day: str = ""
    written: int = 0
    storms: dict[str, tuple[str, int, frozenset[tuple[int, int]]]] = field(default_factory=dict)

    def dump(self) -> bytes:
        body = {
            "schema": SCHEMA,
            "day": self.day,
            "written": self.written,
            "storms": {
                slug: [digest, t_start, sorted(tiles)]
                for slug, (digest, t_start, tiles) in sorted(self.storms.items())
            },
        }
        return gzip.compress(json.dumps(body, separators=(",", ":")).encode(), mtime=0)

    @classmethod
    def load(cls, body: bytes) -> "State | None":
        value = json.loads(gzip.decompress(body))
        if value.get("schema") != SCHEMA:
            return None
        return cls(
            day=value["day"],
            written=value["written"],
            storms={
                slug: (digest, t_start, frozenset((d, t) for d, t in tiles))
                for slug, (digest, t_start, tiles) in value["storms"].items()
            },
        )


class StateStore(Protocol):
    def put(self, path: str, data: bytes, headers: dict[str, str]) -> None: ...

    def get(self, path: str) -> bytes | None: ...


def reconcile(db: Database, page: int = 20_000) -> State:
    """Rebuilds the state from what D1 holds, creating the tables if needed."""
    db.run([(sql, []) for sql in SCHEMA_SQL])
    state = State()
    after = ""
    while True:
        (result,) = db.run(
            [
                (
                    "SELECT slug, digest, t_start FROM storms WHERE slug > ?1 ORDER BY slug "
                    "LIMIT CAST(?2 AS INTEGER)",
                    [after, str(page)],
                )
            ]
        )
        for row in result.rows:
            state.storms[row["slug"]] = (row["digest"], int(row["t_start"]), frozenset())
        if len(result.rows) < page:
            break
        after = result.rows[-1]["slug"]
    tiles: dict[str, set[tuple[int, int]]] = {}
    cursor = [-1, -1, ""]
    while True:
        (result,) = db.run(
            [
                (
                    "SELECT day, tile, slug FROM storm_tiles WHERE (day, tile, slug) > "
                    "(CAST(?1 AS INTEGER), CAST(?2 AS INTEGER), ?3) ORDER BY day, tile, slug "
                    "LIMIT CAST(?4 AS INTEGER)",
                    [*map(str, cursor), str(page)],
                )
            ]
        )
        for row in result.rows:
            tiles.setdefault(row["slug"], set()).add((int(row["day"]), int(row["tile"])))
        if len(result.rows) < page:
            break
        last = result.rows[-1]
        cursor = [last["day"], last["tile"], last["slug"]]
    for slug, (digest, t_start, _) in state.storms.items():
        state.storms[slug] = (digest, t_start, frozenset(tiles.pop(slug, set())))
    # Tiles left without a storm are deleted by giving them an empty owner.
    for slug, orphan in tiles.items():
        state.storms[slug] = ("", 0, frozenset(orphan))
    return state


def _tile_rows(slug: str, tiles: Iterable[tuple[int, int]]) -> list[list[int | str]]:
    return [[day, tile, slug] for day, tile in sorted(tiles)]


def sync_search(
    store: StateStore,
    db: Database,
    published: Sequence[StormSummary],
    tracks: Mapping[str, Sequence[Mapping[str, Any]]],
    now: datetime,
) -> dict[str, int]:
    """Brings D1 to the published storms within retention, most recent first, within the daily
    write budget. Interrupted work resumes on the next run."""
    previous = store.get(STATE_PATH)
    state = (State.load(previous) if previous is not None else None) or reconcile(db)
    today = now.astimezone(UTC).date().isoformat()
    if state.day != today:
        state.day, state.written = today, 0
    wanted: dict[str, SearchRow] = {}
    missing = 0
    for storm in published:
        if not retained(storm, now):
            continue
        track = tracks.get(storm.storm_id)
        if not track:
            missing += 1
            continue
        wanted[storm.slug] = search_row(storm, track)
    changed = sorted(
        (row for slug, row in wanted.items() if state.storms.get(slug, ("",))[0] != row.digest),
        key=lambda row: (-row.t_end, row.slug),
    )
    expired = sorted(slug for slug in state.storms if slug not in wanted)
    metrics = {"search_upserted": 0, "search_deleted": 0, "search_rows_read": 0}
    work: list[tuple[str, SearchRow | None]] = [(row.slug, row) for row in changed]
    work += [(slug, None) for slug in expired]
    try:
        while work:
            batch: list[tuple[str, SearchRow | None]] = []
            cost = 0
            while work and cost < BATCH_ROWS:
                slug, row = work[0]
                old = state.storms.get(slug, ("", 0, frozenset()))[2]
                new = row.tiles if row else frozenset()
                estimate = 1 + len(new - old) + len(old - new)
                if state.written + cost + estimate > DAILY_ROWS:
                    break
                batch.append(work.pop(0))
                cost += estimate
            if not batch:
                break
            upserts = [row.values() for _, row in batch if row]
            deletes = [slug for slug, row in batch if row is None]
            add: list[list[int | str]] = []
            remove: list[list[int | str]] = []
            for slug, row in batch:
                old = state.storms.get(slug, ("", 0, frozenset()))[2]
                new = row.tiles if row else frozenset()
                add += _tile_rows(slug, new - old)
                remove += _tile_rows(slug, old - new)
            results = db.run(
                [
                    (UPSERT_STORMS, [json.dumps(upserts)]),
                    (DELETE_STORMS, [json.dumps(deletes)]),
                    (DELETE_TILES, [json.dumps(remove)]),
                    (INSERT_TILES, [json.dumps(add)]),
                ]
            )
            state.written += sum(result.rows_written for result in results)
            metrics["search_rows_read"] += sum(result.rows_read for result in results)
            for slug, row in batch:
                if row is None:
                    state.storms.pop(slug, None)
                else:
                    state.storms[slug] = (row.digest, row.t_start, row.tiles)
            metrics["search_upserted"] += len(upserts)
            metrics["search_deleted"] += len(deletes)
        last = max((storm.t_end for storm in published), default=None)
        meta = {
            "schema": str(SCHEMA),
            "published_at": now.astimezone(UTC).isoformat().replace("+00:00", "Z"),
            "last_observation_time": last.isoformat().replace("+00:00", "Z") if last else "",
            "pending": str(len(work)),
            "retention_days": str(RETENTION.days),
        }
        results = db.run([(UPSERT_META, [json.dumps(meta)])])
        state.written += sum(result.rows_written for result in results)
    finally:
        store.put(
            STATE_PATH,
            state.dump(),
            {"Content-Type": "application/gzip", "Cache-Control": "no-store"},
        )
    metrics["search_pending"] = len(work)
    metrics["search_missing_tracks"] = missing
    metrics["search_rows_written_today"] = state.written
    metrics["search_storms"] = len(state.storms)
    return metrics
