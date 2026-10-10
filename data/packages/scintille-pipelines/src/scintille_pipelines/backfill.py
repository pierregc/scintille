"""`silver/flashes_backfill`: rebuilds whole day-and-source partitions of silver from NOAA."""

from datetime import date

from dagster import (
    AssetExecutionContext,
    DailyPartitionsDefinition,
    MaterializeResult,
    MultiPartitionKey,
    MultiPartitionsDefinition,
    StaticPartitionsDefinition,
    asset,
)
from scintille_ingest.backfill import backfill_partition
from scintille_ingest.glm.discovery import fetch, list_products, public_store
from scintille_ingest.glm.ingest import ingest_glm_file
from scintille_ingest.runtime.service import Settings
from scintille_ingest.runtime.sources import Product
from scintille_lake.locks import partition_locks

from .resources import LakeResource, PostgresResource

partitions = MultiPartitionsDefinition(
    {
        "day": DailyPartitionsDefinition(start_date="2024-01-01", timezone="UTC"),
        "source": StaticPartitionsDefinition(["glm-east", "glm-west"]),
    }
)

# NOAA buckets of the satellite operating each GOES slot on a given day.
OPERATIONAL = {
    "glm-east": [(date(2025, 4, 7), "noaa-goes19"), (date.min, "noaa-goes16")],
    "glm-west": [(date(2023, 1, 4), "noaa-goes18"), (date.min, "noaa-goes17")],
}


def bucket_for(source: str, day: date) -> str:
    return next(bucket for since, bucket in OPERATIONAL[source] if day >= since)


@asset(
    key=["silver", "flashes_backfill"],
    partitions_def=partitions,
    group_name="silver",
    pool="noaa",
    description="Rebuilds one day of one source from every upstream file, only if complete.",
)
def silver_flashes_backfill(
    context: AssetExecutionContext, lake: LakeResource, postgres: PostgresResource
) -> MaterializeResult:  # type: ignore[type-arg]
    key = context.partition_key
    assert isinstance(key, MultiPartitionKey)
    day = date.fromisoformat(key.keys_by_dimension["day"])
    source = key.keys_by_dimension["source"]
    store = public_store(bucket_for(source, day))
    result = backfill_partition(
        day,
        source,
        list_hour=lambda hour: [Product(p.key, p.start) for p in list_products(store, hour)],
        fetch=lambda product: fetch(store, product.key),
        parse=lambda product, data, at: ingest_glm_file(data, product.key, source, at),  # type: ignore[arg-type]
        catalog=lake.catalog(),
        parser_version=Settings().parser_version,
        locker=lambda keys: partition_locks(postgres.dsn, keys),
    )
    return MaterializeResult(
        metadata={
            "files": result.files,
            "expected_files": result.expected,
            "flashes": result.flashes,
            "quarantined": result.quarantined,
        }
    )
