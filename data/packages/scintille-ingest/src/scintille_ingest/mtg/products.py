"""LI L2 LFL products of the EUMETSAT Data Store and the chunk files inside them."""

import re
from dataclasses import dataclass
from datetime import UTC, datetime

COLLECTION = "EO:EUM:DAT:0691"

_NAME = re.compile(
    r"MTI(?P<platform>\d)\+LI-2-LFL-.*_C_EUMT_(?P<created>\d{14})_[A-Z0-9]+_[A-Z]+"
    r"_(?P<start>\d{14})_(?P<end>\d{14})_.*\.nc$"
)


@dataclass(frozen=True)
class ChunkKey:
    """One `.nc` chunk: `key` is `<product id>/<entry>`, so a raw copy keeps its product."""

    key: str
    platform: str
    start: datetime
    end: datetime
    created: datetime

    @property
    def name(self) -> str:
        return self.key.rsplit("/", 1)[-1]

    @property
    def product_id(self) -> str:
        return self.key.rsplit("/", 1)[0]


def parse_key(key: str) -> ChunkKey:
    match = _NAME.search(key.rsplit("/", 1)[-1])
    if match is None:
        raise ValueError(f"not an LI L2 LFL file name: {key}")
    return ChunkKey(
        key=key,
        platform=f"MTG-I{match['platform']}",
        start=_time(match["start"]),
        end=_time(match["end"]),
        created=_time(match["created"]),
    )


def is_flash_chunk(entry: str) -> bool:
    """LFL body chunks; the trailer and metadata files carry no flashes."""
    return entry.endswith(".nc") and "TRAIL" not in entry and _NAME.search(entry) is not None


def _time(value: str) -> datetime:
    return datetime.strptime(value, "%Y%m%d%H%M%S").replace(tzinfo=UTC)
