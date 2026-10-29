"""Geostationary scan geometry: from latitude, longitude and height to scan angles and back."""

from dataclasses import dataclass
from typing import Literal

import numpy as np
from numpy.typing import NDArray

Array = NDArray[np.float64]

A = 6378137.0
B = 6356752.31414
E2 = 1 - (B / A) ** 2


@dataclass(frozen=True)
class View:
    """Satellite at `lon` degrees, `height` metres above the equator; `sweep` as in PROJ `geos`."""

    lon: float
    height: float
    sweep: Literal["x", "y"]

    @property
    def radius(self) -> float:
        return A + self.height


@dataclass(frozen=True)
class Grid:
    """Scan angles of pixel centres: `x0 + dx * column`, `y0 + dy * row` (radians)."""

    x0: float
    dx: float
    y0: float
    dy: float
    rows: int
    cols: int

    def index(self, x: Array, y: Array) -> tuple[Array, Array]:
        """Fractional row and column of scan angles."""
        return (y - self.y0) / self.dy, (x - self.x0) / self.dx

    def angles(self, rows: Array, cols: Array) -> tuple[Array, Array]:
        return self.x0 + self.dx * cols, self.y0 + self.dy * rows

    def coarsened(self, factor: int) -> "Grid":
        """The grid of `factor` by `factor` block means."""
        return Grid(
            self.x0 + self.dx * (factor - 1) / 2,
            self.dx * factor,
            self.y0 + self.dy * (factor - 1) / 2,
            self.dy * factor,
            self.rows // factor,
            self.cols // factor,
        )


def ecef(lat: Array, lon: Array, height: Array | float, view: View) -> tuple[Array, Array, Array]:
    """Earth-centred coordinates in metres, x towards the satellite's longitude."""
    phi = np.radians(lat)
    lam = np.radians(lon - view.lon)
    sin_phi = np.sin(phi)
    n = A / np.sqrt(1 - E2 * sin_phi * sin_phi)
    horizontal = (n + height) * np.cos(phi)
    return horizontal * np.cos(lam), horizontal * np.sin(lam), (n * (1 - E2) + height) * sin_phi


def scan_angles(
    lat: Array, lon: Array, height: Array | float, view: View
) -> tuple[Array, Array, Array]:
    """Scan angles (x east, y north, radians) and the cosine of the view zenith angle, which is
    negative where the point faces away from the satellite."""
    px, py, pz = ecef(lat, lon, height, view)
    tx = view.radius - px
    if view.sweep == "x":
        x = np.arctan(py / np.hypot(pz, tx))
        y = np.arctan(pz / tx)
    else:
        x = np.arctan(py / tx)
        y = np.arctan(pz / np.hypot(py, tx))
    phi = np.radians(lat)
    lam = np.radians(lon - view.lon)
    up = (np.cos(phi) * np.cos(lam), np.cos(phi) * np.sin(lam), np.sin(phi))
    distance = np.sqrt(tx * tx + py * py + pz * pz)
    cos_vza = (up[0] * tx - up[1] * py - up[2] * pz) / distance
    return x, y, cos_vza


def ground(x: Array, y: Array, view: View) -> tuple[Array, Array]:
    """Latitude and longitude seen at scan angles; NaN off the Earth."""
    if view.sweep == "x":
        dx, dz = np.tan(x) / np.cos(y), np.tan(y)
    else:
        dx, dz = np.tan(x), np.tan(y) / np.cos(x)
    # Ray from the satellite: (R - t, t * dx, t * dz), intersected with the ellipsoid.
    k = (A / B) ** 2
    a = 1 + dx * dx + k * dz * dz
    b = -2 * view.radius
    c = view.radius**2 - A * A
    disc = b * b - 4 * a * c
    with np.errstate(invalid="ignore"):
        t = (-b - np.sqrt(disc)) / (2 * a)
    px, py, pz = view.radius - t, t * dx, t * dz
    lon = np.degrees(np.arctan2(py, px)) + view.lon
    lat = np.degrees(np.arctan2(pz, (1 - E2) * np.hypot(px, py)))
    lat = np.where(disc >= 0, lat, np.nan)
    lon = np.where(disc >= 0, (lon + 180) % 360 - 180, np.nan)
    return lat, lon
