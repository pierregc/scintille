# Architecture

How data flows from the satellites to the browser. Decisions and reasons are in
[ADR 0006](adr/0006-data-architecture.md); the live feed format is in
[the data contract](data-contract.md).

```mermaid
flowchart LR
    subgraph sources["Satellites"]
        glm["GOES GLM L2<br/>NOAA, AWS"]
        li["MTG LI L2<br/>EUMETSAT"]
    end

    subgraph vps["Hetzner VPS"]
        hot["Hot path<br/>scintille-ingest<br/>asyncio + Polars"]
        pg[("Postgres<br/>file state")]
        dagster["Dagster<br/>assets, checks, backfills"]
        dbt["dbt v2 + DuckDB"]
    end

    subgraph r2["Cloudflare R2"]
        raw[("raw/<br/>30-day cache")]
        live[("live/<br/>manifest + 30 s chunks")]
        subgraph lake["Iceberg via R2 Data Catalog"]
            bronze[("bronze.ingest_log")]
            silver[("silver.flashes")]
            gold[("gold.*<br/>storms, aggregates, SLA")]
        end
        pub[("published JSON<br/>+ Parquet exports")]
    end

    browser["Browser<br/>Astro + Three.js"]

    glm --> hot
    li --> hot
    hot <--> pg
    hot -->|raw files| raw
    hot -->|"seconds"| live
    hot -->|"PyIceberg, every 1-5 min"| silver
    hot --> bronze
    live -->|CDN| browser
    raw -.->|reprocessing| dagster
    dagster -.->|backfills| silver
    dagster --> dbt
    silver --> dbt
    bronze --> dbt
    dbt --> gold
    gold --> dagster
    dagster --> pub
    pub -->|CDN| browser
```

| Element | Meaning |
|---|---|
| Hot path | Always-on service: seconds of latency, publishes the live feed and appends micro-batches to the lakehouse |
| Cold path | Dagster and dbt: minutes to hours, builds gold, runs checks, backfills and exports |
| Solid arrow | Regular data flow |
| Dotted arrow | On demand: backfills and reprocessing |
| Cylinder | Stored data; everything under R2 is object storage, `lake` tables are Apache Iceberg |
