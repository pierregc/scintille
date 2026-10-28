"""Rebuild a whole `silver.flashes` partition (one day, one source) from every upstream file."""

import logging
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from contextlib import AbstractContextManager, nullcontext
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime, timedelta

import polars as pl
from pyiceberg.catalog import Catalog
from pyiceberg.expressions import And, EqualTo, In, Reference
from pyiceberg.expressions.literals import literal
from scintille_lake.locks import partition_key
from scintille_lake.tables import FLASHES, FLASHES_QUARANTINE, INGEST_LOG

from scintille_ingest.glm.ingest import IngestedFile
from scintille_ingest.intensity import CURRENT
from scintille_ingest.runtime.lake_commit import QUARANTINE_COLUMNS, to_ingest_log, to_silver
from scintille_ingest.runtime.ops import EXPECTED_FILES_PER_HOUR
from scintille_ingest.runtime.sources import Product
from scintille_ingest.validate import quarantine_rows, validate

log = logging.getLogger("scintille_ingest.backfill")

EXPECTED_FILES_PER_DAY = {source: 24 * n for source, n in EXPECTED_FILES_PER_HOUR.items()}
MIN_COMPLETENESS = 0.99
# Files that start before midnight can hold flashes of the next day, and the other way round.
EDGE = timedelta(minutes=2)
# The hot path may still be writing a day this long after it ends.
LIVE_MARGIN = timedelta(hours=1)

Lister = Callable[[datetime], list[Product]]
Fetcher = Callable[[Product], bytes]
Parser = Callable[[Product, bytes, datetime], IngestedFile]
Locker = Callable[[Iterable[str]], AbstractContextManager[object]]


def no_lock(keys: Iterable[str]) -> AbstractContextManager[object]:
    return nullcontext()


class IncompletePartition(Exception):
    """Not enough upstream files parsed: the existing partition is left as it is."""


class DayNotClosed(Exception):
    """The hot path may still be writing this day: its files are not all upstream yet."""


def _name(key: str) -> str:
    return key.rsplit("/", 1)[-1]


@dataclass(frozen=True)
class BackfillResult:
    day: date
    source: str
    files: int
    expected: int
    flashes: int
    quarantined: int


def backfill_partition(
    day: date,
    source: str,
    *,
    list_hour: Lister,
    fetch: Fetcher,
    parse: Parser,
    catalog: Catalog,
    parser_version: str,
    calibration_version: str = CURRENT.version,
    locker: Locker = no_lock,
    workers: int = 8,
    min_completeness: float = MIN_COMPLETENESS,
    expected_files: int | None = None,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> BackfillResult:
    """Downloads and parses every file of `day`, then replaces the partition.

    Nothing is written unless the day is closed and at least `min_completeness` of the expected
    files parsed. lake-writer replaces rows by product file, so a live batch drained after the
    rebuild replaces that file's rows instead of duplicating them.
    """
    start = datetime(day.year, day.month, day.day, tzinfo=UTC)
    end = start + timedelta(days=1)
    received = now()
    if received < end + LIVE_MARGIN:
        raise DayNotClosed(f"{source} {day}: the day is not closed yet")
    hours = [start - timedelta(hours=1)] + [start + timedelta(hours=h) for h in range(25)]
    # One product per start time; a reprocessed file replaces the original (later name wins).
    latest: dict[datetime, Product] = {}
    for p in (p for h in hours for p in list_hour(h)):
        if p.start not in latest or p.key > latest[p.start].key:
            latest[p.start] = p
    edge = sorted(
        (p for p in latest.values() if start - EDGE <= p.start < end + EDGE),
        key=lambda p: (p.start, p.key),
    )
    own = [p for p in edge if start <= p.start < end]
    expected = expected_files or EXPECTED_FILES_PER_DAY[source]
    if len(own) < min_completeness * expected:
        raise IncompletePartition(f"{source} {day}: {len(own)} of {expected} files")

    # Downloads run in parallel; parsing stays on one thread because HDF5 is not thread-safe.
    with ThreadPoolExecutor(workers) as pool:
        parsed = [
            parse(product, data, received)
            for product, data in zip(edge, pool.map(fetch, edge), strict=True)
        ]

    valid: list[pl.DataFrame] = []
    rejected: list[pl.DataFrame] = []
    logs: list[pl.DataFrame] = []
    for product, file in zip(edge, parsed, strict=True):
        good, bad = validate(file.flashes, (file.log.product_start, file.log.product_end))
        valid.append(good)
        if start <= product.start < end:
            logs.append(pl.DataFrame([asdict(file.log)]))
            if bad.height:
                rejected.append(quarantine_rows(bad, parser_version, calibration_version))
    readable = sum(
        f.log.status == "ok" for p, f in zip(edge, parsed, strict=True) if start <= p.start < end
    )
    if readable < min_completeness * expected:
        raise IncompletePartition(f"{source} {day}: {readable} of {expected} files readable")
    flashes = (
        pl.concat(valid, how="vertical_relaxed")
        .filter(pl.col("event_time").is_between(start, end, closed="left"))
        .unique("flash_id", keep="first", maintain_order=True)
        .with_columns(
            pl.lit(parser_version).alias("parser_version"),
            pl.lit(calibration_version).alias("calibration_version"),
        )
    )
    if not flashes.height:
        raise IncompletePartition(f"{source} {day}: no flashes parsed")
    own_files = [_name(p.key) for p in own]
    quarantined = (
        pl.concat(rejected).select(QUARANTINE_COLUMNS)
        if rejected
        else pl.DataFrame(schema={c: pl.Null for c in QUARANTINE_COLUMNS})
    )

    span = f"'{start.isoformat()}' AND {{}} < '{end.isoformat()}'"
    bronze_filter = f"product_start >= {span.format('product_start')} AND source == '{source}'"
    with locker([partition_key("silver.flashes", day, source)]):
        silver = catalog.load_table(FLASHES.identifier)
        bronze = catalog.load_table(INGEST_LOG.identifier)
        quarantine = catalog.load_table(FLASHES_QUARANTINE.identifier)
        silver.overwrite(
            to_silver(flashes).to_arrow().cast(silver.schema().as_arrow()),
            overwrite_filter=f"event_time >= {span.format('event_time')} AND source == '{source}'",
            snapshot_properties={"scintille.backfill": f"{source}/{day.isoformat()}"},
        )
        bronze.overwrite(
            to_ingest_log(pl.concat(logs).unique("key", keep="first", maintain_order=True))
            .to_arrow()
            .cast(bronze.schema().as_arrow()),
            overwrite_filter=bronze_filter,
        )
        quarantine.overwrite(
            quarantined.to_arrow().cast(quarantine.schema().as_arrow()),
            overwrite_filter=And(
                EqualTo(term=Reference("source"), value=literal(source)),
                In(term=Reference("product_file"), values={literal(n) for n in own_files}),
            ),
        )
    result = BackfillResult(day, source, len(own), expected, flashes.height, quarantined.height)
    log.info("partition rebuilt", extra={"fields": asdict(result)})
    return result
