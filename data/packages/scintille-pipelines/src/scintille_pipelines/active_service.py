"""`active-storms`: rewrites storms/active.json every 5 minutes from silver (ADR 0021)."""

import argparse
import asyncio
import contextlib
import gzip
import json
import logging
import os
import signal
import time
from collections.abc import Callable, Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from scintille_contract import active
from scintille_contract.models import ActiveStorms
from scintille_ingest.cli import live_store
from scintille_ingest.runtime import health
from scintille_ingest.runtime.heartbeat import Pinger, heartbeat_from_env
from scintille_ingest.runtime.logs import configure as configure_json_logs
from scintille_ingest.runtime.metrics import Metrics
from scintille_lake.config import LakeConfig
from scintille_lake.connect import pyiceberg_catalog

from .active_lake import NO_HOTSPOTS, Inputs, Lake
from .active_storms import UPDATE_SECONDS, ActiveFeed, CatalogState, Update, floor_hour
from .storm_cells import StormCellsConfig
from .tracking import HOUR

STALE_AFTER = timedelta(seconds=900)
CATALOG_LATE = timedelta(hours=3)
# The catalog writes names and levels a few minutes after its tracks.
CATALOG_SETTLE = timedelta(minutes=10)
MAX_RAW_BYTES = 1024 * 1024
MAX_GZIP_BYTES = 256 * 1024
log = logging.getLogger("scintille_pipelines.active_storms")


class ActiveService:
    """One update at a time, never queued; hot spots rescanned once per hour."""

    def __init__(
        self,
        lake: Lake,
        *,
        metrics: Metrics | None = None,
        heartbeat: Pinger | None = None,
        catalog_heartbeat: Pinger | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        write: bool = True,
    ) -> None:
        self.lake = lake
        self.metrics = metrics or Metrics()
        self.heartbeat = heartbeat
        self.catalog_heartbeat = catalog_heartbeat
        self.clock = clock
        self.write = write
        self.feed = ActiveFeed()
        self.hotspots = NO_HOTSPOTS
        self.hotspots_end: datetime | None = None
        self.tracked: datetime | None = None
        self.catalog: CatalogState | None = None
        self.catalog_seen: datetime | None = None
        self.catalog_read: datetime | None = None
        self.last_ok: datetime | None = None
        self.started = clock()
        self._stop = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    def scan_hotspots(self, now: datetime) -> None:
        end = floor_hour(now) + HOUR
        if end == self.hotspots_end:
            return
        self.hotspots = self.lake.hotspots(end)
        self.hotspots_end = end
        self.metrics.set("active_storms_hotspots", self.hotspots.height)
        log.info(
            "hot spots scanned",
            extra={"fields": {"end": end.isoformat(), "hotspots": self.hotspots.height}},
        )

    def _catalog(self, now: datetime) -> CatalogState:
        tracked = self.lake.tracked_until(now)
        if tracked != self.tracked:
            self.tracked, self.catalog_seen = tracked, now
        seen = self.catalog_seen or now
        fresh = self.catalog_read is not None and self.catalog_read - seen >= CATALOG_SETTLE
        if self.catalog is None or self.catalog.tracked_until != tracked or not fresh:
            self.catalog = self.lake.catalog_state(tracked)
            self.catalog_read = now
        return self.catalog

    def update_once(self) -> dict[str, Any]:
        """Reads, computes, checks and writes one snapshot; raises when nothing was written."""
        t0 = time.perf_counter()
        start = self.clock()
        catalog = self._catalog(start)
        since = self.feed.window(start, catalog.tracked_until)
        data = self.lake.inputs(since, start)
        self.scan_hotspots(start)
        read_s = time.perf_counter() - t0
        now = self.clock()
        snapshot = self.feed.update(
            Update(now, data.flashes, data.observed, catalog, self.hotspots)
        )
        errors = active.check(snapshot)
        if self.feed.previous is not None:
            errors += active.check_transition(self.feed.previous, snapshot)
        if errors:
            self.metrics.inc("active_storms_check_failures_total")
            raise ValueError(f"snapshot breaks the contract: {errors[:10]}")
        body = snapshot.model_dump_json().encode()
        packed = len(gzip.compress(body, 6))
        if len(body) > MAX_RAW_BYTES or packed > MAX_GZIP_BYTES:
            log.warning("snapshot over its size target", extra={"fields": {"bytes": len(body)}})
        if self.write:
            self.lake.write(body)
        written = self.clock()
        self.feed.published(snapshot)
        self.last_ok = written
        stats = self._report(snapshot, data, start, written, read_s, len(body), packed)
        scores = self.feed.id_scores(catalog)
        if scores is not None:
            for scope in ("worst_update", "hour"):
                self.metrics.set("active_storms_final_id_share", scores[scope], scope=scope)
            stats["final_id_share"] = {k: round(v, 4) for k, v in scores.items()}
        log.info("active storms published", extra={"fields": stats})
        return stats

    def _report(
        self,
        snapshot: ActiveStorms,
        data: Inputs,
        start: datetime,
        written: datetime,
        read_s: float,
        raw: int,
        packed: int,
    ) -> dict[str, Any]:
        m = self.metrics
        processing = (written - start).total_seconds()
        m.inc("active_storms_updates_total")
        m.set("active_storms_processing_seconds", processing)
        m.set("active_storms_read_seconds", read_s)
        m.set("active_storms_published_timestamp_seconds", snapshot.published_at.timestamp())
        m.set("active_storms_cells", len(snapshot.cells))
        m.set("active_storms_snapshot_bytes", raw, encoding="raw")
        m.set("active_storms_snapshot_bytes", packed, encoding="gzip")
        m.set("active_storms_flashes", data.silver, input="silver")
        m.set("active_storms_flashes", data.spool, input="spool")
        m.set("active_storms_files_read", data.files_read)
        ages = {}
        for frontier in snapshot.sources:
            if frontier.observed_until is not None:
                age = (snapshot.published_at - frontier.observed_until).total_seconds()
                ages[frontier.source] = round(age)
                m.set("active_storms_age_seconds", age, source=frontier.source)
        lag = None
        if snapshot.authoritative_until is not None:
            lag = (written - snapshot.authoritative_until).total_seconds()
            m.set("active_storms_catalog_lag_seconds", lag)
        return {
            "processing_s": round(processing, 1),
            "read_s": round(read_s, 1),
            "age_s": ages,
            "catalog_lag_s": None if lag is None else round(lag),
            "flashes": {"silver": data.silver, "spool": data.spool},
            "files_read": data.files_read,
            "hours": [h.isoformat() for h in sorted(self.feed.hours)],
            "cells": len(snapshot.cells),
            "provisional": sum(c.provisional for c in snapshot.cells),
            "ended": sum(e.ended_at == snapshot.published_at for e in snapshot.ended),
            "bytes": {"raw": raw, "gzip": packed},
        }

    def healthy(self) -> bool:
        if self._task is None or self._task.done():
            return False
        since = self.last_ok or self.started
        return self.clock() - since <= STALE_AFTER + timedelta(minutes=5 if self.last_ok else 15)

    async def _ping(self, ok: bool, message: str) -> None:
        if self.heartbeat is not None:
            await self.heartbeat.ping(ok, message)

    async def _ping_catalog(self) -> None:
        if self.catalog_heartbeat is None:
            return
        tracked = self.tracked
        late = tracked is None or self.clock() - tracked > CATALOG_LATE
        message = f"authoritative_until {tracked.isoformat() if tracked else None}"
        await self.catalog_heartbeat.ping(not late, message)

    async def run(self) -> None:
        self.feed = ActiveFeed(await asyncio.to_thread(self.lake.previous))
        while not self._stop.is_set():
            started = time.monotonic()
            try:
                await asyncio.to_thread(self.update_once)
                await self._ping(True, "published")
            except Exception as error:
                self.metrics.inc("active_storms_errors_total")
                log.exception("active storms update failed; the previous snapshot stays")
                stale = self.clock() - (self.last_ok or self.started) > STALE_AFTER
                if stale:
                    await self._ping(False, f"{type(error).__name__}: {error}"[:500])
            await self._ping_catalog()
            delay = max(0.0, UPDATE_SECONDS - (time.monotonic() - started))
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=delay)

    async def start(self) -> None:
        self._task = asyncio.create_task(self.run(), name="active-storms")
        await self._task

    def stop(self) -> None:
        self._stop.set()


def lake_from_env(spool: Path | None) -> Lake:
    bucket = os.environ.get("SCINTILLE_LIVE_BUCKET", "scintille-live")
    return Lake(
        lambda: pyiceberg_catalog(LakeConfig.from_env()),
        live_store(bucket),
        spool,
        StormCellsConfig().rule,
    )


async def serve(spool: Path | None, port: int) -> int:
    configure_json_logs()
    metrics = Metrics()
    service = ActiveService(
        lake_from_env(spool),
        metrics=metrics,
        heartbeat=heartbeat_from_env("SCINTILLE_HEALTHCHECK_ACTIVE_URL", "active-storms", metrics),
        catalog_heartbeat=heartbeat_from_env(
            "SCINTILLE_HEALTHCHECK_CATALOG_URL", "storm-catalog", metrics
        ),
    )
    server = await health.serve(port, service.healthy, metrics.render)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, service.stop)
    async with server:
        await service.start()
    return 0


def once(spool: Path | None, dry_run: bool) -> int:
    """One update, printed; with `dry_run` nothing is written to R2."""
    configure_json_logs()
    lake = lake_from_env(spool)
    service = ActiveService(lake, write=not dry_run)
    service.feed = ActiveFeed(lake.previous())
    print(json.dumps(service.update_once(), default=str))
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="scintille-active-storms", description=__doc__)
    parser.add_argument("--spool", type=Path, help="read-only spool of lake-writer")
    parser.add_argument("--port", type=int, default=8082, help="/healthz and /metrics")
    parser.add_argument("--once", action="store_true", help="one update, then exit")
    parser.add_argument("--dry-run", action="store_true", help="with --once: write nothing")
    args = parser.parse_args(argv)
    if args.once:
        return once(args.spool, args.dry_run)
    return asyncio.run(serve(args.spool, args.port))
