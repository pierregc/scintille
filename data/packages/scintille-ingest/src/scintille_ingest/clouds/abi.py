"""GOES ABI L1b full disk radiances (NOAA, AWS): band 2 reflectance and band 13 brightness."""

import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import netCDF4
import numpy as np
import obstore
from obstore.store import ObjectStore

from .disk import Allocate, Disk, block_mean, in_memory, planck_bt
from .geos import Grid, View

VISIBLE = "C02"
INFRARED = "C13"
STRIP_ROWS = 512

_NAME = re.compile(
    r"OR_ABI-L1b-RadF-M\dC(?P<band>\d\d)_G(?P<sat>\d\d)_s(?P<start>\d{13})\d_e\d{14}_c\d{14}\.nc$"
)


@dataclass(frozen=True)
class AbiFile:
    key: str
    band: str
    satellite: str
    start: datetime


def parse_key(key: str) -> AbiFile | None:
    match = _NAME.search(key)
    if match is None:
        return None
    start = datetime.strptime(match["start"], "%Y%j%H%M%S").replace(tzinfo=UTC)
    return AbiFile(key, f"C{match['band']}", f"goes{match['sat']}", start)


def hour_prefix(hour: datetime) -> str:
    return f"ABI-L1b-RadF/{hour:%Y/%j/%H}/"


def list_files(store: ObjectStore, start: datetime, end: datetime) -> list[AbiFile]:
    """Files of bands 2 and 13 starting in [start, end), oldest first."""
    found = []
    hour = start.replace(minute=0, second=0, microsecond=0)
    while hour < end:
        for batch in obstore.list(store, prefix=hour_prefix(hour)):
            for meta in batch:
                file = parse_key(meta["path"])
                if file and file.band in (VISIBLE, INFRARED) and start <= file.start < end:
                    found.append(file)
        hour += timedelta(hours=1)
    return sorted(found, key=lambda f: (f.start, f.band))


def read(path: Path, satellite: str, allocate: Allocate = in_memory) -> Disk:
    """Band 2 (0.5 km) becomes 1 km reflectance factor; band 13 stays 2 km brightness."""
    with netCDF4.Dataset(path) as ds:
        ds.set_auto_maskandscale(False)
        projection = ds["goes_imager_projection"]
        view = View(
            float(projection.longitude_of_projection_origin),
            float(projection.perspective_point_height),
            "x",
        )
        band = int(ds["band_id"][0])
        rad = ds["Rad"]
        scale, offset = np.float32(rad.scale_factor), np.float32(rad.add_offset)
        fill = int(rad._FillValue)
        x, y = ds["x"], ds["y"]
        grid = Grid(
            float(x.add_offset),
            float(x.scale_factor),
            float(y.add_offset),
            float(y.scale_factor),
            rad.shape[0],
            rad.shape[1],
        )
        visible = band == 2
        factor = 2 if visible else 1
        if visible:
            kappa0 = float(ds["kappa0"][()])
        else:
            constants = [
                float(ds[n][()]) for n in ("planck_fk1", "planck_fk2", "planck_bc1", "planck_bc2")
            ]
        out = allocate((grid.rows // factor, grid.cols // factor), np.float16)
        for start in range(0, grid.rows, STRIP_ROWS):
            counts = np.asarray(rad[start : start + STRIP_ROWS, :]).view(np.uint16)
            radiance = counts.astype(np.float32)
            radiance *= scale
            radiance += offset
            radiance[counts == fill] = np.nan
            if visible:
                radiance *= np.float32(kappa0)
                values = block_mean(radiance, factor)
            else:
                values = planck_bt(np.where(radiance > 0, radiance, np.nan), *constants)
            out[start // factor : start // factor + values.shape[0]] = values
    return Disk(
        satellite,
        "reflectance" if visible else "bt",
        view,
        grid.coarsened(factor) if factor > 1 else grid,
        out,
        1.0 if visible else 2.0,
    )
