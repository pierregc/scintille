"""Data quality rules on silver and bronze, as pure functions the Dagster checks call."""

import re
from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta

import polars as pl
from scintille_ingest.runtime.ops import COMPLETENESS_TARGET, EXPECTED_FILES_PER_HOUR

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


_PRODUCT_START = re.compile(r"_s(\d{4})(\d{3})(\d{2})\d{5}_")


def product_hour(name: str) -> datetime | None:
    """Start hour encoded in a GOES product file name (`_sYYYYJJJHHMMSSt_`)."""
    match = _PRODUCT_START.search(name)
    if match is None:
        return None
    year, day, hour = (int(g) for g in match.groups())
    return datetime(year, 1, 1, tzinfo=UTC) + timedelta(days=day - 1, hours=hour)


def _file_name(key: str) -> str:
    return key.rsplit("/", 1)[-1]


def reconciliation(
    day: date, spooled: pl.DataFrame, bronze: pl.DataFrame, parsed: pl.DataFrame
) -> Outcome:
    """Per (source, hour) of `day`: files spooled in Postgres (`key`, `source`) = files in bronze
    (`key`, `source`, `row_count`), and flashes parsed (bronze `row_count`) = rows in silver +
    quarantine (`product_file`, `source`). Each side is read independently, so a file missing
    from any of them is reported by name."""

    def bucket(name: str, source: str) -> tuple[str, int] | None:
        hour = product_hour(name)
        return (source, hour.hour) if hour is not None and hour.date() == day else None

    spooled_files = {
        _file_name(k): b
        for k, s in spooled.select("key", "source").iter_rows()
        if (b := bucket(_file_name(k), s))
    }
    bronze_files: dict[str, tuple[str, int]] = {}
    bronze_rows = Counter[tuple[str, int]]()
    for key, source, rows in bronze.select("key", "source", "row_count").iter_rows():
        name = _file_name(key)
        if b := bucket(name, source):
            bronze_files[name] = b
            bronze_rows[b] += rows
    silver_files: dict[str, tuple[str, int]] = {}
    silver_rows = Counter[tuple[str, int]]()
    for name, source in parsed.select("product_file", "source").iter_rows():
        if b := bucket(name, source):
            silver_files[name] = b
            silver_rows[b] += 1
    spooled_count = Counter(spooled_files.values())
    bronze_count = Counter(bronze_files.values())
    keys = sorted(set(spooled_count) | set(bronze_count) | set(silver_rows))
    mismatches = [
        {
            "source": source,
            "hour": hour,
            "spooled_files": spooled_count[(source, hour)],
            "bronze_files": bronze_count[(source, hour)],
            "bronze_rows": bronze_rows[(source, hour)],
            "silver_and_quarantine_rows": silver_rows[(source, hour)],
        }
        for source, hour in keys
        if spooled_count[(source, hour)] != bronze_count[(source, hour)]
        or bronze_rows[(source, hour)] != silver_rows[(source, hour)]
    ]
    unmatched = {
        "spooled_not_in_bronze": sorted(spooled_files.keys() - bronze_files.keys()),
        "bronze_not_spooled": sorted(bronze_files.keys() - spooled_files.keys()),
        "silver_without_bronze": sorted(silver_files.keys() - bronze_files.keys()),
    }
    failed = bool(mismatches) or any(unmatched.values())
    return Outcome(
        not failed,
        {
            "hours": len(keys),
            "mismatches": mismatches[:20],
            **{k: {"count": len(v), "files": v[:20]} for k, v in unmatched.items()},
        },
    )
