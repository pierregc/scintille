"""NOAA GMGSI longwave IR mosaics: bucket layout, file names and brightness temperatures."""

import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import netCDF4
import numpy as np
import obstore
from numpy.typing import NDArray
from obstore.store import ObjectStore

BUCKET = "noaa-gmgsi-pds"
PREFIX = "GMGSI_LW"

_NAME = re.compile(
    r"GLOBCOMPLIR_v\w+_blend_s(?P<start>\d{14})\d_e\d{15}_c(?P<created>\d{14})\d\.nc$"
)


@dataclass(frozen=True)
class GmgsiProduct:
    key: str
    time: datetime
    """Nominal observation time, from the file name."""
    created: datetime
    last_modified: datetime | None = None
    etag: str | None = None

    @property
    def name(self) -> str:
        return self.key.rsplit("/", 1)[-1]


def _utc(stamp: str) -> datetime:
    return datetime.strptime(stamp, "%Y%m%d%H%M%S").replace(tzinfo=UTC)


def parse_key(key: str) -> GmgsiProduct | None:
    match = _NAME.search(key)
    if match is None:
        return None
    return GmgsiProduct(key, _utc(match["start"]), _utc(match["created"]))


def hour_prefix(hour: datetime) -> str:
    return f"{PREFIX}/{hour:%Y/%m/%d/%H}/"


def list_products(store: ObjectStore, now: datetime, hours: int) -> list[GmgsiProduct]:
    """Files of the last `hours` hour prefixes, oldest first; a revised hour keeps its newest."""
    latest: dict[datetime, GmgsiProduct] = {}
    for h in range(hours):
        for batch in obstore.list(store, prefix=hour_prefix(now - timedelta(hours=h))):
            for meta in batch:
                product = parse_key(meta["path"])
                if product is None:
                    continue
                product = GmgsiProduct(
                    product.key, product.time, product.created, meta["last_modified"], meta["e_tag"]
                )
                known = latest.get(product.time)
                if known is None or (product.created, product.key) > (known.created, known.key):
                    latest[product.time] = product
    return sorted(latest.values(), key=lambda p: p.time)


@dataclass(frozen=True)
class Mosaic:
    """Brightness temperatures on the GMGSI grid: rows north to south, columns west to east."""

    bt: NDArray[np.float32]
    """Kelvin; NaN where there is no data."""
    lat: NDArray[np.float64]
    """Row latitudes, decreasing (the grid is Mercator, so not evenly spaced)."""
    lon: NDArray[np.float64]
    """Column longitudes, increasing."""


def counts_to_kelvin(counts: NDArray[np.floating]) -> NDArray[np.float32]:
    """GMGSI 8-bit IR counts to brightness temperature (McIDAS IR scale)."""
    c = counts.astype(np.float32)
    return np.where(c <= 176, 330 - c / 2, 418 - c).astype(np.float32)


def read_mosaic(data: bytes) -> Mosaic:
    with netCDF4.Dataset("gmgsi.nc", memory=data) as ds:
        ds.set_auto_mask(False)
        counts = np.asarray(ds["data"][0], dtype=np.float32)
        dqf = np.asarray(ds["dqf"][0])
        lat = np.asarray(ds["lat"][:, 0], dtype=np.float64)
        lon = np.asarray(ds["lon"][0, :], dtype=np.float64)
    bt = counts_to_kelvin(counts)
    bt[(counts < 0) | (counts > 255) | (dqf < 0)] = np.nan
    order = np.argsort(lon, kind="stable")
    return Mosaic(bt[:, order], lat, lon[order])
