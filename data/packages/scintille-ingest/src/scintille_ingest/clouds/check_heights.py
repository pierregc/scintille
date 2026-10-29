"""Compares our cloud-top heights with GOES ABI ACHA on the GOES-East disk (ADR 0028)."""

import json
from datetime import datetime
from pathlib import Path
from typing import Any

import netCDF4
import numpy as np
import obstore
from numpy.typing import NDArray
from obstore.store import ObjectStore

from . import abi, geos
from .gfs import SkinTemperature
from .profile import HeightTable, lapse_heights
from .texture import OPACITY_KELVIN, smoothstep

STEP = 4
"""Every fourth row and column of the 2 km grid."""


def latest(store: ObjectStore, prefix: str, slot: datetime) -> str:
    """The first file of `prefix` whose scan starts in the slot's hour, at or after it."""
    keys = sorted(m["path"] for batch in obstore.list(store, prefix=prefix) for m in batch)
    stamp = f"_s{slot:%Y%j%H}"
    found = [k for k in keys if stamp in k]
    if not found:
        raise FileNotFoundError(prefix)
    return found[0]


def fetch(store: ObjectStore, key: str, directory: Path) -> Path:
    path = directory / key.rsplit("/", 1)[-1]
    if not path.exists():
        path.write_bytes(obstore.get(store, key).bytes().to_bytes())
    return path


def acha(path: Path) -> NDArray[np.float32]:
    with netCDF4.Dataset(path) as ds:
        values = ds["HT"][:]
    return (np.ma.filled(values.astype(np.float32), np.nan) / 1000).astype(np.float32)


def compare(
    store: ObjectStore,
    slot: datetime,
    skin: SkinTemperature,
    table: HeightTable | None,
    directory: Path,
) -> dict[str, Any]:
    """Median absolute difference, bias and 90th percentile against ACHA, in km, for opaque
    pixels, then for low and high ACHA tops."""
    directory.mkdir(parents=True, exist_ok=True)
    keys = sorted(
        m["path"]
        for batch in obstore.list(store, prefix=f"ABI-L1b-RadF/{slot:%Y/%j/%H}/")
        for m in batch
        if "M6C13_G" in m["path"] and f"_s{slot:%Y%j%H}" in m["path"]
    )
    disk = abi.read(fetch(store, keys[0], directory), "goes19")
    reference = acha(
        fetch(store, latest(store, f"ABI-L2-ACHA2KMF/{slot:%Y/%j/%H}/", slot), directory)
    )
    rows = np.arange(0, disk.grid.rows, STEP)
    cols = np.arange(0, disk.grid.cols, STEP)
    rr, cc = np.meshgrid(rows, cols, indexing="ij")
    lat, lon = geos.ground(
        *disk.grid.angles(rr.astype(np.float64), cc.astype(np.float64)), disk.view
    )
    seen = np.isfinite(lat)
    bt = np.asarray(disk.values[::STEP, ::STEP], np.float32)[seen]
    truth = reference[::STEP, ::STEP][seen]
    la, lo = lat[seen], lon[seen]
    s_rows = np.clip((90 - la) / 0.25, 0, skin.values.shape[0] - 1).astype(np.intp)
    s_cols = (np.mod(lo, 360) / 0.25).astype(np.intp) % skin.values.shape[1]
    surface = skin.values[s_rows, s_cols]
    opaque = smoothstep(*OPACITY_KELVIN, surface - bt) >= 0.8
    methods = {"lapse": lapse_heights(bt, surface)}
    if table is not None:
        methods["profile"] = table.at(bt, la, lo)
    out: dict[str, Any] = {"slot": slot.isoformat(), "reference": table.label if table else None}
    valid = np.isfinite(truth) & np.isfinite(bt)
    subsets = {
        "opaque": valid & opaque,
        "opaque_low": valid & opaque & (truth < 3),
        "opaque_high": valid & opaque & (truth > 8),
        "all_cloudy": valid,
    }
    for name, mask in subsets.items():
        row: dict[str, Any] = {"pixels": int(mask.sum())}
        for method, km in methods.items():
            diff = km[mask] - truth[mask]
            row[method] = {
                "median_abs": round(float(np.median(np.abs(diff))), 2),
                "bias": round(float(np.median(diff)), 2),
                "p90_abs": round(float(np.percentile(np.abs(diff), 90)), 2),
            }
        out[name] = row
    return out


def report(results: list[dict[str, Any]]) -> str:
    return json.dumps(results, indent=1)
