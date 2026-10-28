"""What the active storm feed reads: new silver and bronze files only, the spool, the catalog."""

import json
import logging
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import obstore
import polars as pl
from obstore.store import ObjectStore
from pyiceberg.catalog import Catalog
from pyiceberg.conversions import from_bytes
from pyiceberg.expressions.parser import parse
from pyiceberg.io.pyarrow import ArrowScan
from pyiceberg.manifest import DataFile, ManifestEntryStatus
from pyiceberg.table import FileScanTask, Table
from pyiceberg.types import TimestamptzType
from scintille_contract.models import SCHEMA_VERSION, ActiveStorms
from scintille_lake.tables import FLASHES, INGEST_LOG

from .active_storms import STORM_INFO, CatalogState
from .hotspots import CELL, HotspotRule, hotspots_from_hours, pixel_hours
from .storm_catalog import ObjectCatalogStore, published_slugs
from .storm_levels import STORM_LEVELS
from .storm_names import STORM_NAMES
from .storms import STORM_TRACKS, STORMS
from .tracking import HOUR, TIME, TRACK_SCHEMA

ACTIVE_PATH = "storms/active.json"
HEADERS = {"Content-Type": "application/json", "Cache-Control": "public, max-age=30"}
FIELDS = ("flash_id", "source", "event_time", "lat", "lon")
# Flashes kept for the window (150 minutes at most), files listed afresh once a day.
KEEP = timedelta(hours=3)
RELIST = timedelta(days=1)
THREADS = 4
BATCH = 64
DAY = timedelta(days=1)
# Silver files of older products are no longer revised, so their counts are merged.
SETTLE = timedelta(hours=6)
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
log = logging.getLogger("scintille_pipelines.active_storms")


def _frame(value: Any) -> pl.DataFrame:
    df = pl.from_arrow(value)
    assert isinstance(df, pl.DataFrame)
    return df


def _between(column: str, lo: datetime, hi: datetime) -> str:
    return f"{column} >= '{lo.isoformat()}' AND {column} < '{hi.isoformat()}'"


def _flashes(df: pl.DataFrame) -> pl.DataFrame:
    return df.select(
        pl.col("flash_id").cast(pl.String),
        pl.col("source").cast(pl.String),
        pl.col("event_time").cast(TIME),
        pl.col("lat").cast(pl.Float64),
        pl.col("lon").cast(pl.Float64),
    )


EMPTY = _flashes(pl.DataFrame(schema={f: TIME if f == "event_time" else pl.String for f in FIELDS}))


NO_HOTSPOTS = pl.DataFrame(schema={"source": pl.String, "lat": pl.Float64, "lon": pl.Float64})


def newest(files: pl.DataFrame) -> dict[str, datetime]:
    """End of the newest product file per source."""
    ends = files.group_by(pl.col("source").cast(pl.String)).agg(
        pl.col("product_end").cast(TIME).max()
    )
    return {source: end for source, end in ends.iter_rows() if end is not None}


def read_spool(directory: Path, since: datetime) -> tuple[pl.DataFrame, dict[str, datetime]]:
    """Batches lake-writer has not committed yet, a temporary input while silver commits too
    slowly (ADR 0021). A batch deleted while being read is committed, so it is in silver."""
    frames, files = [], []
    for path in sorted(directory.glob("*.parquet")):
        if path.name.count(".") != 1:
            continue
        try:
            if path.stat().st_mtime < since.timestamp():
                continue
            log_rows = pl.read_parquet(
                path.with_name(f"{path.stem}.log.parquet"), columns=["source", "product_end"]
            )
            flashes = pl.read_parquet(path, columns=list(FIELDS))
        except FileNotFoundError:
            continue
        frames.append(_flashes(flashes))
        files.append(log_rows)
    flashes = pl.concat(frames) if frames else EMPTY
    return flashes, newest(pl.concat(files, how="vertical_relaxed")) if files else {}


class Increments:
    """Data files a table gained or lost since the last poll, from the new snapshots' manifests;
    everything matching `listing` on the first poll, when the history is broken, or once a day."""

    def __init__(self) -> None:
        self.snapshot_id: int | None = None
        self.listed: datetime | None = None

    def poll(
        self, table: Table, listing: str, now: datetime
    ) -> tuple[list[DataFile], set[str], bool]:
        snapshot = table.current_snapshot()
        if snapshot is None or snapshot.snapshot_id == self.snapshot_id:
            return [], set(), False
        new: set[int] = set()
        step: Any = snapshot
        while step is not None and step.snapshot_id != self.snapshot_id:
            new.add(step.snapshot_id)
            parent = step.parent_snapshot_id
            step = None if parent is None else table.metadata.snapshot_by_id(parent)
        stale = self.listed is None or now - self.listed >= RELIST
        if self.snapshot_id is None or step is None or stale:
            files = [task.file for task in table.scan(row_filter=listing).plan_files()]
            self.snapshot_id, self.listed = snapshot.snapshot_id, now
            return files, set(), True
        added: dict[str, DataFile] = {}
        removed: set[str] = set()
        for manifest in snapshot.manifests(table.io):
            if manifest.added_snapshot_id not in new:
                continue
            for entry in manifest.fetch_manifest_entry(table.io, discard_deleted=False):
                if entry.snapshot_id not in new:
                    continue
                path = entry.data_file.file_path
                if entry.status == ManifestEntryStatus.DELETED:
                    removed.add(path)
                else:
                    added[path] = entry.data_file
        self.snapshot_id = snapshot.snapshot_id
        return [f for p, f in added.items() if p not in removed], removed, False


def _upper(table: Table, data_file: DataFile, column: str) -> datetime | None:
    field = table.schema().find_field(column)
    bound = (data_file.upper_bounds or {}).get(field.field_id)
    if bound is None:
        return None
    micros = from_bytes(TimestamptzType(), bound)
    assert isinstance(micros, int)
    return EPOCH + timedelta(microseconds=micros)


def read_files[T](
    table: Table,
    files: list[DataFile],
    fields: tuple[str, ...],
    row_filter: str,
    use: Callable[[pl.DataFrame], T],
) -> list[tuple[str, T]]:
    """`use` of each file's rows matching `row_filter`, read in parallel."""
    scan = ArrowScan(table.metadata, table.io, table.schema().select(*fields), parse(row_filter))

    def read(data_file: DataFile) -> tuple[str, T]:
        return data_file.file_path, use(_frame(scan.to_table([FileScanTask(data_file)])))

    with ThreadPoolExecutor(THREADS) as pool:
        return list(pool.map(read, files))


class SilverCache:
    """Recent flashes of silver for the window, and pixel counts per hour for the hot spots,
    both fed by the files added since the last update.

    Counts of files older than SETTLE are merged; there, an hour older than a day is kept only
    for cells with enough flashes over the lookback to ever make a hot spot day.
    """

    def __init__(self, rule: HotspotRule) -> None:
        self.rule = rule
        self.increments = Increments()
        self.rows: dict[str, pl.DataFrame] = {}
        self.pixels: dict[str, pl.DataFrame] = {}
        self.settled = pixel_hours(EMPTY, rule)
        self.files_read = 0

    def refresh(self, table: Table, now: datetime) -> None:
        oldest = (now - self.rule.lookback - HOUR).replace(minute=0, second=0, microsecond=0)
        added, removed, full = self.increments.poll(
            table, f"event_time >= '{oldest.isoformat()}'", now
        )
        if full:
            self.rows.clear()
            self.pixels.clear()
            self.settled = self.settled.clear()
        for path in removed:
            self.rows.pop(path, None)
            self.pixels.pop(path, None)
        wanted = [f for f in added if (_upper(table, f, "event_time") or now) >= oldest]
        recent = now - KEEP

        def use(df: pl.DataFrame) -> tuple[pl.DataFrame, pl.DataFrame]:
            df = _flashes(df)
            return pixel_hours(df, self.rule), df.filter(pl.col("event_time") >= recent)

        for start in range(0, len(wanted), BATCH):
            part = wanted[start : start + BATCH]
            for path, (pixels, rows) in read_files(table, part, FIELDS, _since(oldest), use):
                self.pixels[path] = pixels
                if rows.height:
                    self.rows[path] = rows
            self._settle(now, oldest)
        self.files_read = len(wanted)
        for path in list(self.rows):
            self.rows[path] = self.rows[path].filter(pl.col("event_time") >= recent)
            if self.rows[path].is_empty():
                del self.rows[path]
        self._settle(now, oldest)

    def _settle(self, now: datetime, oldest: datetime) -> None:
        ready = [
            path
            for path, df in self.pixels.items()
            if df.is_empty() or _hour(df["hour"].max()) < now - SETTLE
        ]
        frames = [self.settled, *(self.pixels.pop(path) for path in ready)]
        merged = (
            pl.concat(frames)
            .filter(pl.col("hour") >= oldest)
            .group_by(*CELL, "hour")
            .agg(pl.col("flashes", "lat_sum", "lon_sum", "lat_sq", "lon_sq").sum())
        )
        totals = (
            pl.concat([merged, *self.pixels.values()])
            .group_by(CELL)
            .agg(pl.col("flashes").sum().alias("total"))
        )
        self.settled = (
            merged.join(totals, on=CELL)
            .filter(
                (pl.col("hour") >= now - DAY) | (pl.col("total") >= self.rule.pixel_min_flashes)
            )
            .drop("total")
        )

    def window(self, since: datetime) -> pl.DataFrame:
        frames = [df.filter(pl.col("event_time") >= since) for df in self.rows.values()]
        return pl.concat(frames) if frames else EMPTY

    def hotspots(self, end: datetime) -> pl.DataFrame:
        return hotspots_from_hours(pl.concat([self.settled, *self.pixels.values()]), end, self.rule)


def _since(t: datetime) -> str:
    return f"event_time >= '{t.isoformat()}'"


def _hour(value: object) -> datetime:
    assert isinstance(value, datetime)
    return value


class Frontiers:
    """End of the newest product file per source in bronze, from the files added since."""

    def __init__(self) -> None:
        self.increments = Increments()
        self.ends: dict[str, datetime] = {}

    def refresh(self, table: Table, now: datetime) -> dict[str, datetime]:
        listing = f"product_start >= '{(now - 3 * HOUR).isoformat()}'"
        added, _, _ = self.increments.poll(table, listing, now)
        fields = ("source", "product_end", "status")
        frames = read_files(table, added, fields, "status = 'ok'", newest)
        for _, ends in frames:
            for source, end in ends.items():
                self.ends[source] = max(self.ends.get(source, end), end)
        return dict(self.ends)


@dataclass
class Inputs:
    flashes: pl.DataFrame
    observed: dict[str, datetime]
    silver: int
    spool: int
    files_read: int


class Lake:
    """Reads silver, bronze, the spool and the catalog's tables, and never writes to them."""

    def __init__(
        self,
        catalog: Callable[[], Catalog],
        feed: ObjectStore,
        spool: Path | None,
        rule: HotspotRule,
    ) -> None:
        self.catalog = catalog
        self.feed = feed
        self.spool = spool
        self.silver = SilverCache(rule)
        self.bronze = Frontiers()
        self.tracks_snapshot: int | None = None
        self.tracked: datetime | None = None

    def tracked_until(self, now: datetime) -> datetime | None:
        """End of the catalog's last tracked hour, read again when its tracks change."""
        table = self.catalog().load_table(STORM_TRACKS.identifier)
        snapshot = table.current_snapshot()
        snapshot_id = None if snapshot is None else snapshot.snapshot_id
        if snapshot_id == self.tracks_snapshot:
            return self.tracked
        since = None if self.tracked is None else self.tracked - HOUR
        for lo in (since, now - timedelta(days=2), now - timedelta(days=60)):
            if lo is None:
                continue
            scan = table.scan(
                row_filter=f"window_start >= '{lo.isoformat()}'", selected_fields=("window_start",)
            )
            found = _frame(scan.to_arrow())["window_start"].max()
            if isinstance(found, datetime):
                self.tracks_snapshot, self.tracked = snapshot_id, found + HOUR
                return self.tracked
        self.tracks_snapshot = snapshot_id
        return self.tracked

    def catalog_state(self, tracked_until: datetime | None) -> CatalogState:
        if tracked_until is None:
            return CatalogState(None)
        catalog = self.catalog()
        tracks = _frame(
            catalog.load_table(STORM_TRACKS.identifier)
            .scan(row_filter=_between("window_start", tracked_until - HOUR, tracked_until))
            .to_arrow()
        )
        tracks = tracks.select(TRACK_SCHEMA.names()).cast(TRACK_SCHEMA)
        if tracks.is_empty():
            return CatalogState(tracked_until, tracks)
        since = tracks["storm_start"].min()
        assert isinstance(since, datetime)
        ids = tracks.select(pl.col("storm_id").unique())
        after = f"storm_start >= '{since.isoformat()}'"

        def read(table: Any, fields: tuple[str, ...]) -> pl.DataFrame:
            scan = catalog.load_table(table.identifier).scan(
                row_filter=after, selected_fields=("storm_id", *fields)
            )
            return ids.join(_frame(scan.to_arrow()), on="storm_id")

        storms = read(STORMS, ("t_start", "split_from"))
        levels = read(STORM_LEVELS, ("level_source", "flashes", "peak_rate", "level"))
        names = read(STORM_NAMES, ("slug", "name"))
        published = published_slugs(ObjectCatalogStore(self.feed))
        names = names.with_columns(
            slug=pl.when(pl.col("slug").is_in(list(published))).then(pl.col("slug"))
        )
        info = (
            ids.join(storms, on="storm_id", how="left")
            .join(levels, on="storm_id", how="left")
            .join(names, on="storm_id", how="left")
        )
        return CatalogState(tracked_until, tracks, info.select(STORM_INFO.names()).cast(STORM_INFO))

    def inputs(self, since: datetime, now: datetime) -> Inputs:
        """Spool first, then bronze, then silver: whatever left the spool is in silver."""
        spool = EMPTY
        spooled: dict[str, datetime] = {}
        if self.spool is not None:
            try:
                spool, spooled = read_spool(self.spool, since)
            except Exception:
                log.exception("spool unreadable; silver only")
        catalog = self.catalog()
        observed = self.bronze.refresh(catalog.load_table(INGEST_LOG.identifier), now)
        self.silver.refresh(catalog.load_table(FLASHES.identifier), now)
        silver = self.silver.window(since)
        for source, end in spooled.items():
            observed[source] = max(observed.get(source, end), end)
        flashes = silver
        if spool.height:
            flashes = pl.concat([silver, spool.filter(pl.col("event_time") >= since)])
            flashes = flashes.unique("flash_id", keep="first", maintain_order=True)
        return Inputs(
            flashes, observed, silver.height, flashes.height - silver.height, self.silver.files_read
        )

    def hotspots(self, end: datetime) -> pl.DataFrame:
        return self.silver.hotspots(end)

    def previous(self) -> ActiveStorms | None:
        """The last snapshot written, read back after a restart."""
        try:
            value = json.loads(obstore.get(self.feed, ACTIVE_PATH).bytes().to_bytes())
            if str(value.get("schema_version", "")).split(".")[0] != SCHEMA_VERSION.split(".")[0]:
                return None
            return ActiveStorms.model_validate(value | {"schema_version": SCHEMA_VERSION})
        except FileNotFoundError:
            return None
        except ValueError:
            log.exception("previous snapshot unreadable; starting afresh")
            return None

    def write(self, body: bytes) -> None:
        obstore.put(self.feed, ACTIVE_PATH, body, attributes=HEADERS)
