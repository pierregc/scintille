"""One `bronze.ingest_log` row per product file."""

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from scintille_contract.models import Source

IngestStatus = Literal["ok", "failed"]


@dataclass(frozen=True)
class IngestLogRecord:
    key: str
    source: Source
    satellite: str
    product_start: datetime
    product_end: datetime
    received_at: datetime
    row_count: int
    checksum: str
    status: IngestStatus
    parse_duration_ms: float
    error: str | None = None
