"""Command line: `scintille-ingest glm --once`."""

import argparse
import logging
import statistics
import sys
from collections.abc import Sequence
from dataclasses import replace
from datetime import UTC, datetime

import polars as pl

from scintille_ingest.glm.discovery import fetch, latest_product, public_store
from scintille_ingest.glm.ingest import IngestedFile, ingest_glm_file
from scintille_ingest.glm.products import Satellite, satellites_from_env

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
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if not args.once:
        parser.error("only --once is supported for now")
    buckets = {"glm-east": args.east_bucket, "glm-west": args.west_bucket}
    satellites = [
        replace(sat, bucket=buckets[sat.source] or sat.bucket) for sat in satellites_from_env()
    ]
    return glm_once(satellites, args.rows)


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
