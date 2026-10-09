"""Binary encoding of live chunks (layout from the chunk schema)."""

import gzip
import json
import struct
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import numpy as np
from numpy.typing import NDArray

from scintille_contract.compat import parse_version
from scintille_contract.models import (
    CHUNK_COLUMNS_BINARY_LAYOUT,
    SCHEMA_VERSION,
    SOURCE_VALUES,
)

MAGIC = b"SCNT"
HEADER = struct.Struct("<4sBBHII")
COLUMN_NAMES = tuple(column.name for column in CHUNK_COLUMNS_BINARY_LAYOUT)

type Columns = Mapping[str, NDArray[Any]]


@dataclass(frozen=True)
class Chunk:
    """Flashes of one ingest window; source is an index into SOURCE_VALUES."""

    start: datetime
    columns: Columns

    @property
    def count(self) -> int:
        return len(self.columns[COLUMN_NAMES[0]])


def encode(chunk: Chunk) -> bytes:
    """Raw (uncompressed) binary chunk: 16-byte header then one array per column."""
    major, minor, _ = parse_version(SCHEMA_VERSION)
    start = chunk.start.timestamp()
    if not start.is_integer():
        raise ValueError("chunk start must be a whole second")
    parts = [HEADER.pack(MAGIC, major, minor, 0, int(start), chunk.count)]
    offset = HEADER.size
    for column in CHUNK_COLUMNS_BINARY_LAYOUT:
        dtype = np.dtype(column.dtype).newbyteorder("<")
        if offset % dtype.itemsize:
            raise ValueError(f"column {column.name} is misaligned")
        values = np.asarray(chunk.columns[column.name], dtype=np.float64)
        info = np.iinfo(dtype)
        stored = np.clip(np.rint(values / column.scale), info.min, info.max).astype(dtype)
        parts.append(stored.tobytes())
        offset += stored.nbytes
    return b"".join(parts)


def decode(data: bytes) -> Chunk:
    magic, major, _, _, start, count = HEADER.unpack_from(data)
    if magic != MAGIC:
        raise ValueError("not a scintille chunk")
    if major != parse_version(SCHEMA_VERSION)[0]:
        raise ValueError(f"unsupported chunk major version {major}")
    columns: dict[str, NDArray[Any]] = {}
    offset = HEADER.size
    for column in CHUNK_COLUMNS_BINARY_LAYOUT:
        dtype = np.dtype(column.dtype).newbyteorder("<")
        stored = np.frombuffer(data, dtype=dtype, count=count, offset=offset)
        offset += stored.nbytes
        columns[column.name] = stored * column.scale if column.scale != 1 else stored
    return Chunk(datetime.fromtimestamp(start, UTC), columns)


def compress(raw: bytes) -> bytes:
    """Deterministic gzip, as stored on R2."""
    return gzip.compress(raw, compresslevel=9, mtime=0)


def to_json(chunk: Chunk, decimals: int = 3) -> bytes:
    """Columnar JSON form of the chunk (LiveChunk schema)."""
    columns: dict[str, list[Any]] = {}
    for name in COLUMN_NAMES:
        values = chunk.columns[name]
        if name == "source":
            columns[name] = [SOURCE_VALUES[i] for i in values]
        elif name in ("lat", "lon", "intensity"):
            columns[name] = np.round(values.astype(np.float64), decimals).tolist()
        else:
            columns[name] = np.rint(values).astype(np.int64).tolist()
    document = {
        "schema_version": SCHEMA_VERSION,
        "start": chunk.start.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "columns": columns,
    }
    return json.dumps(document, separators=(",", ":")).encode()


def chunk_name(start: datetime) -> str:
    return f"chunks/{start.strftime('%Y%m%dT%H%M%SZ')}.bin.gz"
