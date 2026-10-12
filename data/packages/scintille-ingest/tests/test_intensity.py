from datetime import UTC, date, datetime
from pathlib import Path

import duckdb
import numpy as np
import polars as pl
from scintille_ingest.glm.ingest import ingest_glm_file
from scintille_ingest.intensity import (
    CURRENT,
    PERCENTILES,
    Calibration,
    fit,
    intensity,
    load,
    quantiles_query,
)

FIXTURE = (
    Path(__file__).parent
    / "fixtures"
    / "OR_GLM-L2-LCFA_G18_s20262811818400_e20262811819000_c20262811819015.nc"
)
UNITS = {"glm-east": "J", "glm-west": "J", "mtg-li": "mW m-2 sr-1"}


def samples(seed: int = 7, n: int = 200_000) -> dict[str, np.ndarray]:
    """log10 energies with different scales, spreads and shapes per source."""
    rng = np.random.default_rng(seed)
    return {
        "glm-east": rng.normal(-13.4, 0.6, n),
        "glm-west": rng.normal(-13.2, 0.5, n),
        "mtg-li": 1.2 + rng.gamma(4.0, 0.3, n),
    }


def frame(source: str, log_energy: np.ndarray) -> pl.DataFrame:
    return pl.DataFrame(
        {
            "source": [source] * len(log_energy),
            "energy_raw": 10.0**log_energy,
            "energy_unit": [UNITS[source]] * len(log_energy),
        }
    )


def fitted(data: dict[str, np.ndarray]) -> Calibration:
    quantiles = {
        s: (UNITS[s], len(v), np.percentile(v, PERCENTILES).tolist()) for s, v in data.items()
    }
    return fit(quantiles, "cal-1")


def test_same_percentile_gives_same_intensity_on_every_source() -> None:
    data = samples()
    calibration = fitted(data)
    grid = np.arange(0.5, 100, 0.5)
    by_source = {
        s: intensity(frame(s, np.percentile(v, grid)), calibration).to_numpy()
        for s, v in data.items()
    }
    for source in ("glm-west", "mtg-li"):
        assert np.abs(by_source[source] - by_source["glm-east"]).max() < 0.02


def test_reference_source_stays_log_linear() -> None:
    calibration = fitted(samples())
    knots = np.array(calibration.sources["glm-east"].log10_energy)
    log_energy = np.linspace(knots[0], knots[-1], 50)
    expected = (log_energy - knots[0]) / (knots[-1] - knots[0])
    got = intensity(frame("glm-east", log_energy), calibration).to_numpy()
    assert np.allclose(got, expected, atol=1e-5)
    assert calibration.intensity[0] == 0 and calibration.intensity[-1] == 1


def test_out_of_range_energies_clip_and_unknown_sources_are_null() -> None:
    flashes = pl.DataFrame(
        {
            "source": ["glm-east", "glm-east", "glm-east", "mtg-li", "glm-west"],
            "energy_raw": [0.0, 1e-20, 1e-5, 1e-14, 1e-14],
            "energy_unit": ["J", "J", "J", "J", "mW m-2 sr-1"],
        }
    )
    got = intensity(flashes, fitted(samples())).to_list()
    assert got == [0.0, 0.0, 1.0, None, None]


def test_provisional_calibration_is_log_linear_per_unit() -> None:
    flashes = pl.DataFrame(
        {
            "source": ["glm-east", "glm-west", "glm-east", "mtg-li"],
            "energy_raw": [10**-15.5, 10**-13.5, 10**-11.5, 100.0],
            "energy_unit": ["J", "J", "J", "mW m-2 sr-1"],
        }
    )
    assert np.allclose(intensity(flashes, load("cal-0")).to_numpy(), [0, 0.5, 1, 0.5])


def test_json_round_trip_and_latest_version(tmp_path: Path) -> None:
    calibration = fit(
        {s: (UNITS[s], 10, list(np.linspace(0, 1, len(PERCENTILES)))) for s in UNITS},
        "cal-10",
        (date(2026, 10, 5), date(2026, 10, 12)),
    )
    (tmp_path / "cal-10.json").write_text(calibration.to_json())
    (tmp_path / "cal-9.json").write_text(load("cal-0").to_json())
    assert load(directory=tmp_path) == calibration
    assert load() == CURRENT


def test_quantiles_query_matches_numpy_and_skips_flagged_flashes() -> None:
    rng = np.random.default_rng(3)
    n = 5000
    rows = pl.DataFrame(
        {
            "source": ["glm-east"] * n + ["mtg-li"] * n,
            "event_time": [datetime(2026, 10, 6, tzinfo=UTC)] * (2 * n),
            "energy_raw": np.concatenate(
                [10.0 ** rng.normal(-13, 0.5, n), 10.0 ** rng.normal(2, 0.7, n)]
            ),
            "energy_unit": ["J"] * n + ["mW m-2 sr-1"] * n,
            "quality": [[]] * n + [[]] * n,
        },
        schema_overrides={"quality": pl.List(pl.String)},
    )
    flagged = rows.head(3).with_columns(
        energy_raw=pl.lit(1.0), quality=pl.lit(["outside-owner-zone"])
    )
    zero = rows.head(1).with_columns(energy_raw=pl.lit(0.0))
    late = rows.head(1).with_columns(event_time=pl.lit(datetime(2026, 10, 9, tzinfo=UTC)))
    flashes = pl.concat([rows, flagged, zero, late]).to_arrow()  # noqa: F841
    connection = duckdb.connect()
    sql, params = quantiles_query(date(2026, 10, 5), date(2026, 10, 8), relation="flashes")
    result = {s: (u, c, q) for s, u, c, q in connection.execute(sql, params).fetchall()}
    for source, offset in (("glm-east", 0), ("mtg-li", n)):
        unit, count, values = result[source]
        expected = np.percentile(np.log10(rows["energy_raw"][offset : offset + n]), PERCENTILES)
        assert (unit, count) == (UNITS[source], n)
        assert np.allclose(values, expected)


def test_ingested_flashes_carry_the_current_intensity() -> None:
    received = datetime(2026, 10, 8, 18, 20, tzinfo=UTC)
    key = f"GLM-L2-LCFA/2026/281/18/{FIXTURE.name}"
    flashes = ingest_glm_file(FIXTURE.read_bytes(), key, "glm-west", received).flashes
    values = flashes["intensity"]
    assert values.null_count() == 0 and values.min() >= 0 and values.max() <= 1  # type: ignore[operator]
    assert np.allclose(values.to_numpy(), intensity(flashes, CURRENT).to_numpy())
