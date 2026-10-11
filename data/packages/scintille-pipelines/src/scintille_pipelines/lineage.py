"""Upstream assets produced outside Dagster, declared for end-to-end lineage."""

from dagster import AssetKey, AssetSpec

RAW = AssetSpec(
    key=AssetKey(["raw", "glm_files"]),
    group_name="raw",
    description="GOES GLM L2 product files from NOAA, cached under `raw/` in R2 for 30 days.",
)
BRONZE = AssetSpec(
    key=AssetKey(["bronze", "ingest_log"]),
    deps=[RAW],
    group_name="bronze",
    description="One row per product file, written by lake-writer and backfills.",
)
COUNTRIES = AssetSpec(
    key=AssetKey(["reference", "countries"]),
    group_name="reference",
    description="Natural Earth admin-0 countries (v5.1.2, 1:50m), pinned by checksum.",
)
