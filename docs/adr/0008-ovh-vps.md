# 0008 · OVH VPS in Beauharnois instead of Hetzner

- Status: accepted
- Date: 2026-10-09

## Context

ADR 0006 runs the pipeline (`ingest-live`, `lake-writer`, Postgres, Dagster, DuckDB) on one Hetzner
VPS of about 4 vCPU and 8 GB. In October 2026 Hetzner had no capacity for that size, and OVH had
none left in Europe. Visitors never reach the VPS: the site and the live feed are served by
Cloudflare (ADR 0005), and the VPS only ingests, computes and publishes to R2.

## Options

- **Hetzner ARM (CAX21, 4 vCPU, 8 GB)**: available and cheap; every dependency has arm64 builds, but
  images would have to be built for ARM.
- **OVH VPS-2 (4 vCores, 8 GB, 75 GB NVMe) in North America**: same size, x86, about 7 EUR/month,
  in place upgrade to larger plans.
- **OVH in Asia-Oceania**: far from both data sources, no benefit.

## Decision

Use an OVH VPS-2 in Beauharnois (Canada), Debian 13. It is ordered by hand and configured by
`infra/vps/bootstrap.sh`; Terraform manages Cloudflare only (#18).

## Consequences

- GOES GLM data comes from AWS us-east-1, close to Beauharnois; MTG LI comes from Europe, adding
  well under a second to a 20 to 60 s satellite latency.
- R2 buckets use the ENAM location hint, close to the VPS.
- No personal data is processed on the VPS; Canada also has an EU adequacy decision.
- The machine is not created by code: rebuilding it means ordering a VPS and re-running the bootstrap.
- Lost SSH key: OVH KVM console or rescue mode.
- The rest of ADR 0006 is unchanged; "Hetzner VPS" there now reads as this VPS.
