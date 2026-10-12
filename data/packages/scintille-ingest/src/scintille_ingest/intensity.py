"""Cross-source intensity: log energy mapped through per-source percentiles (methodology.md)."""

import json
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl
from scintille_contract.models import SOURCE_VALUES

CALIBRATIONS = Path(__file__).parent / "calibration"
PERCENTILES = (1, 2, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 98, 99, 99.5, 99.9)
REFERENCE = "glm-east"
EXCLUDED_FLAGS = ("degraded", "outside-owner-zone")


@dataclass(frozen=True)
class SourceKnots:
    unit: str
    flashes: int
    log10_energy: tuple[float, ...]


@dataclass(frozen=True)
class Calibration:
    """Piecewise-linear map from log10(energy_raw) to intensity, one knot list per source.

    Knot `k` of every source sits at the same percentile and maps to the same `intensity[k]`.
    """

    version: str
    intensity: tuple[float, ...]
    sources: dict[str, SourceKnots]
    percentiles: tuple[float, ...] | None = None
    reference: str | None = None
    window: tuple[date, date] | None = None

    def to_json(self) -> str:
        data = asdict(self)
        if self.window:
            data["window"] = [d.isoformat() for d in self.window]
        return json.dumps(data, indent=2) + "\n"

    @classmethod
    def from_json(cls, text: str) -> "Calibration":
        data: dict[str, Any] = json.loads(text)
        window = data.get("window")
        return cls(
            version=data["version"],
            intensity=tuple(data["intensity"]),
            sources={
                name: SourceKnots(s["unit"], s["flashes"], tuple(s["log10_energy"]))
                for name, s in data["sources"].items()
            },
            percentiles=tuple(data["percentiles"]) if data.get("percentiles") else None,
            reference=data.get("reference"),
            window=(date.fromisoformat(window[0]), date.fromisoformat(window[1]))
            if window
            else None,
        )


def _number(version: str) -> int:
    return int(version.removeprefix("cal-"))


def next_version(directory: Path = CALIBRATIONS) -> str:
    return f"cal-{_number(load(directory=directory).version) + 1}"


def load(version: str | None = None, directory: Path = CALIBRATIONS) -> Calibration:
    """One calibration by version; the highest `cal-N` when no version is given."""
    if version is None:
        version = max((p.stem for p in directory.glob("cal-*.json")), key=_number)
    return Calibration.from_json((directory / f"{version}.json").read_text())


def fit(
    quantiles: dict[str, tuple[str, int, list[float]]],
    version: str,
    window: tuple[date, date] | None = None,
    percentiles: tuple[float, ...] = PERCENTILES,
    reference: str = REFERENCE,
) -> Calibration:
    """Calibration from per-source log10 energy quantiles at `percentiles`.

    The reference source keeps a log-linear scale between its first and last knot; every other
    source is mapped onto it percentile by percentile.
    """
    if missing := sorted(set(SOURCE_VALUES) - set(quantiles)):
        raise ValueError(f"no flashes for {', '.join(missing)} in the window")
    ref = np.array(quantiles[reference][2])
    span = ref[-1] - ref[0]
    if not span > 0:
        raise ValueError(f"{reference}: degenerate energy distribution")
    intensity = tuple(float(v) for v in np.round((ref - ref[0]) / span, 6))
    return Calibration(
        version=version,
        intensity=intensity,
        sources={
            name: SourceKnots(unit, count, tuple(round(float(v), 6) for v in values))
            for name, (unit, count, values) in sorted(quantiles.items())
        },
        percentiles=percentiles,
        reference=reference,
        window=window,
    )


def intensity(flashes: pl.DataFrame, calibration: Calibration) -> pl.Series:
    """Intensity 0..1 per flash; null for a source or unit the calibration does not know."""
    energy = flashes["energy_raw"].to_numpy().astype(np.float64)
    sources = flashes["source"].cast(pl.String).to_numpy()
    units = flashes["energy_unit"].cast(pl.String).to_numpy()
    with np.errstate(divide="ignore"):
        log_energy = np.log10(energy)
    result = np.full(len(energy), np.nan)
    for name, knots in calibration.sources.items():
        rows = (sources == name) & (units == knots.unit)
        result[rows] = np.interp(log_energy[rows], knots.log10_energy, calibration.intensity)
    return pl.Series("intensity", result, dtype=pl.Float64).fill_nan(None)


def with_intensity(flashes: pl.DataFrame, calibration: Calibration | None = None) -> pl.DataFrame:
    return flashes.with_columns(intensity(flashes, calibration or CURRENT))


def quantiles_query(
    start: date,
    end: date,
    percentiles: tuple[float, ...] = PERCENTILES,
    relation: str = "lake.silver.flashes",
) -> tuple[str, list[Any]]:
    """Per-source log10 energy quantiles of nominal flashes over [start, end)."""
    fractions = ", ".join(str(p / 100) for p in percentiles)
    flags = " AND ".join(f"NOT list_contains(quality, '{f}')" for f in EXCLUDED_FLAGS)
    sql = (
        "SELECT source, any_value(energy_unit), count(*), "
        f"quantile_cont(log10(energy_raw), [{fractions}]) FROM {relation} "
        f"WHERE event_time >= ? AND event_time < ? AND energy_raw > 0 AND {flags} "
        "GROUP BY source ORDER BY source"
    )
    bounds = [datetime(d.year, d.month, d.day, tzinfo=UTC) for d in (start, end)]
    return sql, bounds


CURRENT = load()
