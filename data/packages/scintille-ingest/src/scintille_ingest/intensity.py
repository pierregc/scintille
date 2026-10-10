"""Provisional energy → intensity mapping (the fixtures' one), until the calibration of #33."""

import numpy as np
import polars as pl

# log10 of the energy that maps to 0 and to 1, per unit.
LOG_RANGE = {"J": (-15.5, -11.5), "mW m-2 sr-1": (0.0, 4.0)}


def provisional_intensity(flashes: pl.DataFrame) -> np.ndarray:
    """Intensity 0..1 from `energy_raw` on a log scale; unknown units or energy ≤ 0 give 0."""
    energy = flashes["energy_raw"].to_numpy().astype(np.float64)
    unit = flashes["energy_unit"].cast(pl.String).to_numpy()
    lo = np.array([LOG_RANGE.get(u, (np.nan, np.nan))[0] for u in unit])
    hi = np.array([LOG_RANGE.get(u, (np.nan, np.nan))[1] for u in unit])
    with np.errstate(divide="ignore", invalid="ignore"):
        value = (np.log10(energy) - lo) / (hi - lo)
    result: np.ndarray = np.nan_to_num(np.clip(value, 0, 1), nan=0.0)
    return result
