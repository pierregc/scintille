"""Blends geostationary disks into cloud opacity on a latitude-longitude grid (ADR 0022)."""

import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from . import geos
from .disk import Disk, bilinear, block_mean
from .texture import OPACITY_KELVIN, smoothstep

Array = NDArray[np.float32]

LAPSE_KELVIN_PER_KM = 6.5
MAX_HEIGHT_KM = 15.0
HEIGHT_CELL_KM = 16.0
"""Cloud-top heights for parallax are smoothed to about this size."""
VIEW_FADE = (math.cos(math.radians(84)), math.cos(math.radians(78)))
"""Each disk fades out between these view zenith cosines; beyond, the fallback mosaic fills in."""
VIEW_POWER = 4
DAY = (math.cos(math.radians(87)), math.cos(math.radians(77)))
FINE_KM = 1.5
PARALLAX_STEP_M = 10_000.0


@dataclass(frozen=True)
class Satellite:
    """One satellite's channels for a frame, and its smoothed cloud-top heights for parallax."""

    infrared: Disk
    visible: Disk | None
    heights: Disk

    @property
    def name(self) -> str:
        return self.infrared.satellite


SkinAt = Callable[[NDArray[np.float64], NDArray[np.float64]], Array]


def heights(infrared: Disk, skin_at: SkinAt) -> Disk:
    """Cloud-top height (km) from the cooling below the surface temperature, on a coarse grid,
    smoothed so parallax shifts vary slowly."""
    factor = max(1, round(HEIGHT_CELL_KM / infrared.resolution_km))
    grid = infrared.grid.coarsened(factor)
    bt = np.empty((grid.rows, grid.cols), np.float32)
    strip = factor * 64
    for start in range(0, grid.rows * factor, strip):
        values = np.asarray(infrared.values[start : start + strip], np.float32)
        bt[start // factor : (start + strip) // factor] = block_mean(
            np.nan_to_num(values, nan=np.inf), factor
        )
    rows, cols = np.meshgrid(np.arange(grid.rows), np.arange(grid.cols), indexing="ij")
    lat, lon = geos.ground(
        *grid.angles(rows.astype(np.float64), cols.astype(np.float64)), infrared.view
    )
    seen = np.isfinite(lat)
    skin = np.full(lat.shape, np.nan, np.float32)
    skin[seen] = skin_at(lat[seen], lon[seen])
    with np.errstate(invalid="ignore"):
        cooling = np.clip((skin - bt) / LAPSE_KELVIN_PER_KM, 0, MAX_HEIGHT_KM)
    h = np.asarray(np.nan_to_num(cooling, nan=0.0, posinf=0.0, neginf=0.0), np.float32)
    return Disk(infrared.satellite, "bt", infrared.view, grid, _box3(h), HEIGHT_CELL_KM)


def _box3(values: Array) -> Array:
    padded = np.pad(values, 1, mode="edge")
    total = np.zeros_like(values)
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            total += padded[1 + dr : padded.shape[0] - 1 + dr, 1 + dc : padded.shape[1] - 1 + dc]
    total /= 9
    return total


@dataclass(frozen=True)
class Fields:
    """Blended observations on the output grid."""

    bt: Array
    """Kelvin; NaN where no disk sees the pixel."""
    reflectance: Array
    """Reflectance factor; NaN where no visible channel sees the pixel."""
    coverage: Array
    """0 to 1: how well the best disk sees the pixel."""
    fine: Array
    """0 to 1: share of the opacity carried by sources of about 1 km."""


def blend(
    lat: NDArray[np.float64], lon: NDArray[np.float64], satellites: Sequence[Satellite]
) -> Fields:
    """Parallax-corrected, view-angle weighted blend of every disk at `lat`, `lon` (2-D)."""
    shape = lat.shape
    bt_sum = np.zeros(shape, np.float32)
    bt_weight = np.zeros(shape, np.float32)
    fine_ir = np.zeros(shape, np.float32)
    refl_sum = np.zeros(shape, np.float32)
    refl_weight = np.zeros(shape, np.float32)
    coverage = np.zeros(shape, np.float32)
    for sat in satellites:
        x0, y0, cos_vza = geos.scan_angles(lat, lon, 0.0, sat.infrared.view)
        if not np.any(cos_vza > VIEW_FADE[0]):
            continue
        # Scan angles move almost linearly with height over the first tens of kilometres.
        x1, y1, _ = geos.scan_angles(lat, lon, PARALLAX_STEP_M, sat.infrared.view)
        dx, dy = (x1 - x0) / PARALLAX_STEP_M, (y1 - y0) / PARALLAX_STEP_M
        x, y = x0, y0
        for _ in range(2):
            h = np.nan_to_num(sat.heights.sample(*sat.heights.grid.index(x, y)), nan=0.0) * 1e3
            x, y = x0 + h * dx, y0 + h * dy
        edge = smoothstep(*VIEW_FADE, cos_vza)
        weight = (np.clip(cos_vza, 0, 1) ** VIEW_POWER * edge).astype(np.float32)
        bt = sat.infrared.sample(*sat.infrared.grid.index(x, y))
        seen = np.isfinite(bt) & (bt > 150) & (bt < 350) & (weight > 0)
        w = np.where(seen, weight, 0)
        bt_sum += np.where(seen, bt, 0) * w
        bt_weight += w
        if sat.infrared.resolution_km <= FINE_KM:
            fine_ir += w
        coverage = np.maximum(coverage, np.where(seen, edge, 0))
        if sat.visible is not None:
            refl = sat.visible.sample(*sat.visible.grid.index(x, y))
            ok = np.isfinite(refl) & (weight > 0)
            wv = np.where(ok, weight, 0)
            refl_sum += np.where(ok, refl, 0) * wv
            refl_weight += wv
    with np.errstate(invalid="ignore", divide="ignore"):
        bt = np.where(bt_weight > 0, bt_sum / bt_weight, np.nan).astype(np.float32)
        refl = np.where(refl_weight > 0, refl_sum / refl_weight, np.nan).astype(np.float32)
        fine = np.where(bt_weight > 0, fine_ir / bt_weight, 0).astype(np.float32)
    return Fields(bt, refl, coverage, fine)


DETAIL_LIMITS = (0.5, 1.6)
"""Bounds of the visible detail ratio applied to the infrared opacity."""


def detail_ratio(reflectance: Array) -> Array:
    """Visible brightness over its smoothed value at the infrared scale: above 1 on the bright
    side of an edge, below on the dark side; 1 where there is no visible data."""
    filled = np.where(np.isfinite(reflectance), reflectance, 0).astype(np.float32)
    known = np.isfinite(reflectance).astype(np.float32)
    smooth = _binomial5(filled)
    weight = _binomial5(known)
    with np.errstate(invalid="ignore", divide="ignore"):
        local = smooth / weight
        ratio = reflectance / np.maximum(local, 0.02)
    out: Array = np.nan_to_num(np.clip(ratio, *DETAIL_LIMITS), nan=1.0).astype(np.float32)
    return out


def _binomial5(values: Array) -> Array:
    kernel = np.array([1, 4, 6, 4, 1], np.float32) / 16
    padded = np.pad(values, 2, mode="edge")
    rows = np.zeros((values.shape[0], padded.shape[1]), np.float32)
    for i, k in enumerate(kernel):
        rows += k * padded[i : i + values.shape[0], :]
    out = np.zeros_like(values, dtype=np.float32)
    for i, k in enumerate(kernel):
        out += k * rows[:, i : i + values.shape[1]]
    return out


def opacity(
    fields: Fields, skin: Array, cos_sun: Array, fallback: Array | None = None
) -> tuple[Array, Array]:
    """Cloud opacity (0 clear, 1 opaque) and the share of it resolved at about 1 km. The infrared
    sets how much cloud there is; by day, the visible channel adds its finer detail."""
    infrared = np.nan_to_num(smoothstep(*OPACITY_KELVIN, skin - fields.bt), nan=0.0)
    day = smoothstep(*DAY, cos_sun)
    ratio = detail_ratio(fields.reflectance)
    value = np.clip(infrared * (1 + day * (ratio - 1)), 0, 1)
    fine = np.maximum(fields.fine, np.where(np.isfinite(fields.reflectance), day, 0))
    if fallback is not None:
        value = fields.coverage * value + (1 - fields.coverage) * fallback
        fine *= fields.coverage
    return value.astype(np.float32), fine.astype(np.float32)


def sample_grid(values: Array, lat: NDArray[np.float64], lon: NDArray[np.float64]) -> Array:
    """Equirectangular global field (rows north to south from 90°, columns from -180°) at points."""
    n_rows, n_cols = values.shape
    rows = (90 - lat) / 180 * n_rows - 0.5
    cols = ((lon + 180) / 360 * n_cols - 0.5) % n_cols
    padded = np.concatenate([values, values[:, :1]], axis=1)
    return bilinear(padded, np.clip(rows, 0, n_rows - 1), cols)
