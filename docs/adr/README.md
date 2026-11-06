# Architecture Decision Records

One file per significant decision, numbered in order: `NNNN-short-title.md` (e.g. `0001-github-issues-for-planning.md`).
A record keeps its text; its status line follows the decision ([0036](0036-current-adr-statuses.md)).
A later decision is a new record linking its predecessor. Two records share the number 0013 and are
told apart by their file names.

## Template

```markdown
# NNNN · Title

- Status: proposed | accepted | superseded by NNNN
- Date: YYYY-MM-DD

## Context
What forces the decision: constraints, requirements, what we know.

## Options
The alternatives considered, with their trade-offs.

## Decision
What we chose, in one or two sentences.

## Consequences
What becomes easier, what becomes harder, what we must watch.
```

## Records

| ADR | Title | Status |
|---|---|---|
| [0001](0001-github-issues-for-planning.md) | GitHub Issues and Projects for planning | accepted |
| [0002](0002-astro-plus-raw-threejs.md) | Astro for pages, raw Three.js for the globe | accepted |
| [0003](0003-repo-private-until-launch.md) | Repository private until launch | accepted |
| [0004](0004-live-chunk-encoding.md) | Live feed as gzip binary chunks keyed by ingest time | accepted |
| [0005](0005-hosting-and-dynamic-pages.md) | Cloudflare Workers with prerendered pages and on-demand storm and region pages | accepted |
| [0006](0006-data-architecture.md) | Data architecture: hot path, Iceberg lakehouse on R2, Dagster batch | accepted |
| [0007](0007-cloud-source.md) | Cloud source: NOAA GMGSI infrared mosaic first, home-made composite later | accepted |
| [0008](0008-ovh-vps.md) | OVH VPS in Beauharnois instead of Hetzner | accepted |
| [0009](0009-storm-intensity-levels.md) | Storm intensity levels | accepted |
| [0011](0011-storm-publication-contract.md) | Storm publication and replay references | accepted |
| [0012](0012-retention-policy.md) | Retention policy for flashes, raw products, and cloud frames | superseded by [0025](0025-past-days-archive.md) |
| [0013](0013-bis-3d-lightning-ribbons.md) | 3D lightning ribbons | superseded by [0033](0033-lightning-looks-and-density.md) |
| [0013](0013-replay-feed-lifecycle.md) | One scene data owner for live and archive playback | accepted |
| [0014](0014-historical-cloud-discovery.md) | Daily cloud archive discovery | accepted |
| [0015](0015-production-replay-entry.md) | Production replay entry and framing | accepted |
| [0016](0016-replay-share-urls.md) | Replay URL state and navigation | accepted |
| [0017](0017-preserve-adr-history.md) | Preserve ADR history and disambiguate duplicate identifiers | superseded by [0036](0036-current-adr-statuses.md) |
| [0018](0018-interrupted-replay-framing.md) | Reload interrupted replay approaches without persisting an intermediate destination | accepted |
| [0019](0019-reload-storm-framing.md) | Use storm framing for ordinary reloads and explicit views for sharing | accepted |
| [0020](0020-immersive-storm-view.md) | Immersive storm view: lightning sets the zoom, the zoom sets the detail | accepted |
| [0021](0021-active-storm-cells.md) | Active storm cells: update cadence and feed contract | accepted |
| [0022](0022-surface-imagery.md) | Surface imagery: a 500 m raster pyramid, no vector overlays | accepted |
| [0023](0023-composite-clouds.md) | Composite clouds of about 1 km, served as detail tiles | accepted |
| [0024](0024-deploys-during-runs.md) | Deploys during Dagster runs: fail dead runs fast and retry them | accepted |
| [0025](0025-past-days-archive.md) | Past days in Travel in time: an hourly flash archive | accepted (21 days, 29 October) |
| [0026](0026-live-latency.md) | Live latency: one chunk per GLM slot, faster polling, 70 s playback delay | accepted |
| [0027](0027-storm-search.md) | Storm search: D1 for place and time queries, static place index, coarse IP location | accepted |
| [0028](0028-cloud-relief.md) | Clouds in relief: observed tops, a translucent volume with styled detail | accepted |
| [0029](0029-asia-oceania-coverage.md) | Asia and Oceania coverage | accepted |
| [0030](0030-bounded-aesthetic-license.md) | Bounded aesthetic license: styled detail beside the observations | accepted |
| [0031](0031-cloud-look.md) | Cloud look: observed relief, sparse styling, exact light | accepted, its lighting replaced by [0034](0034-one-cloud-relief.md) |
| [0032](0032-free-camera-tilt.md) | Free camera tilt: orbit along the floor, then raise the gaze | accepted |
| [0033](0033-lightning-looks-and-density.md) | Lightning looks and a density budget by replay speed | accepted (#408, with the final values below) |
| [0034](0034-one-cloud-relief.md) | One cloud relief from the globe to the floor | accepted |
| [0035](0035-lightning-inside-clouds.md) | Lightning inside the clouds | accepted |
| [0036](0036-current-adr-statuses.md) | Keep ADR statuses current | accepted |
