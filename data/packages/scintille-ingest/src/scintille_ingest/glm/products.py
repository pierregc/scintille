"""GLM L2 LCFA product files: satellites, bucket layout and file names."""

import os
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from scintille_contract.models import Source

PRODUCT = "GLM-L2-LCFA"

_NAME = re.compile(
    r"OR_GLM-L2-LCFA_(?P<platform>G\d{2})"
    r"_s(?P<start>\d{14})_e(?P<end>\d{14})_c(?P<created>\d{14})\.nc$"
)


@dataclass(frozen=True)
class Satellite:
    """A GOES slot and the public NOAA bucket of the satellite currently operating it."""

    source: Source
    bucket: str


def satellites_from_env() -> tuple[Satellite, ...]:
    """GOES-East and GOES-West, buckets overridable when NOAA swaps satellites."""
    return (
        Satellite("glm-east", os.environ.get("SCINTILLE_GLM_EAST_BUCKET", "noaa-goes19")),
        Satellite("glm-west", os.environ.get("SCINTILLE_GLM_WEST_BUCKET", "noaa-goes18")),
    )


@dataclass(frozen=True)
class ProductKey:
    """Object key of one product file and the times encoded in its name."""

    key: str
    platform: str
    start: datetime
    end: datetime
    created: datetime
    etag: str | None = None

    @property
    def name(self) -> str:
        return self.key.rsplit("/", 1)[-1]


def parse_key(key: str) -> ProductKey:
    match = _NAME.search(key)
    if match is None:
        raise ValueError(f"not a GLM L2 LCFA file name: {key}")
    return ProductKey(
        key=key,
        platform=match["platform"],
        start=_goes_time(match["start"]),
        end=_goes_time(match["end"]),
        created=_goes_time(match["created"]),
    )


def _goes_time(value: str) -> datetime:
    """`YYYYJJJHHMMSSt` (day of year, tenths of a second) to UTC."""
    year_start = datetime(int(value[:4]), 1, 1, tzinfo=UTC)
    return year_start + timedelta(
        days=int(value[4:7]) - 1,
        hours=int(value[7:9]),
        minutes=int(value[9:11]),
        seconds=int(value[11:13]),
        milliseconds=100 * int(value[13]),
    )


def goes_stamp(at: datetime) -> str:
    """Inverse of `_goes_time`, truncated to the tenth of a second."""
    at = at.astimezone(UTC)
    return f"{at:%Y%j%H%M%S}{at.microsecond // 100_000}"


def hour_prefix(at: datetime) -> str:
    return f"{PRODUCT}/{at.astimezone(UTC):%Y/%j/%H}/"


def start_offset(hour: datetime, platform: str, start: datetime) -> str:
    """Sorts just before the keys of `hour` whose file starts at `start` or later."""
    return f"{hour_prefix(hour)}OR_{PRODUCT}_{platform}_s{goes_stamp(start)}"
