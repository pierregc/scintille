"""Turn the bytes of one LFL chunk into flash records and an ingest log row."""

import hashlib
import time
from datetime import datetime

from scintille_ingest.glm.ingest import IngestedFile
from scintille_ingest.glm.parse import empty_flashes
from scintille_ingest.ingest_log import IngestLogRecord
from scintille_ingest.intensity import with_intensity
from scintille_ingest.mtg.parse import normalize_li_flashes, read_li_flashes
from scintille_ingest.mtg.products import parse_key
from scintille_ingest.ownership import flag_outside_owner


def ingest_li_file(data: bytes, key: str, received_at: datetime) -> IngestedFile:
    chunk = parse_key(key)
    started = time.perf_counter()
    error: str | None = None
    try:
        raw = read_li_flashes(data)
        flashes = normalize_li_flashes(raw, "mtg-li", chunk.name, received_at)
        flashes = with_intensity(flag_outside_owner(flashes))
    except (AttributeError, OSError, KeyError, ValueError) as exc:
        flashes, error = empty_flashes(), f"{type(exc).__name__}: {exc}"
    log = IngestLogRecord(
        key=key,
        source="mtg-li",
        satellite=chunk.platform,
        product_start=chunk.start,
        product_end=chunk.end,
        received_at=received_at,
        row_count=flashes.height,
        checksum=f"sha256:{hashlib.sha256(data).hexdigest()}",
        status="ok" if error is None else "failed",
        parse_duration_ms=(time.perf_counter() - started) * 1e3,
        error=error,
    )
    return IngestedFile(flashes, log)
