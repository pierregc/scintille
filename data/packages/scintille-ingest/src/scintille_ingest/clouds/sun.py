"""Subsolar point, with the NOAA solar calculator equations of `web/src/globe/sun.ts`."""

import math
from datetime import datetime

import numpy as np
from numpy.typing import NDArray


def subsolar_point(at: datetime) -> tuple[float, float]:
    """Latitude and longitude (degrees) where the sun is at the zenith."""
    julian_day = at.timestamp() / 86_400 + 2_440_587.5
    t = (julian_day - 2_451_545) / 36_525
    mean_long = (280.46646 + t * (36_000.76983 + t * 0.0003032)) % 360
    mean_anom = 357.52911 + t * (35_999.05029 - 0.0001537 * t)
    eccent = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
    center = (
        _sin(mean_anom) * (1.914602 - t * (0.004817 + 0.000014 * t))
        + _sin(2 * mean_anom) * (0.019993 - 0.000101 * t)
        + _sin(3 * mean_anom) * 0.000289
    )
    omega = 125.04 - 1934.136 * t
    app_long = mean_long + center - 0.00569 - 0.00478 * _sin(omega)
    mean_obliq = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60
    obliq = mean_obliq + 0.00256 * _cos(omega)
    lat = math.degrees(math.asin(_sin(obliq) * _sin(app_long)))
    y = math.tan(math.radians(obliq / 2)) ** 2
    eq_time = 4 * math.degrees(
        y * _sin(2 * mean_long)
        - 2 * eccent * _sin(mean_anom)
        + 4 * eccent * y * _sin(mean_anom) * _cos(2 * mean_long)
        - 0.5 * y * y * _sin(4 * mean_long)
        - 1.25 * eccent * eccent * _sin(2 * mean_anom)
    )
    minutes = (at.timestamp() / 60) % 1440
    lon = -(minutes - 720 + eq_time) / 4
    return lat, (lon + 180) % 360 - 180


def cos_zenith(
    lat: NDArray[np.floating], lon: NDArray[np.floating], subsolar: tuple[float, float]
) -> NDArray[np.float32]:
    phi, lam = np.radians(lat), np.radians(lon)
    s_phi, s_lam = math.radians(subsolar[0]), math.radians(subsolar[1])
    value = np.sin(phi) * math.sin(s_phi) + np.cos(phi) * math.cos(s_phi) * np.cos(lam - s_lam)
    return value.astype(np.float32)


def _sin(degrees: float) -> float:
    return math.sin(math.radians(degrees))


def _cos(degrees: float) -> float:
    return math.cos(math.radians(degrees))
