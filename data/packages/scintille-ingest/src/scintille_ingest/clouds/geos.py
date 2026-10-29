"""Geostationary scan geometry: from latitude, longitude and height to scan angles and back."""

import math
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


@dataclass(frozen=True)
class Points:
    """Trigonometry of ground points, computed once and shared by every satellite and height."""

    sin_phi: Array
    cos_phi: Array
    sin_lon: Array
    cos_lon: Array
    normal: Array
    """Radius of curvature in the prime vertical, metres."""

    @classmethod
    def of(cls, lat: Array, lon: Array) -> "Points":
        phi, lam = np.radians(lat), np.radians(lon)
        sin_phi = np.sin(phi)
        normal = A / np.sqrt(1 - E2 * sin_phi * sin_phi)
        return cls(sin_phi, np.cos(phi), np.sin(lam), np.cos(lam), normal)


def ecef(lat: Array, lon: Array, height: Array | float, view: View) -> tuple[Array, Array, Array]:
    """Earth-centred coordinates in metres, x towards the satellite's longitude."""
    return _ecef(Points.of(lat, lon), height, view)[:3]


def _ecef(
    points: Points, height: Array | float, view: View
) -> tuple[Array, Array, Array, Array, Array]:
    cos_view, sin_view = math.cos(math.radians(view.lon)), math.sin(math.radians(view.lon))
    cos_lam = points.cos_lon * cos_view + points.sin_lon * sin_view
    sin_lam = points.sin_lon * cos_view - points.cos_lon * sin_view
    horizontal = (points.normal + height) * points.cos_phi
    z = (points.normal * (1 - E2) + height) * points.sin_phi
    return horizontal * cos_lam, horizontal * sin_lam, z, cos_lam, sin_lam


def scan_angles(
    lat: Array, lon: Array, height: Array | float, view: View
) -> tuple[Array, Array, Array]:
    """Scan angles (x east, y north, radians) and the cosine of the view zenith angle, which is
    negative where the point faces away from the satellite."""
    return scan_angles_at(Points.of(lat, lon), height, view)


def scan_angles_at(points: Points, height: Array | float, view: View) -> tuple[Array, Array, Array]:
    px, py, pz, cos_lam, sin_lam = _ecef(points, height, view)
    tx = view.radius - px
    if view.sweep == "x":
        x = np.arctan(py / np.hypot(pz, tx))
        y = np.arctan(pz / tx)
    else:
        x = np.arctan(py / tx)
        y = np.arctan(pz / np.hypot(py, tx))
    distance = np.sqrt(tx * tx + py * py + pz * pz)
    up_x, up_y = points.cos_phi * cos_lam, points.cos_phi * sin_lam
    cos_vza = (up_x * tx - up_y * py - points.sin_phi * pz) / distance
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
