"""Command line: `scintille-ingest glm --once`, `live`, `lake-writer` and `live-probe`."""

import argparse
import asyncio
import logging
import os
import signal
import statistics
import sys
from collections.abc import Callable, Sequence
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

import polars as pl
from obstore.store import S3Store
from scintille_lake.config import LakeConfig
from scintille_lake.connect import pyiceberg_catalog
from scintille_lake.locks import partition_locks

from scintille_ingest.glm.discovery import fetch, latest_product, public_store
from scintille_ingest.glm.ingest import IngestedFile, ingest_glm_file
from scintille_ingest.glm.products import Satellite, satellites_from_env
from scintille_ingest.runtime import health
from scintille_ingest.runtime.heartbeat import heartbeat_from_env
from scintille_ingest.runtime.lake_commit import LakeCommit
from scintille_ingest.runtime.lake_writer import LakeWriter
from scintille_ingest.runtime.live_feed import LiveFeed, ObjectLiveStore
from scintille_ingest.runtime.live_probe import MANIFEST_URL, MAX_AGE, LiveProbe
from scintille_ingest.runtime.logs import configure as configure_json_logs
from scintille_ingest.runtime.metrics import Metrics
from scintille_ingest.runtime.raw_cache import ObjectRawCache, r2_store_from_env
from scintille_ingest.runtime.service import IngestLive
from scintille_ingest.runtime.sources import GlmSource
from scintille_ingest.runtime.spool import Spool
from scintille_ingest.runtime.state import PostgresState

log = logging.getLogger("scintille_ingest")

SUMMARY_COLUMNS = ("event_time", "lat", "lon", "energy_raw", "area_km2", "duration_ms", "quality")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="scintille-ingest")
    commands = parser.add_subparsers(dest="command", required=True)
    glm = commands.add_parser("glm", help="ingest NOAA GOES GLM L2 LCFA files")
    glm.add_argument("--once", action="store_true", help="ingest the latest file of each satellite")
    glm.add_argument("--east-bucket", help="override the GOES-East bucket")
    glm.add_argument("--west-bucket", help="override the GOES-West bucket")
    glm.add_argument("--rows", type=int, default=5, help="flashes to print per file")
    live = commands.add_parser("live", help="run ingest-live: sources to live feed and spool")
    live.add_argument(
        "--spool", type=Path, default=Path(os.environ.get("SCINTILLE_SPOOL_DIR", "spool"))
    )
    live.add_argument("--port", type=int, default=8080, help="/healthz and /metrics")
    writer = commands.add_parser("lake-writer", help="drain the spool into the lakehouse")
    writer.add_argument(
        "--spool", type=Path, default=Path(os.environ.get("SCINTILLE_SPOOL_DIR", "spool"))
    )
    writer.add_argument("--interval", type=float, default=300.0, help="seconds between drains")
    probe = commands.add_parser("live-probe", help="check the freshness of the public manifest")
    probe.add_argument("--url", default=os.environ.get("SCINTILLE_LIVE_MANIFEST_URL", MANIFEST_URL))
    probe.add_argument("--max-age", type=float, default=MAX_AGE, help="seconds")
    probe.add_argument("--every", type=float, default=60.0, help="seconds between checks")
    probe.add_argument("--once", action="store_true", help="check once; exit 1 if not fresh")
    args = parser.parse_args(argv)
    if args.command == "live-probe":
        return asyncio.run(run_live_probe(args.url, args.max_age, args.every, args.once))
    if args.command == "live":
        return asyncio.run(run_live(args.spool, args.port))
    if args.command == "lake-writer":
        return asyncio.run(run_lake_writer(args.spool, args.interval))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if not args.once:
        parser.error("only --once is supported for now")
    buckets = {"glm-east": args.east_bucket, "glm-west": args.west_bucket}
    satellites = [
        replace(sat, bucket=buckets[sat.source] or sat.bucket) for sat in satellites_from_env()
    ]
    return glm_once(satellites, args.rows)


async def run_live(spool_dir: Path, port: int) -> int:
    """Until SIGTERM or SIGINT; file states in Postgres (`SCINTILLE_POSTGRES_DSN`), original files
    in R2 (`SCINTILLE_R2_*`)."""
    configure_json_logs()
    dsn = os.environ.get("SCINTILLE_POSTGRES_DSN")
    if not dsn:
        log.error("SCINTILLE_POSTGRES_DSN is not set")
        return 2
    metrics = Metrics()
    feed = live_feed_from_env(metrics, spool_dir / "live-outbox")
    service = IngestLive(
        [GlmSource(s) for s in satellites_from_env()],
        PostgresState(dsn),
        Spool(spool_dir),
        publisher=feed,
        raw_cache=ObjectRawCache(r2_store_from_env()),
        heartbeat=heartbeat_from_env("SCINTILLE_HEALTHCHECK_URL", "ingest-live", metrics),
        metrics=metrics,
    )
    server = await health.serve(port, service.healthy, metrics.render)

    def stop() -> None:
        service.stop()
        if feed:
            feed.stop()

    _stop_on_signals(stop)
    async with server:
        await asyncio.gather(service.run(), *([feed.run()] if feed else []))
    return 0


def live_feed_from_env(metrics: Metrics, outbox: Path) -> LiveFeed | None:
    """Publishes to `SCINTILLE_LIVE_BUCKET`, with the R2 credentials used elsewhere, when set."""
    bucket = os.environ.get("SCINTILLE_LIVE_BUCKET")
    if not bucket:
        log.warning("SCINTILLE_LIVE_BUCKET is not set: no live feed, spool only")
        return None
    endpoint = os.environ["SCINTILLE_R2_ENDPOINT"]
    store = S3Store(
        bucket,
        endpoint=endpoint,
        access_key_id=os.environ["SCINTILLE_R2_ACCESS_KEY_ID"],
        secret_access_key=os.environ["SCINTILLE_R2_SECRET_ACCESS_KEY"],
        region="auto",
        client_options={"allow_http": endpoint.startswith("http://")},
    )
    return LiveFeed(ObjectLiveStore(store), outbox=outbox, metrics=metrics)


async def run_lake_writer(spool_dir: Path, interval: float) -> int:
    """Catalog from `SCINTILLE_LAKE_*`, partition locks in `SCINTILLE_POSTGRES_DSN`."""
    configure_json_logs()
    dsn = os.environ.get("SCINTILLE_POSTGRES_DSN")
    if not dsn:
        log.error("SCINTILLE_POSTGRES_DSN is not set")
        return 2
    metrics = Metrics()
    commit = LakeCommit(
        catalog=lambda: pyiceberg_catalog(LakeConfig.from_env()),
        locker=lambda keys: partition_locks(dsn, keys),
        metrics=metrics,
    )
    writer = LakeWriter(Spool(spool_dir), commit=commit, interval=interval, metrics=metrics)
    _stop_on_signals(writer.stop)
    await writer.run()
    return 0


async def run_live_probe(url: str, max_age: float, every: float, once: bool) -> int:
    """Reports to `SCINTILLE_HEALTHCHECK_LIVE_URL` when set."""
    configure_json_logs()
    heartbeat = heartbeat_from_env("SCINTILLE_HEALTHCHECK_LIVE_URL", "live-manifest", Metrics())
    probe = LiveProbe(url, max_age, heartbeat=heartbeat, every=every)
    if once:
        return 0 if await probe.once() else 1
    _stop_on_signals(probe.stop)
    await probe.run()
    return 0


def _stop_on_signals(stop: Callable[[], None]) -> None:
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop)


def glm_once(satellites: Sequence[Satellite], rows: int) -> int:
    lags: list[float] = []
    failed = False
    for satellite in satellites:
        store = public_store(satellite.bucket)
        product = latest_product(store, datetime.now(UTC))
        if product is None:
            log.warning(
                "%s: no file in s3://%s for the last hour", satellite.source, satellite.bucket
            )
            failed = True
            continue
        data = fetch(store, product.key)
        ingested = ingest_glm_file(data, product.key, satellite.source, datetime.now(UTC))
        lag = (datetime.now(UTC) - product.start).total_seconds()
        lags.append(lag)
        failed |= ingested.log.status != "ok"
        _print_summary(satellite, ingested, rows)
        log.info("%s ingest_log %s", satellite.source, ingested.log)
        log.info("%s lag from product start to parse completion: %.1f s", satellite.source, lag)
    if lags:
        log.info("median lag over %d files: %.1f s", len(lags), statistics.median(lags))
    return 1 if failed else 0


def _print_summary(satellite: Satellite, ingested: IngestedFile, rows: int) -> None:
    flashes, entry = ingested.flashes, ingested.log
    degraded = flashes.filter(pl.col("quality").list.len() > 0).height
    print(
        f"{satellite.source} ({entry.satellite}, s3://{satellite.bucket}) {entry.key}\n"
        f"  {entry.row_count} normalized flashes, {degraded} degraded, status {entry.status}, "
        f"parsed in {entry.parse_duration_ms:.1f} ms"
    )
    if entry.error:
        print(f"  error: {entry.error}")
    if rows > 0 and flashes.height:
        with pl.Config(tbl_rows=rows, tbl_cols=-1, tbl_width_chars=140):
            print(flashes.select(SUMMARY_COLUMNS).head(rows))
    sys.stdout.flush()


if __name__ == "__main__":
    sys.exit(main())
