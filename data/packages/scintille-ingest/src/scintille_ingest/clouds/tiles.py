"""Detail tiles: equirectangular pyramid levels of about 4, 2 and 1 km (ADR 0023)."""

import base64
import io
from collections.abc import Iterable, Mapping
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray
from PIL import Image
from scintille_contract.cloud_archive import (
    DETAIL_BORDER,
    DETAIL_HEIGHT_LEVELS,
    DETAIL_HEIGHT_MAX_KM,
    DETAIL_LEVELS,
    DETAIL_TILE_SIZE,
)

TILE = DETAIL_TILE_SIZE
"""Texels per tile side, borders excluded."""
BORDER = DETAIL_BORDER
"""Texels copied from the neighbouring tiles on each side, so cubic filtering needs no neighbour."""
LEVELS = tuple(DETAIL_LEVELS)
FINE_LEVEL = LEVELS[-1]
HEIGHT_LEVELS = tuple(DETAIL_HEIGHT_LEVELS)
HEIGHT_MAX_KM = float(DETAIL_HEIGHT_MAX_KM)
"""Height tiles map 0 to 255 onto 0 to this many km above sea level (ADR 0028)."""
MAX_LATITUDE = 72.7
WEBP_QUALITY = 75


@dataclass(frozen=True, order=True)
class Key:
    z: int
    y: int
    x: int

    @property
    def path(self) -> str:
        return f"{self.z}/{self.y}/{self.x}.webp"


def columns(z: int) -> int:
    return 1 << (z + 1)


def rows(z: int) -> int:
    return 1 << z


def texel_degrees(z: int) -> float:
    return 180 / (rows(z) * TILE)


def in_band(z: int, y: int) -> bool:
    """Whether tile row `y` reaches latitudes with data."""
    north = 90 - y * 180 / rows(z)
    south = north - 180 / rows(z)
    return bool(south < MAX_LATITUDE and north > -MAX_LATITUDE)


def band_keys(z: int) -> list[Key]:
    return [Key(z, y, x) for y in range(rows(z)) if in_band(z, y) for x in range(columns(z))]


def centers(
    z: int, x: int, y: int, margin: int, count: int = 1
) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    """Latitudes (north to south) and longitudes (west to east) of the texel centres of `count`
    tiles from (x, y), with `margin` extra texels on every side."""
    step = texel_degrees(z)
    index = np.arange(count * TILE + 2 * margin, dtype=np.float64) - margin + 0.5
    lat: NDArray[np.float64] = np.clip(90 - (y * TILE + index) * step, -90, 90)
    lon: NDArray[np.float64] = -180 + (x * TILE + index) * step
    return lat, lon


def encode(opacity: NDArray[np.floating]) -> bytes:
    image = Image.fromarray((np.clip(opacity, 0, 1) * 255 + 0.5).astype(np.uint8), "L")
    buffer = io.BytesIO()
    image.save(buffer, "WEBP", quality=WEBP_QUALITY, method=4)
    return buffer.getvalue()


def encode_height(km: NDArray[np.floating]) -> bytes:
    return encode(np.asarray(km, np.float32) / HEIGHT_MAX_KM)


def decode_height(data: bytes) -> NDArray[np.float32]:
    values = np.asarray(Image.open(io.BytesIO(data)).convert("L"), np.float32)
    return (values * np.float32(HEIGHT_MAX_KM / 255)).astype(np.float32)


def bitmap(keys: Iterable[Key], z: int) -> str:
    """Base64 of a bit per tile of level `z`, row-major from the north-west, least significant bit
    first."""
    bits = np.zeros(rows(z) * columns(z), np.uint8)
    for key in keys:
        if key.z == z:
            bits[key.y * columns(z) + key.x] = 1
    return base64.b64encode(np.packbits(bits, bitorder="little").tobytes()).decode()


def from_bitmap(encoded: str, z: int) -> set[Key]:
    bits = np.unpackbits(np.frombuffer(base64.b64decode(encoded), np.uint8), bitorder="little")
    return {Key(z, int(i) // columns(z), int(i) % columns(z)) for i in np.flatnonzero(bits)}


def index_slot(key: Key, levels: tuple[int, ...] = LEVELS) -> int:
    """Position of a tile in a pack index: levels in order, then rows, then columns."""
    before = sum(rows(z) * columns(z) for z in levels if z < key.z)
    return before + key.y * columns(key.z) + key.x


def slots(levels: tuple[int, ...]) -> int:
    return sum(rows(z) * columns(z) for z in levels)


INDEX_SLOTS = slots(LEVELS)
HEIGHT_SLOTS = slots(HEIGHT_LEVELS)


def pack(tiles: Mapping[Key, bytes], heights: Mapping[Key, bytes] | None = None) -> bytes:
    """One object per frame: an index of (offset, length) little-endian uint32 pairs, one per
    possible opacity tile (length 0 where absent); with `heights`, a second index of the same form
    for the height levels; then the WebP tiles back to back. Offsets count from the start."""
    index = np.zeros((INDEX_SLOTS, 2), "<u4")
    height_index = np.zeros((HEIGHT_SLOTS if heights is not None else 0, 2), "<u4")
    body = io.BytesIO()
    start = (INDEX_SLOTS + len(height_index)) * 8
    for key in sorted(tiles):
        data = tiles[key]
        index[index_slot(key)] = (start + body.tell(), len(data))
        body.write(data)
    for key in sorted(heights or {}):
        data = (heights or {})[key]
        height_index[index_slot(key, HEIGHT_LEVELS)] = (start + body.tell(), len(data))
        body.write(data)
    return index.tobytes() + height_index.tobytes() + body.getvalue()


def unpack(data: bytes, key: Key) -> bytes | None:
    offset, length = np.frombuffer(data, "<u4", 2, index_slot(key) * 8)
    return data[int(offset) : int(offset) + int(length)] if length else None


def unpack_height(data: bytes, key: Key) -> bytes | None:
    at = (INDEX_SLOTS + index_slot(key, HEIGHT_LEVELS)) * 8
    offset, length = np.frombuffer(data, "<u4", 2, at)
    return data[int(offset) : int(offset) + int(length)] if length else None
