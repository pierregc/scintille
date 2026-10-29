"""Renders a composite frame: detail tiles per level, and the global textures of the contract."""

import io
import multiprocessing
from collections.abc import Iterator
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field
from functools import cached_property

import numpy as np
from numpy.typing import NDArray
from PIL import Image

from . import composite, tiles
from .disk import bilinear
from .gmgsi import Mosaic
from .profile import HeightTable, lapse_heights
from .sun import cos_zenith
from .texture import FADE_LATITUDES, OPACITY_KELVIN, TIERS, WEBP_QUALITY, smoothstep
from .tiles import BORDER, TILE, Key

Array = NDArray[np.float32]
STRIP = 256
FINE_SHARE = 0.25
"""A level 5 tile is rendered where at least this share of its area has about 1 km sources."""


@dataclass(frozen=True)
class Inputs:
    satellites: tuple[composite.Satellite, ...]
    skin: Array
    """GFS skin temperature, 0.25°, rows from 90° N, columns from 0° E."""
    subsolar: tuple[float, float]
    fallback: Mosaic | None = None
    """Coarser global mosaic for what no disk sees well."""
    profile: HeightTable | None = None
    """Cloud-top heights from the GFS temperature profile; without it, from the skin."""

    @cached_property
    def _skin_wrapped(self) -> Array:
        return np.ascontiguousarray(np.concatenate([self.skin, self.skin[:, :1]], axis=1))

    @cached_property
    def _fallback_wrapped(self) -> Array | None:
        if self.fallback is None:
            return None
        bt = self.fallback.bt
        return np.ascontiguousarray(np.concatenate([bt, bt[:, :1]], axis=1))

    def skin_at(self, lat: NDArray[np.float64], lon: NDArray[np.float64]) -> Array:
        rows = np.clip((90 - lat) / 0.25, 0, self.skin.shape[0] - 1)
        cols = np.mod(lon, 360) / 0.25
        return bilinear(self._skin_wrapped, rows, cols)

    def top_at(self, bt: Array, lat: NDArray[np.float64], lon: NDArray[np.float64]) -> Array:
        if self.profile is not None:
            return self.profile.at(bt, lat, lon)
        return lapse_heights(bt, self.skin_at(lat, lon))

    def fallback_bt_at(self, lat: NDArray[np.float64], lon: NDArray[np.float64]) -> Array | None:
        mosaic, wrapped = self.fallback, self._fallback_wrapped
        if mosaic is None or wrapped is None:
            return None
        rows = np.interp(-lat, -mosaic.lat, np.arange(mosaic.lat.size, dtype=np.float64))
        step = (mosaic.lon[-1] - mosaic.lon[0]) / (mosaic.lon.size - 1)
        cols = np.mod((lon - mosaic.lon[0]) / step, mosaic.lon.size)
        bt = bilinear(wrapped, rows, cols)
        bt[(lat > mosaic.lat.max()) | (lat < mosaic.lat.min())] = np.nan
        return bt

    def fallback_at(
        self, lat: NDArray[np.float64], lon: NDArray[np.float64], skin: Array | None = None
    ) -> Array | None:
        bt = self.fallback_bt_at(lat, lon)
        if bt is None:
            return None
        surface = self.skin_at(lat, lon) if skin is None else skin
        return np.nan_to_num(smoothstep(*OPACITY_KELVIN, surface - bt), nan=0.0)


def area(
    inputs: Inputs,
    lat: NDArray[np.float64],
    lon: NDArray[np.float64],
    visible: bool,
    tops: bool = False,
) -> tuple[Array, Array, Array | None]:
    """Opacity, fine share and, with `tops`, cloud-top height (km) on the grid of `lat` by `lon`.
    Without `visible`, infrared only."""
    opacity = np.empty((lat.size, lon.size), np.float32)
    fine = np.empty_like(opacity)
    height = np.empty_like(opacity) if tops else None
    satellites = (
        inputs.satellites
        if visible
        else tuple(composite.Satellite(s.infrared, None, s.heights) for s in inputs.satellites)
    )
    step = lat.size if visible else STRIP
    for start in range(0, lat.size, step):
        la, lo = np.meshgrid(lat[start : start + step], lon, indexing="ij")
        fields = composite.blend(la, lo, satellites)
        cos_sun = cos_zenith(la, lo, inputs.subsolar)
        skin = inputs.skin_at(la, lo)
        # Most of the globe is seen well by some disk: the fallback is only sampled where needed.
        partial = np.any(fields.coverage < 1)
        fallback_bt = inputs.fallback_bt_at(la, lo) if partial else None
        fallback = (
            np.nan_to_num(smoothstep(*OPACITY_KELVIN, skin - fallback_bt), nan=0.0)
            if fallback_bt is not None
            else None
        )
        value, share = composite.opacity(fields, skin, cos_sun, fallback)
        if not visible:
            daylight = smoothstep(*composite.DAY, cos_sun) * fields.coverage
            share = np.maximum(share, daylight)
        value *= smoothstep(FADE_LATITUDES[1], FADE_LATITUDES[0], np.abs(la))
        opacity[start : start + step] = value
        fine[start : start + step] = share
        if height is not None:
            bt = fields.bt
            if fallback_bt is not None:
                bt = np.where(np.isfinite(bt), bt, fallback_bt)
            height[start : start + step] = inputs.top_at(bt, la, lo)
    return opacity, fine, height


@dataclass
class Block:
    """The tiles of one level 3 tile and everything under it."""

    tiles: dict[Key, bytes] = field(default_factory=dict)
    heights: dict[Key, bytes] = field(default_factory=dict)
    """Cloud-top height tiles of levels 3 and 4 (ADR 0028)."""
    overview: NDArray[np.uint8] | None = None
    """The level 3 tile without its border, for the global textures."""


def block(inputs: Inputs, x3: int, y3: int) -> Block:
    """Levels 4 and 3 from infrared at about 2 km, then level 5 where finer sources exist."""
    out = Block()
    margin4 = 2 * BORDER
    lat4, lon4 = tiles.centers(4, 2 * x3, 2 * y3, margin4, count=2)
    op4, fine4, h4 = area(inputs, lat4, lon4, visible=False, tops=True)
    assert h4 is not None
    h4 = composite.fill_tops(h4, op4)
    for dy in range(2):
        for dx in range(2):
            top, left = margin4 - BORDER + dy * TILE, margin4 - BORDER + dx * TILE
            if tiles.in_band(4, 2 * y3 + dy):
                key = Key(4, 2 * y3 + dy, 2 * x3 + dx)
                crop = np.s_[top : top + TILE + 2 * BORDER, left : left + TILE + 2 * BORDER]
                out.tiles[key] = tiles.encode(op4[crop])
                out.heights[key] = tiles.encode_height(h4[crop])
    op3 = _half(op4)
    weight = op4 + 0.02
    h3 = _half(h4 * weight) / _half(weight)
    out.tiles[Key(3, y3, x3)] = tiles.encode(op3)
    out.heights[Key(3, y3, x3)] = tiles.encode_height(h3)
    out.overview = (np.clip(op3[BORDER:-BORDER, BORDER:-BORDER], 0, 1) * 255 + 0.5).astype(np.uint8)
    quarter = TILE // 2
    for dy in range(4):
        for dx in range(4):
            share = fine4[
                margin4 + dy * quarter : margin4 + (dy + 1) * quarter,
                margin4 + dx * quarter : margin4 + (dx + 1) * quarter,
            ]
            if not tiles.in_band(5, 4 * y3 + dy) or share.mean() < FINE_SHARE:
                continue
            lat5, lon5 = tiles.centers(5, 4 * x3 + dx, 4 * y3 + dy, BORDER + 2)
            op5, _, _ = area(inputs, lat5, lon5, visible=True)
            out.tiles[Key(5, 4 * y3 + dy, 4 * x3 + dx)] = tiles.encode(op5[2:-2, 2:-2])
    return out


def _half(values: Array) -> Array:
    """Means of 2 by 2 blocks."""
    out: Array = values.reshape(values.shape[0] // 2, 2, values.shape[1] // 2, 2).mean(axis=(1, 3))
    return out


_inputs: Inputs | None = None


def _init(inputs: Inputs) -> None:
    global _inputs
    _inputs = inputs


def _block(xy: tuple[int, int]) -> tuple[tuple[int, int], Block]:
    assert _inputs is not None
    return xy, block(_inputs, *xy)


def blocks(inputs: Inputs, workers: int = 1) -> Iterator[tuple[tuple[int, int], Block]]:
    """Every level 3 block in the latitude band; `workers` processes share the mapped disks."""
    todo = [(k.x, k.y) for k in tiles.band_keys(3)]
    if workers <= 1:
        for xy in todo:
            yield xy, block(inputs, *xy)
        return
    context = multiprocessing.get_context("spawn")
    with ProcessPoolExecutor(workers, context, initializer=_init, initargs=(inputs,)) as pool:
        yield from pool.map(_block, todo)


@dataclass
class Rendered:
    tiles: dict[Key, bytes]
    textures: dict[str, bytes]
    """Global WebP per tier, as published by the infrared mosaic before."""
    heights: dict[Key, bytes] = field(default_factory=dict)


def frame(inputs: Inputs, workers: int = 1) -> Rendered:
    mosaic = np.zeros((tiles.rows(3) * TILE, tiles.columns(3) * TILE), np.uint8)
    all_tiles: dict[Key, bytes] = {}
    all_heights: dict[Key, bytes] = {}
    for (x3, y3), result in blocks(inputs, workers):
        all_tiles.update(result.tiles)
        all_heights.update(result.heights)
        assert result.overview is not None
        mosaic[y3 * TILE : (y3 + 1) * TILE, x3 * TILE : (x3 + 1) * TILE] = result.overview
    return Rendered(all_tiles, global_textures(mosaic), all_heights)


def global_textures(mosaic: NDArray[np.uint8]) -> dict[str, bytes]:
    image = Image.fromarray(mosaic, "L")
    out = {}
    for tier, width in TIERS.items():
        buffer = io.BytesIO()
        image.resize((width, width // 2), Image.Resampling.LANCZOS).save(
            buffer, "WEBP", quality=WEBP_QUALITY, method=6
        )
        out[tier] = buffer.getvalue()
    return out
