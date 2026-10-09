"""Data quality rules on silver and bronze, as pure functions the Dagster checks call."""

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta

import polars as pl

# Product files per hour: GLM writes one every 20 s, MTG LI one every 30 s.
EXPECTED_FILES_PER_HOUR = {"glm-east": 180, "glm-west": 180, "mtg-li": 120}
COMPLETENESS_TARGET = 0.99
# lake-writer commits every 5 minutes; anything older than this means silver is stuck.
FRESHNESS_LIMIT = timedelta(minutes=20)
VOLUME_RANGE = (0.2, 5.0)


@dataclass(frozen=True)
class Outcome:
    passed: bool
    metadata: dict[str, object] = field(default_factory=dict)


def freshness(latest_event: Mapping[str, datetime | None], now: datetime) -> Outcome:
    """Every source has flashes in silver newer than `FRESHNESS_LIMIT`."""
    lag = {
        source: None if t is None else round((now - t).total_seconds())
        for source, t in latest_event.items()
    }
    stale = [
        s
        for s, seconds in lag.items()
        if seconds is None or seconds > FRESHNESS_LIMIT.total_seconds()
    ]
    return Outcome(not stale, {"lag_seconds": lag, "stale": stale})


def completeness(files: Mapping[str, int], sources: list[str]) -> Outcome:
    """Files received in one hour against the expected count, per source."""
    ratio = {s: round(files.get(s, 0) / EXPECTED_FILES_PER_HOUR[s], 4) for s in sources}
    short = [s for s, r in ratio.items() if r < COMPLETENESS_TARGET]
    return Outcome(not short, {"ratio": ratio, "files": dict(files), "short": short})


def ranges(flashes: pl.DataFrame, ingest_log: pl.DataFrame) -> Outcome:
    """Coordinates and energy in range, event times within their product window (± 5 min)."""
    windows = ingest_log.select(
        pl.col("key").str.split("/").list.last().alias("product_file"),
        "product_start",
        "product_end",
    )
    joined = flashes.join(windows, on="product_file", how="left")
    slack = timedelta(minutes=5)
    problems = {
        "lat": joined.filter(~pl.col("lat").is_between(-90, 90)).height,
        "lon": joined.filter(~pl.col("lon").is_between(-180, 180)).height,
        "energy": joined.filter(pl.col("energy_raw") <= 0).height,
        "event_time": joined.filter(
            (pl.col("event_time") < pl.col("product_start") - slack)
            | (pl.col("event_time") > pl.col("product_end") + slack)
        ).height,
    }
    return Outcome(not any(problems.values()), {"violations": problems, "rows": flashes.height})


def volume_anomaly(count: int, baseline: list[int]) -> Outcome:
    """This hour's flash count against the median of the same hour on previous days."""
    if not baseline:
        return Outcome(True, {"count": count, "baseline": None})
    median = sorted(baseline)[len(baseline) // 2]
    ratio = count / median if median else float("inf") if count else 1.0
    low, high = VOLUME_RANGE
    return Outcome(
        low <= ratio <= high, {"count": count, "baseline_median": median, "ratio": round(ratio, 3)}
    )


def uniqueness(flash_ids: pl.Series) -> Outcome:
    """No `flash_id` twice in a closed partition; a violation calls for a rebuild (#40)."""
    duplicates = flash_ids.len() - flash_ids.n_unique()
    return Outcome(duplicates == 0, {"rows": flash_ids.len(), "duplicates": duplicates})


Counts = Mapping[tuple[str, int], int]


def reconciliation(
    spooled: Counts, logged: Counts, log_rows: Counts, silver_rows: Counts
) -> Outcome:
    """Per (source, hour): files spooled in Postgres = files in bronze, and flashes parsed (bronze
    `row_count`) = flashes in silver + quarantine."""
    keys = sorted(set(spooled) | set(logged) | set(log_rows) | set(silver_rows))
    mismatches = [
        {
            "source": source,
            "hour": hour,
            "spooled_files": spooled.get((source, hour), 0),
            "bronze_files": logged.get((source, hour), 0),
            "bronze_rows": log_rows.get((source, hour), 0),
            "silver_and_quarantine_rows": silver_rows.get((source, hour), 0),
        }
        for source, hour in keys
        if spooled.get((source, hour), 0) != logged.get((source, hour), 0)
        or log_rows.get((source, hour), 0) != silver_rows.get((source, hour), 0)
    ]
    return Outcome(not mismatches, {"hours": len(keys), "mismatches": mismatches[:20]})
