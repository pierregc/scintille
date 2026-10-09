# Architecture

How data flows from the satellites to the browser. Decisions and reasons are in
[ADR 0006](adr/0006-data-architecture.md) (data) and [ADR 0005](adr/0005-hosting-and-dynamic-pages.md)
(hosting); the live feed format is in [the data contract](data-contract.md).

```mermaid
flowchart LR
    subgraph sources["Satellites"]
        glm["GOES GLM L2<br/>NOAA, AWS"]
        li["MTG LI L2<br/>EUMETSAT"]
        archives[("Upstream archives<br/>NOAA, EUMETSAT")]
    end

    subgraph vps["Hetzner VPS"]
        live_proc["ingest-live<br/>poll, parse, publish"]
        spool[("Durable spool<br/>one file per batch")]
        writer["lake-writer<br/>PyIceberg, every 5 min"]
        pg[("Postgres<br/>file state, locks")]
        dagster["Dagster<br/>gold, checks, backfills"]
    end

    subgraph r2["Cloudflare R2"]
        raw[("raw/<br/>30-day cache")]
        live[("live/<br/>manifest + 30 s chunks")]
        subgraph lake["Iceberg via R2 Data Catalog"]
            bronze[("bronze.ingest_log")]
            silver[("silver.flashes")]
            gold[("gold.*")]
        end
        pub[("storms/, regions/<br/>JSON + sitemaps")]
    end

    worker["Cloudflare Worker<br/>Astro pages"]
    browser["Browser<br/>Three.js globe"]

    glm --> live_proc
    li --> live_proc
    live_proc --> raw
    live_proc -->|seconds| live
    live_proc --> spool
    spool --> writer
    writer --> silver
    writer --> bronze
    pg --- live_proc
    pg --- writer
    silver --> dagster
    bronze --> dagster
    dagster --> gold
    gold --> dagster
    dagster --> pub
    archives -.->|backfill| dagster
    raw -.->|reprocessing| dagster
    dagster -.->|partition rebuild| silver
    live --> browser
    pub --> worker
    worker -->|HTML| browser
```

| Element | Meaning |
|---|---|
| `ingest-live` | Always on, seconds of latency; never waits on the lakehouse |
| Durable spool + `lake-writer` | Decouple the live feed from catalog commits; a catalog outage only grows the spool |
| Dagster | Minutes to hours: gold, checks, backfills, published JSON and sitemaps |
| Worker | Serves prerendered pages and renders storm and region pages from published JSON |
| Solid arrow | Regular data flow |
| Dotted arrow | On demand: backfills, reprocessing, partition rebuilds |
| Plain line | Shared state (Postgres), not data flow |
| Cylinder | Stored data; tables under `lake` are Apache Iceberg |
