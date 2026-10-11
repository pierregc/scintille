import asyncio
import hashlib
import json
import os
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import polars as pl
import pytest
from scintille_contract.models import OpsMetrics, QualityStatus
from scintille_ingest.glm.parse import FLASH_SCHEMA
from scintille_ingest.runtime.live_feed import LiveFeed, parse_manifest
from scintille_ingest.runtime.ops import (
    GOLD_STATUS,
    QUALITY_STATUS,
    FileStats,
    LiveStats,
    OpsPublisher,
    build,
    completeness,
    error_budget,
    quality_status,
)
from scintille_ingest.runtime.spool import Spool

T0 = datetime(2026, 7, 15, 18, 0, tzinfo=UTC)


class MemoryStore:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    async def put(self, path: str, data: bytes, headers: dict[str, str]) -> None:
        self.objects[path] = data

    async def get(self, path: str) -> bytes | None:
        return self.objects.get(path)

    async def delete(self, path: str) -> None:
        self.objects.pop(path, None)


class MemoryOps:
    def __init__(self, files: dict[str, FileStats] | None = None) -> None:
        self.files = files or {}
        self.operations: dict[str, int] = {}
        self.statuses: dict[str, tuple[datetime, dict[str, Any]]] = {}

    def file_stats(self, now: datetime) -> dict[str, FileStats]:
        return self.files

    def add_catalog_operations(self, month: str, count: int) -> None:
        self.operations[month] = self.operations.get(month, 0) + count

    def catalog_operations(self, month: str) -> int:
        return self.operations.get(month, 0)

    def put_status(self, name: str, value: Mapping[str, Any], at: datetime) -> None:
        self.statuses[name] = (at, dict(value))

    def status(self, name: str) -> tuple[datetime, dict[str, Any]] | None:
        return self.statuses.get(name)


class Clock:
    def __init__(self) -> None:
        self.now = T0

    def __call__(self) -> datetime:
        return self.now


def flashes(source: str, ingest: datetime, n: int, latency: float = 40.0) -> pl.DataFrame:
    rows: list[dict[str, object]] = [
        {
            "flash_id": hashlib.sha256(f"{source}{ingest}{i}".encode()).hexdigest()[:32],
            "source": source,
            "product_file": "f.nc",
            "native_flash_id": i,
            "event_time": ingest - timedelta(seconds=latency),
            "ingest_time": ingest,
            "lat": 10.0,
            "lon": -60.0,
            "energy_raw": 2e-14,
            "energy_unit": "J",
            "intensity": None,
            "area_km2": 150.0,
            "duration_ms": 250.0,
            "quality": [],
        }
        for i in range(n)
    ]
    return pl.DataFrame(rows, schema=FLASH_SCHEMA)


def test_live_stats_count_per_ingest_minute_and_measure_latency() -> None:
    stats = LiveStats(T0)
    stats.record(flashes("glm-east", T0 + timedelta(seconds=10), 3, latency=20), T0)
    stats.record(flashes("glm-east", T0 + timedelta(minutes=2), 5, latency=60), T0)
    now = T0 + timedelta(minutes=2, seconds=30)
    start, series = stats.series("glm-east", now)
    assert start == T0 and series == [3, 0, 5]
    p50, p95 = stats.latency("glm-east", T0 + timedelta(minutes=3))
    assert p50 is not None and p95 is not None and p50 < p95
    assert stats.latency("glm-west", now) == (None, None)


def test_live_stats_keep_one_hour() -> None:
    stats = LiveStats(T0)
    stats.record(flashes("glm-east", T0, 2), T0)
    later = T0 + timedelta(hours=2)
    stats.record(flashes("glm-east", later, 1), later)
    start, series = stats.series("glm-east", later)
    assert start == later - timedelta(minutes=59) and len(series) == 60
    assert sum(series) == 1


def test_completeness_and_error_budget() -> None:
    full = FileStats(180, T0, 180 * 24, T0 - timedelta(days=1))
    assert completeness(full, "glm-east") == 1.0
    assert error_budget(full, "glm-east", T0) == 1.0
    short = FileStats(90, T0, 180 * 24 - 20, T0 - timedelta(days=1))
    assert completeness(short, "glm-east") == 0.5
    # 43.2 files may be missed in a day; 20 are.
    assert error_budget(short, "glm-east", T0) == pytest.approx(1 - 20 / 43.2, abs=1e-4)
    assert completeness(None, "mtg-li") is None and error_budget(None, "mtg-li", T0) is None
    outage_aged = FileStats(180, T0, 29 * 24 * 180, T0 - timedelta(days=60))
    assert error_budget(outage_aged, "glm-east", T0) == pytest.approx(1 - 24 * 180 / 1296, abs=1e-4)


def test_quality_status_reads_the_dagster_summary() -> None:
    assert quality_status(None).status == "unknown"
    value = {"status": "fail", "checked_at": T0.isoformat(), "failed": ["silver_completeness"]}
    status = quality_status((T0, value))
    assert status.status == "fail" and status.checked_at == T0
    assert status.failed == ["silver_completeness"]


def test_build_reports_freshness_per_layer() -> None:
    now = T0 + timedelta(minutes=10)
    metrics = build(
        now,
        LiveStats(T0),
        {"glm-east": FileStats(178, now, 1000, T0)},
        manifest_at=now - timedelta(seconds=20),
        oldest_spooled=now - timedelta(minutes=4),
        gold_built=None,
        quality=QualityStatus(status="pass", checked_at=T0, failed=[]),
        catalog_operations=1234,
    )
    assert metrics.freshness.live_feed_age_seconds == 20
    assert metrics.freshness.silver_lag_seconds == 240
    assert metrics.freshness.gold_age_seconds is None
    assert [s.source for s in metrics.sources] == ["glm-east", "glm-west", "mtg-li"]
    assert metrics.sources[0].completeness == pytest.approx(178 / 180, abs=1e-4)
    assert metrics.sources[1].last_file_time is None
    assert metrics.catalog.month == "2026-07" and metrics.catalog.free_tier == 1_000_000


def test_stopped_lake_writer_raises_silver_lag_but_not_live_feed_age(tmp_path: Path) -> None:
    store, clock, ops = MemoryStore(), Clock(), MemoryOps()
    feed = LiveFeed(store, outbox=tmp_path / "outbox", clock=clock)
    spool = Spool(tmp_path / "spool")
    publisher = OpsPublisher(store, feed, spool, ops, clock=clock)
    ops.put_status(GOLD_STATUS, {}, T0 - timedelta(hours=3))
    ops.put_status(QUALITY_STATUS, {"status": "pass", "checked_at": T0.isoformat()}, T0)

    async def minute(spooled: bool) -> OpsMetrics:
        for _ in range(2):
            await feed.publish("glm-east", flashes("glm-east", clock.now, 4))
            if spooled:
                batch = clock.now.strftime("%H%M%S")
                path = spool.write(batch, pl.DataFrame({"x": [1]}), pl.DataFrame({"x": [1]}))
                os.utime(path, (clock.now.timestamp(), clock.now.timestamp()))
            clock.now += timedelta(seconds=30)
            await feed.flush()
        return await publisher.publish()

    async def scenario() -> list[OpsMetrics]:
        drained = await minute(spooled=False)
        stopped = [await minute(spooled=True) for _ in range(20)]
        return [drained, *stopped]

    runs = asyncio.run(scenario())
    assert runs[0].freshness.silver_lag_seconds == 0
    assert runs[-1].freshness.silver_lag_seconds == pytest.approx(20 * 60, abs=60)
    assert all(r.freshness.live_feed_age_seconds == 0 for r in runs)
    assert runs[-1].freshness.gold_age_seconds == pytest.approx(3 * 3600 + 21 * 60)
    written = OpsMetrics.model_validate_json(store.objects["metrics.json"])
    assert written == runs[-1]
    assert sum(written.sources[0].flashes_per_minute) == 4 * 2 * 21


def test_an_older_minor_manifest_is_restored() -> None:
    manifest = {
        "schema_version": "2.0.0",
        "generated_at": "2026-07-15T18:00:00Z",
        "chunk_seconds": 30,
        "window_seconds": 3600,
        "chunks": [],
        "sources": [],
    }
    assert parse_manifest(json.dumps(manifest).encode()).chunks == []
    manifest["schema_version"] = "1.0.0"
    with pytest.raises(ValueError):
        parse_manifest(json.dumps(manifest).encode())
