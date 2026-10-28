"""A satellite channel on its scan grid, and how the composite samples it."""

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import numpy as np
from numpy.typing import NDArray

from .geos import Grid, View

Kind = Literal["bt", "reflectance"]
Allocate = Callable[[tuple[int, int], type[np.floating]], NDArray[np.floating]]
"""Returns a writable array of that shape and type; memory-mapped files keep big disks off RAM."""


def in_memory(shape: tuple[int, int], dtype: type[np.floating]) -> NDArray[np.floating]:
    return np.empty(shape, dtype)


def mapped(directory: Path) -> Allocate:
    """Allocates `.npy` files in `directory`, numbered in order."""
    count = 0

    def allocate(shape: tuple[int, int], dtype: type[np.floating]) -> NDArray[np.floating]:
        nonlocal count
        count += 1
        array: NDArray[np.floating] = np.lib.format.open_memmap(
            directory / f"{count:03d}.npy", mode="w+", dtype=dtype, shape=shape
        )
        return array

    return allocate


@dataclass(frozen=True)
class Disk:
    """Brightness temperature (K) or reflectance factor of one channel; NaN where unknown."""

    satellite: str
    kind: Kind
    view: View
    grid: Grid
    values: NDArray[np.floating]
    resolution_km: float
    """Sampling distance at the sub-satellite point."""

    def __reduce__(self) -> tuple[Any, ...]:
        """A memory-mapped disk travels to worker processes as its file name."""
        fields = (self.satellite, self.kind, self.view, self.grid)
        if isinstance(self.values, np.memmap) and self.values.filename:
            return _reopen, (*fields, str(self.values.filename), self.resolution_km)
        return Disk, (*fields, self.values, self.resolution_km)

    def sample(self, rows: NDArray[np.float64], cols: NDArray[np.float64]) -> NDArray[np.float32]:
        """Bilinear value at fractional pixel indices; NaN outside the grid or next to no data."""
        return bilinear(self.values, rows, cols)


def _reopen(
    satellite: str, kind: Kind, view: View, grid: Grid, path: str, resolution_km: float
) -> Disk:
    values: NDArray[np.floating] = np.lib.format.open_memmap(path, mode="r")
    return Disk(satellite, kind, view, grid, values, resolution_km)


def bilinear(
    grid: NDArray[np.floating], rows: NDArray[np.float64], cols: NDArray[np.float64]
) -> NDArray[np.float32]:
    n_rows, n_cols = grid.shape
    with np.errstate(invalid="ignore"):
        inside = (rows >= 0) & (rows <= n_rows - 1) & (cols >= 0) & (cols <= n_cols - 1)
    r = np.where(inside, rows, 0.0)
    c = np.where(inside, cols, 0.0)
    r0 = np.minimum(r.astype(np.int64), n_rows - 2)
    c0 = np.minimum(c.astype(np.int64), n_cols - 2)
    fr = (r - r0).astype(np.float32)
    fc = (c - c0).astype(np.float32)
    top = grid[r0, c0] * (1 - fc) + grid[r0, c0 + 1] * fc
    bottom = grid[r0 + 1, c0] * (1 - fc) + grid[r0 + 1, c0 + 1] * fc
    value: NDArray[np.float32] = (top * (1 - fr) + bottom * fr).astype(np.float32)
    value[~inside] = np.nan
    return value


def block_mean(values: NDArray[np.floating], factor: int) -> NDArray[np.float32]:
    """Mean of `factor` by `factor` blocks; NaN if any member is NaN."""
    rows, cols = values.shape[0] // factor, values.shape[1] // factor
    trimmed = values[: rows * factor, : cols * factor].astype(np.float32)
    return trimmed.reshape(rows, factor, cols, factor).mean(axis=(1, 3))


def planck_bt(
    radiance: NDArray[np.floating], fk1: float, fk2: float, bc1: float, bc2: float
) -> NDArray[np.float32]:
    """GOES-R form of the inverse Planck function with band correction."""
    with np.errstate(divide="ignore", invalid="ignore"):
        t = fk2 / np.log(fk1 / radiance + 1)
    return ((t - bc1) / bc2).astype(np.float32)
