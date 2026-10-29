"""MTG FCI L1c high resolution full disk (EUMETSAT Data Store): forty chunks a repeat cycle."""

import math
import re
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path

import netCDF4
import numpy as np

from .disk import Allocate, Disk, block_mean, in_memory
from .geos import Grid, View

COLLECTION = "EO:EUM:DAT:0665"
VISIBLE = "vis_06_hr"
INFRARED = "ir_105_hr"
AU_KM = 149_597_870.7
CHUNKS = 40
STRIP_ROWS = 128

_SENSING = re.compile(r"_OPE_(?P<start>\d{14})_\d{14}_")


def product_start(product_id: str) -> datetime:
    """Sensing start of a repeat cycle product, from its identifier."""
    match = _SENSING.search(product_id)
    if match is None:
        raise ValueError(f"not an FCI product: {product_id}")
    return datetime.strptime(match["start"], "%Y%m%d%H%M%S").replace(tzinfo=UTC)


def is_body_chunk(entry: str) -> bool:
    return "-CHK-BODY-" in entry and entry.endswith(".nc")


def read(chunks: Iterable[Path], channel: str, allocate: Allocate = in_memory) -> Disk:
    """`vis_06_hr` (0.5 km) becomes 1 km reflectance factor; `ir_105_hr` stays 1 km brightness
    temperature. Missing chunks stay NaN."""
    visible = channel == VISIBLE
    factor = 2 if visible else 1
    out = None
    for path in chunks:
        with netCDF4.Dataset(path) as ds:
            ds.set_auto_maskandscale(False)
            group = ds[f"data/{channel}/measured"]
            if out is None:
                projection = ds["data/mtg_geos_projection"]
                view = View(
                    float(projection.longitude_of_projection_origin),
                    float(projection.perspective_point_height),
                    "y",
                )
                x, y = group["x"], group["y"]
                size = x.shape[0]
                # The file's x angle grows westward; ours grows eastward.
                grid = Grid(
                    -(float(x.add_offset) + float(x.scale_factor)),
                    -float(x.scale_factor),
                    float(y.add_offset) + float(y.scale_factor),
                    float(y.scale_factor),
                    size,
                    size,
                )
                out = allocate((size // factor, size // factor), np.float16)
                out[:] = np.nan
            radiance_var = group["effective_radiance"]
            fill = int(radiance_var._FillValue)
            scale = np.float32(radiance_var.scale_factor)
            offset = np.float32(radiance_var.add_offset)
            if visible:
                distance = (
                    float(np.nanmean(_valid(ds["state/celestial/earth_sun_distance"][:]))) / AU_KM
                )
                irradiance = float(group["channel_effective_solar_irradiance"][()])
                to_reflectance = np.float32(math.pi * distance**2 / irradiance)
            first_row = int(group["start_position_row"][()]) - 1
            first_col = int(group["start_position_column"][()]) - 1
            for start in range(0, radiance_var.shape[0], STRIP_ROWS):
                counts = np.asarray(radiance_var[start : start + STRIP_ROWS])
                radiance = counts.astype(np.float32)
                radiance *= scale
                radiance += offset
                radiance[counts == fill] = np.nan
                if visible:
                    radiance *= to_reflectance
                    values = block_mean(radiance, factor)
                else:
                    values = _brightness(radiance, group)
                top, left = (first_row + start) // factor, first_col // factor
                out[top : top + values.shape[0], left : left + values.shape[1]] = values
    if out is None:
        raise ValueError("no FCI chunk")
    return Disk(
        "mtg-i1",
        "reflectance" if visible else "bt",
        view,
        grid.coarsened(factor) if factor > 1 else grid,
        out,
        1.0,
    )


def _valid(values: np.ndarray) -> np.ndarray:
    return np.where(np.abs(values) < 1e30, values, np.nan)


def _brightness(radiance: np.ndarray, group: netCDF4.Group) -> np.ndarray:
    wavenumber = float(group["radiance_to_bt_conversion_coefficient_wavenumber"][()])
    a = float(group["radiance_to_bt_conversion_coefficient_a"][()])
    b = float(group["radiance_to_bt_conversion_coefficient_b"][()])
    c1 = float(group["radiance_to_bt_conversion_constant_c1"][()])
    c2 = float(group["radiance_to_bt_conversion_constant_c2"][()])
    with np.errstate(divide="ignore", invalid="ignore"):
        bt = c2 * wavenumber / (a * np.log(1 + c1 * wavenumber**3 / radiance)) - b / a
    return np.where(radiance > 0, bt, np.nan).astype(np.float32)
