"""Turn the bytes of one product file into flash records and an ingest log row."""

import hashlib
import time
from dataclasses import dataclass
from datetime import datetime

import polars as pl
from scintille_contract.models import Source

from scintille_ingest.glm.parse import empty_flashes, normalize_glm_flashes, read_glm_flashes
from scintille_ingest.glm.products import parse_key
from scintille_ingest.ingest_log import IngestLogRecord


@dataclass(frozen=True)
class IngestedFile:
    flashes: pl.DataFrame
    log: IngestLogRecord


def ingest_glm_file(data: bytes, key: str, source: Source, received_at: datetime) -> IngestedFile:
    product = parse_key(key)
    started = time.perf_counter()
    error: str | None = None
    try:
        raw = read_glm_flashes(data)
        flashes = normalize_glm_flashes(raw, source, product.name, received_at)
    except (OSError, KeyError, ValueError) as exc:
        flashes, error = empty_flashes(), f"{type(exc).__name__}: {exc}"
    log = IngestLogRecord(
        key=key,
        source=source,
        satellite=product.platform,
        product_start=product.start,
        product_end=product.end,
        received_at=received_at,
        row_count=flashes.height,
        checksum=f"sha256:{hashlib.sha256(data).hexdigest()}",
        status="ok" if error is None else "failed",
        parse_duration_ms=(time.perf_counter() - started) * 1e3,
        error=error,
    )
    return IngestedFile(flashes, log)
