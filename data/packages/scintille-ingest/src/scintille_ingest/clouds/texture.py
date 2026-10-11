"""Cloud opacity on an equirectangular grid, and its WebP encoding per quality tier."""

import io

import numpy as np
from numpy.typing import NDArray
from PIL import Image

from .gfs import SkinTemperature
from .gmgsi import Mosaic

OPACITY_KELVIN = (4.0, 32.0)
"""Opacity ramps from 0 to 1 as the cloud top gets this much colder than the surface."""
FADE_LATITUDES = (68.0, 72.7)
TIERS = {"2k": 2048, "4k": 4096}
WEBP_QUALITY = 70


def smoothstep(e0: float, e1: float, x: NDArray[np.floating]) -> NDArray[np.float32]:
    t: NDArray[np.float32] = np.clip((x - e0) / (e1 - e0), 0, 1).astype(np.float32)
    return t * t * (3 - 2 * t)


def pixel_centers(width: int) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    """Latitudes (north to south) and longitudes (west to east) of an equirectangular grid."""
    height = width // 2
    lat = 90 - (np.arange(height) + 0.5) * 180 / height
    lon = -180 + (np.arange(width) + 0.5) * 360 / width
    return lat, lon


def _bilinear(
    grid: NDArray[np.float32], rows: NDArray[np.float64], cols: NDArray[np.float64], wrap: bool
) -> NDArray[np.float32]:
    """Samples `grid` at fractional row (per output row) and column (per output column) indices."""
    n_rows, n_cols = grid.shape
    r0 = np.clip(np.floor(rows).astype(np.int64), 0, n_rows - 1)
    r1 = np.clip(r0 + 1, 0, n_rows - 1)
    fr = np.clip(rows - r0, 0, 1).astype(np.float32)[:, None]
    c0 = np.floor(cols).astype(np.int64)
    fc = (cols - c0).astype(np.float32)[None, :]
    if wrap:
        c0, c1 = c0 % n_cols, (c0 + 1) % n_cols
    else:
        c0 = np.clip(c0, 0, n_cols - 1)
        c1 = np.clip(c0 + 1, 0, n_cols - 1)
    top = grid[r0][:, c0] * (1 - fc) + grid[r0][:, c1] * fc
    bottom = grid[r1][:, c0] * (1 - fc) + grid[r1][:, c1] * fc
    return (top * (1 - fr) + bottom * fr).astype(np.float32)


def brightness_temperature(mosaic: Mosaic, width: int) -> NDArray[np.float32]:
    """Mosaic resampled to the grid; NaN outside its latitudes or where it has no data."""
    lat, lon = pixel_centers(width)
    rows = np.interp(-lat, -mosaic.lat, np.arange(mosaic.lat.size, dtype=np.float64))
    step = (mosaic.lon[-1] - mosaic.lon[0]) / (mosaic.lon.size - 1)
    cols = (lon - mosaic.lon[0]) / step
    bt = _bilinear(mosaic.bt, rows, cols, wrap=True)
    bt[(lat > mosaic.lat.max()) | (lat < mosaic.lat.min())] = np.nan
    return bt


def skin_temperature(skin: SkinTemperature, width: int) -> NDArray[np.float32]:
    lat, lon = pixel_centers(width)
    n_rows, n_cols = skin.values.shape
    rows = (90 - lat) / (180 / (n_rows - 1))
    cols = np.mod(lon, 360) / (360 / n_cols)
    return _bilinear(skin.values, rows, cols, wrap=True)


def opacity(mosaic: Mosaic, skin: SkinTemperature, width: int) -> NDArray[np.float32]:
    """0 clear to 1 opaque; 0 without data, fading out towards the mosaic's polar edges."""
    bt = brightness_temperature(mosaic, width)
    lat, _ = pixel_centers(width)
    value = smoothstep(*OPACITY_KELVIN, skin_temperature(skin, width) - bt)
    value *= smoothstep(FADE_LATITUDES[1], FADE_LATITUDES[0], np.abs(lat))[:, None]
    return np.nan_to_num(value, nan=0.0)


def encode_tiers(value: NDArray[np.float32]) -> dict[str, bytes]:
    """Grayscale WebP per tier (0 clear, 255 opaque), downsampled from the full-size grid."""
    image = Image.fromarray((np.clip(value, 0, 1) * 255 + 0.5).astype(np.uint8), "L")
    out = {}
    for tier, width in TIERS.items():
        sized = (
            image
            if image.width == width
            else image.resize((width, width // 2), Image.Resampling.LANCZOS)
        )
        buffer = io.BytesIO()
        sized.save(buffer, "WEBP", quality=WEBP_QUALITY, method=6)
        out[tier] = buffer.getvalue()
    return out
