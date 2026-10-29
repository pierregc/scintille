"""Himawari AHI full disk Himawari Standard Data (JMA via NOAA, AWS): ten bzip2 segments a band."""

import bz2
import re
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np
import obstore
from obstore.store import ObjectStore

from .disk import Allocate, Disk, block_mean, in_memory
from .geos import Grid, View

VISIBLE = "B03"
INFRARED = "B13"
SEGMENTS = 10
STRIP_ROWS = 256

_NAME = re.compile(
    r"HS_H(?P<sat>\d\d)_(?P<start>\d{8}_\d{4})_(?P<band>B\d\d)_FLDK_R\d\d_S(?P<segment>\d\d)10\.DAT\.bz2$"
)

_BLOCK1 = np.dtype(
    [
        ("number", "u1"),
        ("length", "<u2"),
        ("blocks", "<u2"),
        ("byte_order", "u1"),
        ("satellite", "S16"),
        ("centre", "S16"),
        ("area", "S4"),
        ("other", "S2"),
        ("timeline", "<u2"),
        ("start", "<f8"),
        ("end", "<f8"),
        ("created", "<f8"),
        ("header_length", "<u4"),
        ("data_length", "<u4"),
    ]
)
_BLOCK2 = np.dtype(
    [("number", "u1"), ("length", "<u2"), ("bits", "<u2"), ("cols", "<u2"), ("rows", "<u2")]
)
_BLOCK3 = np.dtype(
    [
        ("number", "u1"),
        ("length", "<u2"),
        ("sub_lon", "<f8"),
        ("cfac", "<u4"),
        ("lfac", "<u4"),
        ("coff", "<f4"),
        ("loff", "<f4"),
        ("distance", "<f8"),
    ]
)
_BLOCK5 = np.dtype(
    [
        ("number", "u1"),
        ("length", "<u2"),
        ("band", "<u2"),
        ("wavelength", "<f8"),
        ("valid_bits", "<u2"),
        ("error_count", "<u2"),
        ("outside_count", "<u2"),
        ("gain", "<f8"),
        ("offset", "<f8"),
        ("c0", "<f8"),
        ("c1", "<f8"),
        ("c2", "<f8"),
        ("c0_inverse", "<f8"),
        ("c1_inverse", "<f8"),
        ("c2_inverse", "<f8"),
        ("light_speed", "<f8"),
        ("planck", "<f8"),
        ("boltzmann", "<f8"),
    ]
)
_BLOCK5_VISIBLE = np.dtype(
    [
        ("number", "u1"),
        ("length", "<u2"),
        ("band", "<u2"),
        ("wavelength", "<f8"),
        ("valid_bits", "<u2"),
        ("error_count", "<u2"),
        ("outside_count", "<u2"),
        ("gain", "<f8"),
        ("offset", "<f8"),
        ("albedo", "<f8"),
        ("updated", "<f8"),
        ("gain_updated", "<f8"),
        ("offset_updated", "<f8"),
    ]
)
_BLOCK7 = np.dtype(
    [
        ("number", "u1"),
        ("length", "<u2"),
        ("segments", "u1"),
        ("segment", "u1"),
        ("first_row", "<u2"),
    ]
)


@dataclass(frozen=True)
class AhiFile:
    key: str
    band: str
    satellite: str
    start: datetime
    segment: int


def parse_key(key: str) -> AhiFile | None:
    match = _NAME.search(key)
    if match is None:
        return None
    start = datetime.strptime(match["start"], "%Y%m%d_%H%M").replace(tzinfo=UTC)
    return AhiFile(key, match["band"], f"himawari{match['sat']}", start, int(match["segment"]))


def slot_prefix(start: datetime) -> str:
    return f"AHI-L1b-FLDK/{start:%Y/%m/%d/%H%M}/"


def list_files(store: ObjectStore, start: datetime) -> list[AhiFile]:
    """Segments of bands 3 and 13 of the 10 minute slot starting at `start`."""
    found = []
    for batch in obstore.list(store, prefix=slot_prefix(start)):
        for meta in batch:
            file = parse_key(meta["path"])
            if file and file.band in (VISIBLE, INFRARED):
                found.append(file)
    return sorted(found, key=lambda f: (f.band, f.segment))


def slots(start: datetime, end: datetime) -> list[datetime]:
    first = start.replace(minute=start.minute - start.minute % 10, second=0, microsecond=0)
    out = []
    while first < end:
        if first >= start:
            out.append(first)
        first += timedelta(minutes=10)
    return out


def _blocks(header: bytes) -> dict[int, bytes]:
    blocks = {}
    position = 0
    while position < len(header):
        number = header[position]
        length = int.from_bytes(header[position + 1 : position + 3], "little")
        blocks[number] = header[position : position + length]
        position += length
    return blocks


def read(segments: Iterable[Path], satellite: str, allocate: Allocate = in_memory) -> Disk:
    """Band 3 (0.5 km) becomes 1 km reflectance factor; band 13 stays 2 km brightness temperature.
    `segments` are the compressed files of one band, in any order; missing ones stay NaN."""
    out = None
    for path in segments:
        data = bz2.decompress(path.read_bytes())
        first = np.frombuffer(data, _BLOCK1, 1)[0]
        header = data[: first["header_length"]]
        blocks = _blocks(header)
        info = np.frombuffer(blocks[2], _BLOCK2, 1)[0]
        nav = np.frombuffer(blocks[3], _BLOCK3, 1)[0]
        segment = np.frombuffer(blocks[7], _BLOCK7, 1)[0]
        rows, cols = int(info["rows"]), int(info["cols"])
        counts = np.frombuffer(data, "<u2", rows * cols, first["header_length"]).reshape(rows, cols)
        band = int(np.frombuffer(blocks[5], "<u2", 1, 3)[0])
        visible = band <= 6
        factor = 2 if band == 3 else 1
        if visible:
            cal = np.frombuffer(blocks[5], _BLOCK5_VISIBLE, 1)[0]
            gain = cal["gain_updated"] if cal["gain_updated"] > 0 else cal["gain"]
            offset = cal["offset_updated"] if cal["gain_updated"] > 0 else cal["offset"]
        else:
            cal = np.frombuffer(blocks[5], _BLOCK5, 1)[0]
            gain, offset = cal["gain"], cal["offset"]
        if out is None:
            total_rows = rows * int(segment["segments"])
            out = allocate((total_rows // factor, cols // factor), np.float16)
            out[:] = np.nan
            grid = _grid(nav, total_rows, cols)
            view = View(float(nav["sub_lon"]), float(nav["distance"]) * 1000 - 6378137.0, "y")
        top = (int(segment["first_row"]) - 1) // factor
        for start in range(0, rows, STRIP_ROWS):
            part = counts[start : start + STRIP_ROWS]
            radiance = part.astype(np.float32)
            radiance *= np.float32(gain)
            radiance += np.float32(offset)
            radiance[(part == cal["error_count"]) | (part == cal["outside_count"])] = np.nan
            if visible:
                radiance *= np.float32(cal["albedo"])
                values = block_mean(radiance, factor)
            else:
                values = _brightness(radiance.astype(np.float64), cal).astype(np.float32)
            row = top + start // factor
            out[row : row + values.shape[0]] = values
    if out is None:
        raise ValueError("no Himawari segment")
    return Disk(
        satellite,
        "reflectance" if visible else "bt",
        view,
        grid.coarsened(factor) if factor > 1 else grid,
        out,
        1.0 if visible else 2.0,
    )


def _grid(nav: np.void, rows: int, cols: int) -> Grid:
    """CGMS scaling: column c (from 1) is at x = (c - COFF) * 2^16 / CFAC degrees east, line l at
    y = -(l - LOFF) * 2^16 / LFAC degrees north."""
    dx = np.radians(2.0**16 / float(nav["cfac"]))
    dy = -np.radians(2.0**16 / float(nav["lfac"]))
    return Grid(
        float((1 - nav["coff"]) * dx),
        float(dx),
        float((1 - nav["loff"]) * dy),
        float(dy),
        rows,
        cols,
    )


def _brightness(radiance: np.ndarray, cal: np.void) -> np.ndarray:
    """Radiance (W m-2 sr-1 um-1) to brightness temperature, with JMA's band correction."""
    wavelength = cal["wavelength"] * 1e-6
    h, c, k = cal["planck"], cal["light_speed"], cal["boltzmann"]
    with np.errstate(divide="ignore", invalid="ignore"):
        te = (h * c / (k * wavelength)) / np.log(
            2 * h * c * c / (wavelength**5 * radiance * 1e6) + 1
        )
    bt: np.ndarray = cal["c0"] + cal["c1"] * te + cal["c2"] * te * te
    return bt
