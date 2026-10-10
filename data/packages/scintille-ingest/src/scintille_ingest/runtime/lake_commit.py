"""lake-writer's commit: spooled batches into silver and bronze, at most once each."""

import logging
import warnings
from collections.abc import Callable, Iterable, Iterator
from contextlib import AbstractContextManager, nullcontext
from dataclasses import dataclass, field

import polars as pl
import pyarrow as pa
from pyiceberg.catalog import Catalog
from pyiceberg.expressions import In, Reference
from pyiceberg.expressions.literals import literal
from pyiceberg.table import Table
from scintille_lake.locks import partition_key
from scintille_lake.tables import FLASHES, FLASHES_QUARANTINE, INGEST_LOG

from .metrics import Metrics
from .spool import Spool

log = logging.getLogger("scintille_ingest.lake_writer")

BATCHES_PROPERTY = "scintille.batch_ids"
SILVER_COLUMNS = [f.name for f in FLASHES.schema.fields]
LOG_COLUMNS = [f.name for f in INGEST_LOG.schema.fields]
QUARANTINE_COLUMNS = [f.name for f in FLASHES_QUARANTINE.schema.fields]

Locker = Callable[[Iterable[str]], AbstractContextManager[object]]


def no_lock(keys: Iterable[str]) -> AbstractContextManager[object]:
    return nullcontext()


def committed_batches(table: Table) -> set[str]:
    """Batch ids recorded in the snapshots still in the table metadata."""
    ids: set[str] = set()
    for snapshot in table.metadata.snapshots:
        value = (
            snapshot.summary.additional_properties.get(BATCHES_PROPERTY)
            if snapshot.summary
            else None
        )
        if value:
            ids.update(value.split(","))
    return ids


def to_silver(flashes: pl.DataFrame) -> pl.DataFrame:
    frame = flashes.with_columns(
        pl.col("source").cast(pl.String),
        pl.col("energy_unit").cast(pl.String),
        pl.col("quality").cast(pl.List(pl.String)),
        pl.col("intensity").cast(pl.Float32),
        pl.col("area_km2").cast(pl.Float32),
        pl.col("duration_ms").cast(pl.Float32),
    )
    return frame.select(SILVER_COLUMNS)


def to_ingest_log(rows: pl.DataFrame) -> pl.DataFrame:
    return rows.with_columns(pl.col("source").cast(pl.String)).select(LOG_COLUMNS)


@dataclass
class LakeCommit:
    """Commits spooled batches; meant as `LakeWriter(commit=LakeCommit(...))`."""

    catalog: Callable[[], Catalog]
    locker: Locker = no_lock
    metrics: Metrics = field(default_factory=Metrics)
    max_batches: int = 200
    after_commit: Callable[[str], None] = lambda table: None

    def __call__(self, spool: Spool, batches: list[str]) -> None:
        for group in chunks(batches, self.max_batches):
            self.commit(spool, group)

    def commit(self, spool: Spool, batches: list[str]) -> None:
        catalog = self.catalog()
        self.metrics.inc("catalog_operations_total", 1, op="load")
        silver = catalog.load_table(FLASHES.identifier)
        bronze = catalog.load_table(INGEST_LOG.identifier)
        quarantine = catalog.load_table(FLASHES_QUARANTINE.identifier)
        flashes = {b: spool.read(b) for b in batches}
        logs = {b: spool.read_log(b) for b in batches}
        rejected = {b: spool.read_quarantine(b) for b in batches}
        locks = {
            partition_key("silver.flashes", day, source)
            for frame in flashes.values()
            if frame.height
            for day, source in frame.select(
                pl.col("event_time").dt.date().alias("day"), pl.col("source").cast(pl.String)
            )
            .unique()
            .iter_rows()
        }
        files = {b: logs[b]["key"].to_list() for b in batches}
        with self.locker(locks):
            silver_frames = {b: to_silver(f) for b, f in flashes.items()}
            names = {b: [k.rsplit("/", 1)[-1] for k in keys] for b, keys in files.items()}
            self._replace(silver, "product_file", names, silver_frames)
            self.after_commit("silver")
            log_frames = {b: to_ingest_log(f) for b, f in logs.items()}
            self._replace(bronze, "key", files, log_frames)
            self.after_commit("bronze")
            empty = pl.DataFrame(schema={c: pl.Null for c in QUARANTINE_COLUMNS})
            quarantined = {
                b: empty if f is None else f.select(QUARANTINE_COLUMNS) for b, f in rejected.items()
            }
            self._replace(quarantine, "product_file", names, quarantined)
            self.after_commit("quarantine")
        for batch in batches:
            spool.delete(batch)
        rows = sum(f.height for f in flashes.values())
        self.metrics.inc("lake_batches_committed_total", len(batches))
        self.metrics.inc("lake_rows_committed_total", rows)
        log.info("batches committed", extra={"fields": {"batches": len(batches), "rows": rows}})

    def _replace(
        self,
        table: Table,
        column: str,
        files: dict[str, list[str]],
        frames: dict[str, pl.DataFrame],
    ) -> None:
        """Writes the batches this table does not hold yet, in one commit recording their ids.

        Rows of an earlier revision of the same product file (`column`) are replaced; within the
        commit the latest batch of a file wins.
        """
        done = committed_batches(table)
        todo = [b for b in files if b not in done]
        if not todo:
            return
        latest = {name: b for b in todo for name in files[b]}
        schema = table.schema().as_arrow()
        parts = [
            frames[b].filter(pl.col(column).is_in([n for n, w in latest.items() if w == b]))
            for b in todo
        ]
        data = pa.concat_tables(
            [p.to_arrow().cast(schema) for p in parts if p.height] or [schema.empty_table()]
        )
        properties = {BATCHES_PROPERTY: ",".join(todo)}
        if latest:
            with warnings.catch_warnings():
                warnings.filterwarnings("ignore", "Delete operation did not match any records")
                replaced = In(term=Reference(column), values={literal(n) for n in latest})
                table.overwrite(data, replaced, snapshot_properties=properties)
        else:
            table.append(data, snapshot_properties=properties)
        self.metrics.inc("catalog_operations_total", 1, op="append")


def chunks(items: list[str], size: int) -> Iterator[list[str]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]
