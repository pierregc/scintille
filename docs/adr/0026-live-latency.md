# 0026 · Live latency: one chunk per GLM slot, faster polling, 70 s playback delay

- Status: accepted
- Date: 2026-10-29
- Amends: [0004](0004-live-chunk-encoding.md) (chunk cadence, manifest cache)

## Context

In live mode each source plays a fixed delay behind the wall clock (#214): GLM 120 s, MTG LI 720 s.
That delay is the latency a visitor sees. It must cover the slowest flashes, not the average: a
flash that reaches the browser after its slot is not drawn in the default view (afterglow 0), and
when a whole GLM file is late, its satellite's area pauses for a few seconds.

Measured on 2026-10-29 from public data only with [measure.py](../analysis/live-latency/measure.py)
(runs at UTC [17:47](../analysis/live-latency/measurements-2026-10-29T1747.json) and
[18:04](../analysis/live-latency/measurements-2026-10-29T1804.json)): 24 h of NOAA listings, the
last hour of chunks, 15 min of manifest polling through the nearest edge. GLM, seconds:

| Step | p50 | p99 | max |
|---|---|---|---|
| Flash → file listable on NOAA S3 (20 s file, then 10 s of NOAA processing at p50, 27 s at p99) | 21 | 41 | 95 |
| File listable → ingested (listing every 10 s) | 6 | 10 | 26 |
| Flash → listed in the manifest (chunk closed on a 30 s clock), hour to 17:47 | 41 | 70 | 81 |
| Manifest written → seen at the edge (`max-age=10`) | 6.5 | 13 | 13 |
| Flash → fetched by the browser (polls every 30 s), modelled from the NOAA files | 62 | 95 | 150 |

- The issue's 20 s floor is NOAA's mean age. A fixed delay is bounded by NOAA's tail instead:
  p99 41 s, p99.9 53 s. Below about 55 s, flashes go missing whatever we do downstream.
- The 30 s chunk clock and the 30 s poll each add up to 30 s at the tail, together more than NOAA.
- Each deploy restarts `ingest-live`: the hour to 18:04, with five restarts, reached p99 95 s and
  max 111 s, against 70 s and 81 s for the hour to 17:47 with two.
- MTG LI comes as one file per 10 minute cycle, listed 6.5 min after the flash on average and up to
  716 s. With the edge and the 30 s poll on top, 0.5 % of LI flashes miss their 720 s slot. The
  status page holds LI to the same 120 s as GLM, which LI can never meet. Lowering LI latency needs
  another channel (#204).
- R2 free tier: 1 M writes and 10 M reads a month. With the R2 plan, everything writes about
  0.57 M a month, 173 k of them for the live feed (chunk and manifest every 30 s). Each edge
  location with visitors reads the manifest from R2 once per `max-age`.

## Options

Publication, two writes per chunk (chunk and manifest):

- **Shorter clock.** Every 10 s doubles the feed's writes (346 k); every 5 s alone is 1 M a month,
  the whole free tier.
- **One chunk per source file.** GLM East and West each deliver every 20 s: 6 chunks a minute,
  520 k writes a month.
- **One chunk per GLM slot.** Both satellites deliver the same 20 s slot within 8 s of each other
  (p5 to p95). Publishing once both have delivered keeps about 3 chunks a minute: 261 k writes.

Collector:

- **Listing every 2 s** instead of 10 s, from the newest files only, costs nothing (NOAA's public
  buckets) and answers within 2 s.
- **NOAA SNS notifications** would save about a second more, for an AWS account and a queue that
  receives every GOES object, not just GLM.

Delivery to the browser:

- **Polling every 5 s, manifest `max-age=2`.** Most polls are revalidations answered 304 by the
  edge. Reads reach R2 once per 2 s per edge location with visitors, or once in all with Smart
  Tiered Cache (free), which puts a single upper tier next to the bucket.
- **Push** (WebSocket from a Durable Object; the free plan allows 100 k requests a day). Saves 3 to
  4 s at p99, for a stateful Worker, a publisher secret, reconnection and a polling fallback anyway.

Delay:

- **One delay for every source** would be MTG LI's 12 minutes everywhere. **One per source** (today)
  keeps the Americas fresh; the scene time already says which clock a storm uses (#255).
- **Adaptive delay** (a jitter buffer that slows or speeds playback) would track NOAA's tail hour
  by hour, at the cost of a scene clock that drifts. Not needed while one constant is enough.

GLM at the browser, simulated on the same 24 h of NOAA files:

| Chain | p50 | p99 | p99.9 | Writes/month | Late at 60 s | at 70 s | at 90 s |
|---|---|---|---|---|---|---|---|
| Today | 62 | 95 | 107 | 173 k | 56 % | 31 % | 2.7 % |
| List 2 s, poll 5 s, `max-age=2` | 44 | 71 | 83 | 173 k | 8.9 % | 1.2 % | 0.05 % |
| Same, one chunk per GLM slot | 31 | 54 | 69 | 261 k | 0.38 % | 0.10 % | 0.02 % |
| Same, push instead of polling | 27 | 50 | 66 | 261 k | 0.24 % | 0.07 % | 0.01 % |

Late means loaded after its slot. With today's 120 s, 0.02 % of GLM flashes are late and a viewer
sees a short pause (one satellite's area, a few seconds) about every 6 hours. With one chunk per
slot, a pause comes every 14 minutes at 60 s, every hour at 70 s, every 6 hours at 90 s.

Direct reception (GOES GRB, EUMETCast) would cut NOAA's processing time; it needs a dish and a
receiver. Kept as a showcase idea for later.

## Decision

- `ingest-live` lists GLM every 2 s, only the files of the last 3 minutes, and the whole hour once
  a minute to catch revisions.
- The live feed publishes a chunk as soon as every live GLM source has delivered a file since the
  previous chunk, or 10 s after the first pending flashes, never sooner than 15 s after the
  previous chunk, and an empty one after 30 s without data. MTG LI files join the next chunk.
  Typical duration (`chunk_seconds`) 20 s.
- The manifest is cached `max-age=2`; Smart Tiered Cache is enabled on the zone (Terraform).
- The browser polls the manifest every 5 s.
- Playback delay: GLM 70 s, MTG LI unchanged at 720 s.
- SLO per source: GLM p95 ≤ 45 s from the flash to the manifest, MTG LI p95 ≤ 11 min.

## Consequences

- GLM plays 70 s behind instead of 120 s, with a short pause about once an hour per viewer. The
  delay is one constant in `web/src/globe/live/delay.ts`, and `debug.late` on the globe app counts
  late flashes per source to tune it. MTG LI flashes stop missing their slot (0.5 % today, 0.01 % after).
- Writes: +88 k a month for the live feed, about 0.66 M in all with the R2 plan, 0.83 M if silver
  commits every 2 minutes for #257.
- Reads: at most 1.3 M a month for the manifest through Smart Tiered Cache. Without it, up to
  1.3 M per edge location with continuous visitors: it must be on before the launch.
- A first visit loads about 180 chunks instead of 120: with the other files, about 220 requests,
  under the 300 per 10 s rate limit per IP.
- The manifest lists 180 chunks (about 5 KB with brotli). NOAA sees about one small listing a
  second.
- The format does not change: chunk durations could already vary and clients only read the
  manifest. ADR 0004 holds for everything else.
- Push, an adaptive delay or direct reception become worth it only if NOAA's tail shrinks.
