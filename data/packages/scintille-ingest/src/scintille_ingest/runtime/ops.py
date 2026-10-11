"""Operational metrics: `live/metrics.json`, built every minute by `ingest-live` (#38)."""

import asyncio
import contextlib
import logging
from collections import defaultdict, deque
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

import numpy as np
import polars as pl
import psycopg
from psycopg.types.json import Jsonb
from scintille_contract.models import (
    SCHEMA_VERSION,
    SOURCE_VALUES,
    CatalogUsage,
    CheckStatus,
    LayerFreshness,
    OpsMetrics,
    QualityStatus,
    SourceMetrics,
)

from .metrics import Metrics
from .spool import Spool

log = logging.getLogger("scintille_ingest.ops")

METRICS_HEADERS = {"Content-Type": "application/json", "Cache-Control": "public, max-age=30"}
WINDOW = timedelta(hours=1)
BUDGET_WINDOW = timedelta(days=30)
COMPLETENESS_TARGET = 0.99
# Product files per hour: GLM writes one every 20 s, MTG LI one every 30 s.
EXPECTED_FILES_PER_HOUR = {"glm-east": 180, "glm-west": 180, "mtg-li": 120}
CATALOG_FREE_TIER = 1_000_000
QUALITY_STATUS = "quality"
GOLD_STATUS = "gold"


def minute(t: datetime) -> datetime:
    return t.replace(second=0, microsecond=0)


class LiveStats:
    """Per source over the last hour: flashes per ingest minute and publication latencies."""

    def __init__(self, started: datetime) -> None:
        self.started = minute(started)
        self.counts: defaultdict[str, defaultdict[datetime, int]] = defaultdict(
            lambda: defaultdict(int)
        )
        self.latencies: defaultdict[str, deque[tuple[datetime, np.ndarray]]] = defaultdict(deque)

    def record(self, flashes: pl.DataFrame, published: datetime) -> None:
        per_minute = flashes.group_by(
            pl.col("source").cast(pl.String), pl.col("ingest_time").dt.truncate("1m")
        ).len()
        for source, at, n in per_minute.iter_rows():
            self.counts[source][at] += n
        for (source,), group in flashes.group_by(pl.col("source").cast(pl.String)):
            lags = (published - group["event_time"]).dt.total_microseconds().to_numpy() / 1e6
            self.latencies[str(source)].append((published, lags))
        self._prune(published)

    def _prune(self, now: datetime) -> None:
        horizon = now - WINDOW
        for counts in self.counts.values():
            for at in [t for t in counts if t <= minute(horizon)]:
                del counts[at]
        for samples in self.latencies.values():
            while samples and samples[0][0] <= horizon:
                samples.popleft()

    def series(self, source: str, now: datetime) -> tuple[datetime, list[int]]:
        start = max(self.started, minute(now) - timedelta(minutes=59))
        steps = int((minute(now) - start).total_seconds() // 60) + 1
        counts: Mapping[datetime, int] = self.counts.get(source, {})
        return start, [counts.get(start + timedelta(minutes=i), 0) for i in range(steps)]

    def latency(self, source: str, now: datetime) -> tuple[float | None, float | None]:
        horizon = now - WINDOW
        recent = [lags for at, lags in self.latencies.get(source, ()) if at > horizon]
        if not recent or not sum(len(r) for r in recent):
            return None, None
        p50, p95 = np.percentile(np.concatenate(recent), [50, 95])
        return round(float(p50), 1), round(float(p95), 1)


@dataclass(frozen=True)
class FileStats:
    files_last_hour: int
    last_file_time: datetime | None
    files_in_budget_window: int
    monitoring_start: datetime | None


class OpsStore(Protocol):
    def file_stats(self, now: datetime) -> dict[str, FileStats]: ...

    def add_catalog_operations(self, month: str, count: int) -> None: ...

    def catalog_operations(self, month: str) -> int: ...

    def put_status(self, name: str, value: Mapping[str, Any], at: datetime) -> None: ...

    def status(self, name: str) -> tuple[datetime, dict[str, Any]] | None: ...


SCHEMA = """
CREATE TABLE IF NOT EXISTS ops_catalog_operations (
    month text PRIMARY KEY,
    operations bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS ops_status (
    name text PRIMARY KEY,
    at timestamptz NOT NULL,
    value jsonb NOT NULL
);
"""

# One row per spooled file key, from ingest-live's `ingest_files` table.
FILE_STATS = """
WITH files AS (
    SELECT source, key, min(updated_at) AS at, max(updated_at) AS last
    FROM ingest_files
    WHERE state = 'spooled'
    GROUP BY source, key
)
SELECT source,
    count(*) FILTER (WHERE at > %(hour_start)s),
    max(last),
    count(*) FILTER (WHERE at > %(budget_start)s),
    min(at)
FROM files
GROUP BY source
"""


class PostgresOps:
    """Operational state shared by ingest-live, lake-writer and Dagster."""

    def __init__(self, dsn: str) -> None:
        self._conn = psycopg.connect(dsn, autocommit=True)
        self._conn.execute(SCHEMA)

    def file_stats(self, now: datetime) -> dict[str, FileStats]:
        rows = self._conn.execute(
            FILE_STATS, {"budget_start": now - BUDGET_WINDOW, "hour_start": now - WINDOW}
        ).fetchall()
        return {row[0]: FileStats(row[1], row[2], row[3], row[4]) for row in rows}

    def add_catalog_operations(self, month: str, count: int) -> None:
        self._conn.execute(
            "INSERT INTO ops_catalog_operations (month, operations) VALUES (%s, %s)"
            " ON CONFLICT (month) DO UPDATE"
            " SET operations = ops_catalog_operations.operations + EXCLUDED.operations",
            [month, count],
        )

    def catalog_operations(self, month: str) -> int:
        row = self._conn.execute(
            "SELECT operations FROM ops_catalog_operations WHERE month = %s", [month]
        ).fetchone()
        return int(row[0]) if row else 0

    def put_status(self, name: str, value: Mapping[str, Any], at: datetime) -> None:
        self._conn.execute(
            "INSERT INTO ops_status (name, at, value) VALUES (%s, %s, %s)"
            " ON CONFLICT (name) DO UPDATE SET at = EXCLUDED.at, value = EXCLUDED.value",
            [name, at, Jsonb(dict(value))],
        )

    def status(self, name: str) -> tuple[datetime, dict[str, Any]] | None:
        row = self._conn.execute(
            "SELECT at, value FROM ops_status WHERE name = %s", [name]
        ).fetchone()
        return (row[0], row[1]) if row else None

    def close(self) -> None:
        self._conn.close()


def completeness(stats: FileStats | None, source: str) -> float | None:
    """None for a source with no file in 30 days: not ingested, rather than incomplete."""
    expected = EXPECTED_FILES_PER_HOUR.get(source)
    if expected is None or stats is None:
        return None
    return min(1.0, round(stats.files_last_hour / expected, 4))


def error_budget(stats: FileStats | None, source: str, now: datetime) -> float | None:
    """Missing files over the files the 30-day target allows to miss, since monitoring started."""
    per_hour = EXPECTED_FILES_PER_HOUR.get(source)
    if per_hour is None or stats is None or stats.monitoring_start is None:
        return None
    start = max(stats.monitoring_start, now - BUDGET_WINDOW)
    hours = (now - start).total_seconds() / 3600
    expected = per_hour * hours
    allowed = expected * (1 - COMPLETENESS_TARGET)
    if allowed <= 0:
        return 1.0
    missing = max(0.0, expected - stats.files_in_budget_window)
    return round(1 - missing / allowed, 4)


def quality_status(status: tuple[datetime, dict[str, Any]] | None) -> QualityStatus:
    if status is None:
        return QualityStatus(status="unknown", checked_at=None, failed=[])
    _, value = status
    state: CheckStatus = value.get("status", "unknown")
    checked = value.get("checked_at")
    return QualityStatus(
        status=state,
        checked_at=datetime.fromisoformat(checked) if checked else None,
        failed=list(value.get("failed", [])),
    )


def age(now: datetime, then: datetime | None) -> float | None:
    return None if then is None else round(max(0.0, (now - then).total_seconds()), 1)


def build(
    now: datetime,
    stats: LiveStats,
    files: Mapping[str, FileStats],
    *,
    manifest_at: datetime | None,
    oldest_spooled: datetime | None,
    gold_built: datetime | None,
    quality: QualityStatus,
    catalog_operations: int,
) -> OpsMetrics:
    sources = []
    for source in SOURCE_VALUES:
        start, series = stats.series(source, now)
        p50, p95 = stats.latency(source, now)
        file = files.get(source)
        sources.append(
            SourceMetrics(
                source=source,
                series_start=start,
                flashes_per_minute=series,
                latency_p50_seconds=p50,
                latency_p95_seconds=p95,
                completeness=completeness(file, source),
                last_file_time=file.last_file_time if file else None,
                error_budget_remaining=error_budget(file, source, now),
            )
        )
    return OpsMetrics(
        schema_version=SCHEMA_VERSION,
        generated_at=now,
        freshness=LayerFreshness(
            live_feed_age_seconds=age(now, manifest_at),
            silver_lag_seconds=age(now, oldest_spooled) if oldest_spooled else 0.0,
            gold_age_seconds=age(now, gold_built),
        ),
        sources=sources,
        quality=quality,
        catalog=CatalogUsage(
            month=f"{now:%Y-%m}", operations=catalog_operations, free_tier=CATALOG_FREE_TIER
        ),
    )


class MetricsStore(Protocol):
    async def put(self, path: str, data: bytes, headers: dict[str, str]) -> None: ...


class LiveFeedView(Protocol):
    stats: LiveStats
    manifest_at: datetime | None


class OpsPublisher:
    """Writes `metrics.json` next to the live manifest every `every` seconds."""

    def __init__(
        self,
        store: MetricsStore,
        feed: LiveFeedView,
        spool: Spool,
        ops: OpsStore,
        *,
        every: float = 60.0,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        metrics: Metrics | None = None,
    ) -> None:
        self.store = store
        self.feed = feed
        self.spool = spool
        self.ops = ops
        self.every = every
        self._clock = clock
        self.metrics = metrics or Metrics()
        self._stop = asyncio.Event()

    def snapshot(self) -> OpsMetrics:
        now = self._clock()
        gold = self.ops.status(GOLD_STATUS)
        return build(
            now,
            self.feed.stats,
            self.ops.file_stats(now),
            manifest_at=self.feed.manifest_at,
            oldest_spooled=self.spool.oldest_pending_time(),
            gold_built=gold[0] if gold else None,
            quality=quality_status(self.ops.status(QUALITY_STATUS)),
            catalog_operations=self.ops.catalog_operations(f"{now:%Y-%m}"),
        )

    async def publish(self) -> OpsMetrics:
        snapshot = self.snapshot()
        await self.store.put("metrics.json", snapshot.model_dump_json().encode(), METRICS_HEADERS)
        lag = snapshot.freshness.silver_lag_seconds
        if lag is not None:
            self.metrics.set("silver_lag_seconds", lag)
        return snapshot

    async def run(self) -> None:
        while not self._stop.is_set():
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=self.every)
            try:
                await self.publish()
            except Exception:
                self.metrics.inc("ops_metrics_errors_total")
                log.exception("metrics.json write failed; retrying next minute")

    def stop(self) -> None:
        self._stop.set()
