"""Command line: `glm --once`, `mtg --once`, `live`, `lake-writer`, `live-probe`, `clouds` and
`calibrate`."""

import argparse
import asyncio
import logging
import os
import signal
import socket
import statistics
import sys
from collections.abc import Callable, Sequence
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import duckdb
import polars as pl
from obstore.store import S3Store
from scintille_lake.config import LakeConfig
from scintille_lake.connect import duckdb_attach, pyiceberg_catalog
from scintille_lake.locks import partition_locks

from scintille_ingest.clouds import fci, gfs, gmgsi
from scintille_ingest.clouds.collector import CloudCollector, CompositeCollector
from scintille_ingest.clouds.publish import CloudPublisher
from scintille_ingest.clouds.reindex import days_between, reindex_day
from scintille_ingest.clouds.sources import GOES_BUCKETS, HIMAWARI_BUCKET, Sources
from scintille_ingest.glm.discovery import fetch, latest_product, public_store
from scintille_ingest.glm.ingest import IngestedFile, ingest_glm_file
from scintille_ingest.glm.products import Satellite, satellites_from_env
from scintille_ingest.intensity import CALIBRATIONS, fit, next_version, quantiles_query
from scintille_ingest.mtg import discovery as mtg_discovery
from scintille_ingest.mtg.ingest import ingest_li_file
from scintille_ingest.ownership import outside_owner_zone
from scintille_ingest.runtime import health
from scintille_ingest.runtime.heartbeat import heartbeat_from_env
from scintille_ingest.runtime.lake_commit import LakeCommit
from scintille_ingest.runtime.lake_writer import LakeWriter
from scintille_ingest.runtime.live_feed import (
    FileLiveStore,
    LiveFeed,
    LiveStore,
    ObjectLiveStore,
    StateDelays,
)
from scintille_ingest.runtime.live_probe import MANIFEST_URL, MAX_AGE, LiveProbe
from scintille_ingest.runtime.logs import configure as configure_json_logs
from scintille_ingest.runtime.metrics import Metrics
from scintille_ingest.runtime.ops import OpsPublisher, PostgresOps
from scintille_ingest.runtime.service import IngestLive
from scintille_ingest.runtime.sources import GlmSource, MtgSource, Source
from scintille_ingest.runtime.spool import Spool
from scintille_ingest.runtime.state import PostgresState

log = logging.getLogger("scintille_ingest")

SUMMARY_COLUMNS = ("event_time", "lat", "lon", "energy_raw", "area_km2", "duration_ms", "quality")
# eumdac sets no timeout: a stalled EUMETSAT read would otherwise block MTG LI forever.
SOCKET_TIMEOUT = 60.0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="scintille-ingest")
    commands = parser.add_subparsers(dest="command", required=True)
    glm = commands.add_parser("glm", help="ingest NOAA GOES GLM L2 LCFA files")
    glm.add_argument("--once", action="store_true", help="ingest the latest file of each satellite")
    glm.add_argument("--east-bucket", help="override the GOES-East bucket")
    glm.add_argument("--west-bucket", help="override the GOES-West bucket")
    glm.add_argument("--rows", type=int, default=5, help="flashes to print per file")
    mtg = commands.add_parser("mtg", help="ingest EUMETSAT MTG LI L2 LFL chunks")
    mtg.add_argument("--once", action="store_true", help="ingest the latest chunk")
    mtg.add_argument("--rows", type=int, default=5, help="flashes to print")
    mtg.add_argument("--save", type=Path, help="also write the chunk file into this directory")
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
    clouds = commands.add_parser("clouds", help="publish cloud frames to the live bucket")
    clouds.add_argument("--port", type=int, default=8081, help="/healthz and /metrics")
    clouds.add_argument(
        "--source",
        choices=("gmgsi", "composite"),
        default=os.environ.get("SCINTILLE_CLOUD_SOURCE", "gmgsi"),
    )
    clouds.add_argument(
        "--slot", type=_utc, help="composite: render this hour once instead of running"
    )
    clouds.add_argument(
        "--out", type=Path, help="with --slot: write the bucket layout here instead of R2"
    )
    reindex = commands.add_parser(
        "clouds-reindex", help="index archived cloud textures that no daily index lists"
    )
    reindex.add_argument("--first", type=date.fromisoformat, required=True, help="first day")
    reindex.add_argument("--last", type=date.fromisoformat, required=True, help="last day")
    reindex.add_argument("--dry-run", action="store_true", help="log, write nothing")
    calibrate = commands.add_parser(
        "calibrate", help="fit the intensity calibration on silver.flashes and write it"
    )
    calibrate.add_argument("--start", type=date.fromisoformat, required=True, help="first day")
    calibrate.add_argument("--end", type=date.fromisoformat, required=True, help="day after last")
    calibrate.add_argument("--out", type=Path, default=CALIBRATIONS)
    args = parser.parse_args(argv)
    if args.command == "calibrate":
        return run_calibrate(args.start, args.end, args.out)
    if args.command == "clouds-reindex":
        return run_clouds_reindex(args.first, args.last, args.dry_run)
    if args.command == "live-probe":
        return asyncio.run(run_live_probe(args.url, args.max_age, args.every, args.once))
    if args.command == "clouds":
        if args.source == "composite":
            return asyncio.run(run_composite(args.port, args.slot, args.out))
        return asyncio.run(run_clouds(args.port))
    if args.command == "live":
        return asyncio.run(run_live(args.spool, args.port))
    if args.command == "lake-writer":
        return asyncio.run(run_lake_writer(args.spool, args.interval))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if not args.once:
        parser.error("only --once is supported for now")
    if args.command == "mtg":
        store = mtg_discovery.store_from_env()
        if store is None:
            log.error("SCINTILLE_EUMETSAT_CONSUMER_KEY and _SECRET must be set")
            return 2
        return mtg_once(store, args.rows, args.save)
    buckets = {"glm-east": args.east_bucket, "glm-west": args.west_bucket}
    satellites = [
        replace(sat, bucket=buckets[sat.source] or sat.bucket) for sat in satellites_from_env()
    ]
    return glm_once(satellites, args.rows)


def run_calibrate(start: date, end: date, out: Path) -> int:
    """Writes `cal-N.json` (next version) from the lake in `SCINTILLE_LAKE_*`."""
    connection = duckdb.connect()
    duckdb_attach(connection, LakeConfig.from_env())
    rows = connection.execute(*quantiles_query(start, end)).fetchall()
    quantiles = {source: (unit, count, values) for source, unit, count, values in rows}
    calibration = fit(quantiles, next_version(), (start, end))
    path = out / f"{calibration.version}.json"
    path.write_text(calibration.to_json())
    for source, knots in calibration.sources.items():
        print(f"{source}: {knots.flashes} flashes, {knots.unit}")
    print(f"wrote {path}")
    return 0


async def run_live(spool_dir: Path, port: int) -> int:
    """Until SIGTERM or SIGINT; file states in Postgres (`SCINTILLE_POSTGRES_DSN`), original files
    in R2 (`SCINTILLE_R2_*`)."""
    configure_json_logs()
    socket.setdefaulttimeout(SOCKET_TIMEOUT)
    dsn = os.environ.get("SCINTILLE_POSTGRES_DSN")
    if not dsn:
        log.error("SCINTILLE_POSTGRES_DSN is not set")
        return 2
    metrics = Metrics()
    feed = live_feed_from_env(metrics, spool_dir / "live-outbox")
    spool = Spool(spool_dir)
    ops = OpsPublisher(feed.store, feed, spool, PostgresOps(dsn), metrics=metrics) if feed else None
    sources: list[Source] = [GlmSource(s) for s in satellites_from_env()]
    if eumetsat := mtg_discovery.store_from_env():
        sources.append(MtgSource(eumetsat))
    else:
        log.warning("EUMETSAT credentials are not set: no MTG LI")
    service = IngestLive(
        sources,
        PostgresState(dsn),
        spool,
        publisher=feed,
        heartbeat=heartbeat_from_env("SCINTILLE_HEALTHCHECK_URL", "ingest-live", metrics),
        metrics=metrics,
    )
    server = await health.serve(port, service.healthy, metrics.render)

    def stop() -> None:
        service.stop()
        if feed:
            feed.stop()
        if ops:
            ops.stop()

    _stop_on_signals(stop)
    async with server:
        await asyncio.gather(
            service.run(), *([feed.run()] if feed else []), *([ops.run()] if ops else [])
        )
    return 0


def live_feed_from_env(metrics: Metrics, outbox: Path) -> LiveFeed | None:
    """Publishes to `SCINTILLE_LIVE_BUCKET`, with the R2 credentials used elsewhere, when set;
    source state delays from `StateDelays.from_env`."""
    bucket = os.environ.get("SCINTILLE_LIVE_BUCKET")
    if not bucket:
        log.warning("SCINTILLE_LIVE_BUCKET is not set: no live feed, spool only")
        return None
    return LiveFeed(
        ObjectLiveStore(live_store(bucket)),
        outbox=outbox,
        metrics=metrics,
        delays=StateDelays.from_env(),
    )


async def run_clouds(port: int) -> int:
    """Until SIGTERM or SIGINT; textures go to `SCINTILLE_LIVE_BUCKET`."""
    configure_json_logs()
    bucket = os.environ.get("SCINTILLE_LIVE_BUCKET")
    if not bucket:
        log.error("SCINTILLE_LIVE_BUCKET is not set")
        return 2
    store = live_store(bucket)
    metrics = Metrics()
    collector = CloudCollector(
        public_store(gmgsi.BUCKET),
        gfs.GfsSkin(public_store(gfs.BUCKET)),
        CloudPublisher(
            ObjectLiveStore(store, prefix="live/clouds/"),
            ObjectLiveStore(store, prefix="archive/clouds/"),
        ),
        metrics=metrics,
    )
    server = await health.serve(port, collector.healthy, metrics.render)
    _stop_on_signals(collector.stop)
    async with server:
        await collector.start()
    return 0


COMPOSITE_ATTRIBUTION = (
    "Clouds: NOAA GOES-East and GOES-West, JMA Himawari-9 via NOAA, contains modified EUMETSAT "
    "Meteosat data {year}; gaps from NOAA NESDIS GMGSI"
)


async def run_composite(port: int, slot: datetime | None, out: Path | None) -> int:
    """Hourly composite (ADR 0023): GOES and Himawari from AWS, MTG FCI from the EUMETSAT Data
    Store (`SCINTILLE_EUMETSAT_*`); workers `SCINTILLE_CLOUD_WORKERS`, scratch space
    `SCINTILLE_CLOUD_WORK_DIR`."""
    configure_json_logs()
    live: LiveStore
    archive: LiveStore
    if out is not None:
        live, archive = FileLiveStore(out, "live/clouds/"), FileLiveStore(out, "archive/clouds/")
    else:
        bucket = os.environ.get("SCINTILLE_LIVE_BUCKET")
        if not bucket:
            log.error("SCINTILLE_LIVE_BUCKET is not set")
            return 2
        store = live_store(bucket)
        live = ObjectLiveStore(store, prefix="live/clouds/")
        archive = ObjectLiveStore(store, prefix="archive/clouds/")
    key = os.environ.get("SCINTILLE_EUMETSAT_CONSUMER_KEY")
    secret = os.environ.get("SCINTILLE_EUMETSAT_CONSUMER_SECRET")
    mtg = (
        mtg_discovery.EumdacStore(key, secret, collection=fci.COLLECTION)
        if key and secret
        else None
    )
    if mtg is None:
        log.warning("EUMETSAT credentials are not set: no FCI, Europe and Africa from GMGSI")
    year = (slot or datetime.now(UTC)).year
    metrics = Metrics()
    collector = CompositeCollector(
        Sources(
            {sat: public_store(bucket) for sat, bucket in GOES_BUCKETS.items()},
            public_store(HIMAWARI_BUCKET),
            mtg,
        ),
        gfs.GfsSkin(public_store(gfs.BUCKET)),
        public_store(gmgsi.BUCKET),
        CloudPublisher(live, archive, attribution=COMPOSITE_ATTRIBUTION.format(year=year)),
        Path(os.environ.get("SCINTILLE_CLOUD_WORK_DIR", "/tmp/scintille-clouds")),
        workers=int(os.environ.get("SCINTILLE_CLOUD_WORKERS", "2")),
        metrics=metrics,
    )
    if slot is not None:
        await collector.publisher.restore()
        files = await asyncio.to_thread(collector.sources.find, slot)
        if not files.complete_satellites:
            log.error("no satellite delivered this slot")
            return 1
        await collector.process(files)
        return 0
    server = await health.serve(port, collector.healthy, metrics.render)
    _stop_on_signals(collector.stop)
    async with server:
        await collector.start()
    return 0


def run_clouds_reindex(first: date, last: date, dry_run: bool) -> int:
    configure_json_logs()
    bucket = os.environ.get("SCINTILLE_LIVE_BUCKET")
    if not bucket:
        log.error("SCINTILLE_LIVE_BUCKET is not set")
        return 2
    store, noaa, forecasts = (
        live_store(bucket),
        public_store(gmgsi.BUCKET),
        public_store(gfs.BUCKET),
    )
    now = datetime.now(UTC)
    added = sum(
        reindex_day(store, noaa, forecasts, day, now, dry_run) for day in days_between(first, last)
    )
    print(f"{added} frames indexed{' (dry run)' if dry_run else ''}")
    return 0


def _utc(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)


def live_store(bucket: str) -> S3Store:
    endpoint = os.environ["SCINTILLE_R2_ENDPOINT"]
    return S3Store(
        bucket,
        endpoint=endpoint,
        access_key_id=os.environ["SCINTILLE_R2_ACCESS_KEY_ID"],
        secret_access_key=os.environ["SCINTILLE_R2_SECRET_ACCESS_KEY"],
        region="auto",
        client_options={"allow_http": endpoint.startswith("http://")},
    )


async def run_lake_writer(spool_dir: Path, interval: float) -> int:
    """Catalog from `SCINTILLE_LAKE_*`, partition locks in `SCINTILLE_POSTGRES_DSN`."""
    configure_json_logs()
    dsn = os.environ.get("SCINTILLE_POSTGRES_DSN")
    if not dsn:
        log.error("SCINTILLE_POSTGRES_DSN is not set")
        return 2
    metrics = Metrics()
    ops = PostgresOps(dsn)
    commit = LakeCommit(
        catalog=lambda: pyiceberg_catalog(LakeConfig.from_env()),
        locker=lambda keys: partition_locks(dsn, keys),
        metrics=metrics,
        record_operations=lambda n: ops.add_catalog_operations(f"{datetime.now(UTC):%Y-%m}", n),
    )
    writer = LakeWriter(Spool(spool_dir), commit=commit, interval=interval, metrics=metrics)
    _stop_on_signals(writer.stop)
    await writer.run()
    return 0


async def run_live_probe(url: str, max_age: float, every: float, once: bool) -> int:
    """Reports to `SCINTILLE_HEALTHCHECK_LIVE_URL` when set, except with `--once`."""
    configure_json_logs()
    heartbeat = (
        None
        if once
        else heartbeat_from_env("SCINTILLE_HEALTHCHECK_LIVE_URL", "live-manifest", Metrics())
    )
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
        _print_summary(satellite.source, f"s3://{satellite.bucket}", ingested, rows)
        log.info("%s ingest_log %s", satellite.source, ingested.log)
        log.info("%s lag from product start to parse completion: %.1f s", satellite.source, lag)
    if lags:
        log.info("median lag over %d files: %.1f s", len(lags), statistics.median(lags))
    return 1 if failed else 0


def mtg_once(store: mtg_discovery.DataStore, rows: int, save: Path | None = None) -> int:
    """Latest chunk of the last hour, with the latencies #32 asks to measure."""
    now = datetime.now(UTC)
    listed = store.search(now - timedelta(hours=1), now)
    found = mtg_discovery.chunks(listed)
    if not found:
        log.warning("mtg-li: no LFL chunk in the Data Store for the last hour")
        return 1
    chunk = found[-1]
    data = store.fetch(chunk.product_id, chunk.name)
    received = datetime.now(UTC)
    if save:
        save.mkdir(parents=True, exist_ok=True)
        (save / chunk.name).write_bytes(data)
        log.info("mtg-li chunk saved to %s", save / chunk.name)
    ingested = ingest_li_file(data, chunk.key, received)
    _print_summary("mtg-li", "EUMETSAT Data Store", ingested, rows)
    log.info("mtg-li ingest_log %s", ingested.log)
    published = next(p.published for p in listed if p.product_id == chunk.product_id)
    if published:
        log.info(
            "mtg-li Data Store publication after chunk end: %.1f s",
            (published - chunk.end).total_seconds(),
        )
    log.info("mtg-li received after chunk end: %.1f s", (received - chunk.end).total_seconds())
    newest = ingested.flashes["event_time"].max()
    if isinstance(newest, datetime):
        log.info("mtg-li received after newest flash: %.1f s", (received - newest).total_seconds())
    return 0 if ingested.log.status == "ok" else 1


def _print_summary(source: str, origin: str, ingested: IngestedFile, rows: int) -> None:
    flashes, entry = ingested.flashes, ingested.log
    degraded = flashes.filter(pl.col("quality").list.contains("degraded")).height
    outside = flashes.filter(outside_owner_zone()).height
    print(
        f"{source} ({entry.satellite}, {origin}) {entry.key}\n"
        f"  {entry.row_count} normalized flashes, {degraded} degraded, "
        f"{outside} outside owner zone, status {entry.status}, "
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
