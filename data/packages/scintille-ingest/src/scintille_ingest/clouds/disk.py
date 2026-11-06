"""A satellite channel on its scan grid, and how the composite samples it."""

from collections.abc import Callable, Sequence
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
    fine: tuple["Disk", ...] = ()
    """Windows of the channel at its native resolution, for the storm tiles (ADR 0037)."""

    def __reduce__(self) -> tuple[Any, ...]:
        """A memory-mapped disk travels to worker processes as its file name."""
        fields = (self.satellite, self.kind, self.view, self.grid)
        if isinstance(self.values, np.memmap) and self.values.filename:
            return _reopen, (*fields, str(self.values.filename), self.resolution_km, self.fine)
        return Disk, (*fields, self.values, self.resolution_km, self.fine)

    def sample(self, rows: NDArray[np.float64], cols: NDArray[np.float64]) -> NDArray[np.float32]:
        """Bilinear value at fractional pixel indices; NaN outside the grid or next to no data."""
        return bilinear(self.values, rows, cols)


def _reopen(
    satellite: str,
    kind: Kind,
    view: View,
    grid: Grid,
    path: str,
    resolution_km: float,
    fine: tuple[Disk, ...] = (),
) -> Disk:
    values: NDArray[np.floating] = np.lib.format.open_memmap(path, mode="r")
    return Disk(satellite, kind, view, grid, values, resolution_km, fine)


@dataclass(frozen=True)
class Window:
    """Rows `row0` to `row1` and columns `col0` to `col1` of a scan grid, ends excluded."""

    row0: int
    row1: int
    col0: int
    col1: int


Windows = Callable[[View, Grid], Sequence[Window]]
"""Where a reader keeps a channel at its native resolution, given its native scan grid."""


class Patches:
    """A channel's native values inside some windows, filled as a reader streams the disk."""

    def __init__(
        self,
        disk: tuple[str, Kind, View, Grid, float],
        windows: Sequence[Window],
        allocate: Allocate,
    ) -> None:
        satellite, kind, view, grid, resolution_km = disk
        self.parts: list[tuple[Window, Disk]] = []
        for w in windows:
            values = allocate((w.row1 - w.row0, w.col1 - w.col0), np.float16)
            values[:] = np.nan
            sub = Grid(
                grid.x0 + grid.dx * w.col0,
                grid.dx,
                grid.y0 + grid.dy * w.row0,
                grid.dy,
                w.row1 - w.row0,
                w.col1 - w.col0,
            )
            self.parts.append((w, Disk(satellite, kind, view, sub, values, resolution_km)))

    def write(self, row: int, col: int, values: NDArray[np.floating]) -> None:
        """Copies `values`, whose first pixel is at `row`, `col` of the native grid."""
        for w, disk in self.parts:
            r0, r1 = max(w.row0, row), min(w.row1, row + values.shape[0])
            c0, c1 = max(w.col0, col), min(w.col1, col + values.shape[1])
            if r0 < r1 and c0 < c1:
                disk.values[r0 - w.row0 : r1 - w.row0, c0 - w.col0 : c1 - w.col0] = values[
                    r0 - row : r1 - row, c0 - col : c1 - col
                ]

    @property
    def disks(self) -> tuple[Disk, ...]:
        return tuple(disk for _, disk in self.parts)


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
    # Flat gathers are about twice as fast as two-dimensional fancy indexing.
    flat = grid.reshape(-1)
    i = r0 * n_cols + c0
    top = np.take(flat, i) * (1 - fc) + np.take(flat, i + 1) * fc
    i += n_cols
    bottom = np.take(flat, i) * (1 - fc) + np.take(flat, i + 1) * fc
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
