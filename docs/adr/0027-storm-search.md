# 0027 · Storm search: D1 for place and time queries, static place index, coarse IP location

- Status: proposed
- Date: 2026-10-29

## Context

#288 suggests a few interesting storms observed recently near the visitor (#289 shows them), and
#282 will search and browse the catalog with the same service. Neither may download the catalog.

What is published today (`data.scintille.app`, read on 2026-10-29):

- 32,062 storms of level 3 and above since 2026-10-12; 1,766 started on 2026-10-28 (73 % level 3,
  21 % level 4, 6 % level 5), about 650,000 a year at this rate. Duration median 2.1 h, p99 9.7 h,
  max 43.8 h. Centroid travel median 33 km, p90 133 km, p99 400 km, max 2,813 km.
- A storm changes in about 3.6 hourly catalog runs while it lasts: about 6,300 changed storms a day.
- Index pages and `storms/highlights.json` carry summaries without any position. Only
  `storms/<slug>.json` has the track: hourly centroids with their area, 3 points median.
- Replay chunks are deleted 60 days after upload (R2 lifecycle); details stay.

#283 answered queries from R2 posting lists but rewrote a full generation every hour (14,236 objects,
295 MB at 100,000 storms), matched exact words only and added a lot of custom code. It was closed.

The site Worker serves only static assets so far. R2 class A writes were at 0.95 of the free
million in October and are being reduced. Infrastructure must stay free.

Platform facts (official documentation, 2026-10-29, see Sources):

- Workers Free: 100,000 requests a day, 10 ms CPU per request; static assets are free and unmetered,
  20,000 files per version.
- D1 Free: 500 MB per database, 5 GB per account, 5 million rows read and 100,000 rows written a
  day, reset at 00:00 UTC; past a cap queries fail until the reset, nothing is billed. Each index
  touched by a write adds a written row. Supported extensions: FTS5, JSON, math; no R*Tree.
- `request.cf` gives `city`, `region`, `country`, `latitude`, `longitude` on all plans, each may be
  null. No accuracy radius.
- The only Free WAF rate limiting rule is already used (300 requests per 10 s per IP).
- GeoNames `cities15000` (31,737 places, CC BY 4.0) is vendored for storm names.

## Options

### Query backend

- **R2 posting lists rebuilt every hour** (#283). Rejected for the reasons above.
- **R2 partitions per UTC day and 10° tile**, rewritten only when one of their storms changes, read
  by the browser or by the Worker. Incremental: about 1,500 writes a day (45,000 class A a month).
  A 72 h, 200 km query reads 4 to 16 objects; 7 days and 500 km up to about 50, so coarser
  partitions would be needed as well. Every #282 filter (country, level, periods past a week, map
  of a region) needs another layout: custom index code again. Overuse is billed.
- **D1.** The catalog run upserts changed storms, the Worker queries through a binding. Incremental
  per row, SQL for #282 filters, each query reports its rows read and written. Costs: a stateful
  service to run (database, binding, token, schema), daily caps that fail closed, a Worker request
  and a database round trip per query, one primary region.
- **SQLite Durable Objects.** Same Free quotas as D1, plus routing code we would write. Rejected.
- **Query API on the VPS** (DuckDB over gold). Rejected as in ADR 0005: the site would depend on
  the pipeline machine.

### Spatial key in D1

Without R*Tree, a key table `(UTC day, 2° tile, slug)` lets SQLite seek exactly the days and tiles a
query covers. Filtering storm centroids by latitude and longitude ranges misses long tracks and
reads the whole period. 1° tiles quadruple the keys a query probes; 5° tiles read many unrelated
storms in the tropics.

### Place lookup

- Full text search over places in D1: a Worker request and database reads per keystroke.
- An external geocoder: a new provider, its limits and its privacy terms. Out of scope.
- Static prefix files built from the vendored GeoNames file: free, cached, no runtime.

### IP location

`request.cf` in a Worker route, which the queries need anyway. A manual choice alone would leave the
panel empty on arrival; browser geolocation would prompt for a permission #289 excludes.

## Decision

A D1 database written by the hourly catalog run and read by two on-demand Worker routes; place
lookup from static files; coarse IP location from `request.cf`. #282 extends the same database and
routes instead of adding a backend.

### Database

`scintille-search` (Previews: `scintille-search-preview`, seeded from fixtures), location hint
Western Europe. The writer owns the schema (`CREATE ... IF NOT EXISTS`, version in `meta`); a
breaking change creates new tables and refills them.

| Table | Content |
|---|---|
| `storms` | `slug` key, `t_start`, `t_end`, `level`, `score` (ADR 0009: square root of flashes × peak rate), `summary` (the published `StormSummary` JSON, verbatim), `path` (hourly centroids), `radius_km` (disc of the largest hourly area), `digest`. `WITHOUT ROWID`, no other index. |
| `storm_tiles` | Key `(day, tile, slug)`, `WITHOUT ROWID`: one row per UTC day from `t_start` to `t_end` and per 2° tile met by the path, each segment's box widened by `radius_km`. |
| `meta` | Schema version, `last_observation_time` of the synced catalog, `published_at` of the sync. |

### Sync

`storm_catalog` syncs after `publish_catalog`, from exactly the summaries it published and the gold
tracks it already loaded, so search never names a storm whose detail is missing. Rows are compared by
digest with `_pipeline/storms/search-state.json` on R2; changed rows are upserted and expired ones
deleted through the D1 REST API, in transactional batches that pass rows as one JSON parameter
(`json_each`). The state records only committed batches: an interrupted sync resumes at the next
run, and upserts are idempotent. A D1 failure is logged in the run metadata and never fails the
publication. Writes are capped at 60,000 rows a UTC day, counted from the responses; the initial load
spreads over a day or two. Rows leave when `t_start` is 58 days old (replays live 60 days). After a
D1 restore, a `reconcile` command rebuilds the state from D1.

### Routes

Contract `search` v1: JSON schema in `data/contract/`, generated types, version in every response.

- `GET /api/location`: `{status: "approximate", source: "ip", lat, lon, city, region, country_code}`
  with coordinates rounded to 0.1°, only when city and coordinates are known; otherwise
  `{status: "unavailable"}`. A country alone is not a location. No time zone, postal code or IP.
  `Cache-Control: private, no-store`, never stored by the Worker.
- `GET /api/storms/nearby?lat&lon&hours&km&limit`: point rounded to 0.1°, `hours` 1 to 168 (72),
  `km` 10 to 500 (200), `limit` 1 to 8 (4). Out of range is a 400, never clamped. The response echoes
  the rounded point, window and radius, states the catalog (`min_level` 3, `last_observation_time`,
  `published_at`, retention), `status` `ok` or `stale` (last observation older than 3 h), the number
  of matches and the ranked storms, each with its published summary, `distance_km` and score. D1
  errors and exhausted caps return 503 `unavailable`. An empty list means no matching published
  storm, never no lightning. The response depends on the URL only: `public, max-age=60`, and
  `caches.default` keeps it 5 minutes keyed by URL and deployed version (ADR 0005).
- `/places/v1/<xx>.json`: static files keyed by the first two letters of each word of the place name,
  lowercased and without accents; entries `[name, region, country, lat, lon, population]`. The
  client keeps names whose words start with the typed text, most populous first, 8 at most. Built
  with the site from the vendored file; GeoNames is credited next to the picker.

### Semantics

- **Window.** A storm matches when `[t_start, t_end]` meets `[now − hours, now]`, `now` being the
  request time.
- **Distance.** Great-circle distance from the point to the storm path (arcs between its hourly
  centroids, computed on unit vectors, so it holds across the date line and near the poles), minus
  `radius_km`, floored at 0, shown to 10 km. It approximates the distance to the storm's edge; the
  catalog has no flash membership (ADR 0011).
- **Eligible storms.** The whole published catalog (level 3 and above) within retention. The #286
  highlight thresholds (1,000 flashes over an hour) would keep 377 of the 1,766 storms of
  2026-10-28 and leave most places empty, so they do not apply here.
- **Ranking.** `log2(score) − age / 24 h − distance / 100 km`, `age` measured from `t_end` (0 while
  open): doubling the ADR 0009 score is worth one day or 100 km. Ties: nearer, then later `t_end`,
  then slug. The interface shows facts (level, distance, time), not the rank.

## Consequences

| Free limit | Expected use |
|---|---|
| Workers, 100,000 requests a day | 1 location and 1 to 3 nearby requests per panel use |
| D1, 100,000 rows written a day | about 15,000 (6,300 storms, 3,200 tiles, retention deletes), capped at 60,000 |
| D1, 5 million rows read a day | about 100 per default query, about 1,500 for 7 days and 500 km at 60° N |
| D1, 500 MB per database | about 100 MB at 60 days (0.9 KB per storm with its tiles) |
| R2 class A, 1 million a month | +720 (sync state) |
| Static assets | about 600 place files, free |

- These are the first on-demand routes: a request that matches no static file now runs the Worker,
  404s included, as ADR 0005 planned.
- A bot or a bug can exhaust a D1 cap and make search unavailable until 00:00 UTC. On Workers Free it
  cannot cost money. `caches.default` absorbs repeated queries in each data center.
- Each query waits for one round trip to the D1 primary; read replication (Sessions API) only if
  measurements ask for it.
- Privacy page: approximate city of the connection asked to Cloudflare when the panel opens, rounded
  to about 10 km, used for that answer only, never stored, logged or sent to analytics.
- Human steps: Terraform for both databases, a D1 token for the pipeline on the VPS, D1 permission
  for the deploy token.
- #282 adds a search route on the same tables. Country or period filters add indexes, each about
  6,300 more rows written a day. Storms older than their replay would need longer retention; 500 MB
  holds roughly 7 to 10 months of storms.
- The implementation measures rows read and written, latency from several regions, response and
  place file sizes, and a day of sync writes, and records a production sample.

## Sources

- https://developers.cloudflare.com/d1/platform/limits/: 500 MB per database and 5 GB per account
  on Free, 100 bound parameters per query, 100 KB statements.
- https://developers.cloudflare.com/d1/platform/pricing/: 5 million rows read and 100,000 rows
  written a day on Free, errors past the cap, indexes add written rows.
- https://developers.cloudflare.com/d1/sql-api/sql-statements/: FTS5, JSON and math extensions.
- https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/: REST
  query with batches, `rows_read` and `rows_written` in each result.
- https://developers.cloudflare.com/d1/best-practices/read-replication/: replicas need the Sessions
  API, no extra cost.
- https://developers.cloudflare.com/workers/platform/limits/: 100,000 requests a day, 10 ms CPU,
  20,000 asset files per version.
- https://developers.cloudflare.com/workers/runtime-apis/request/: `request.cf` geolocation fields,
  all plans, nullable.
- https://developers.cloudflare.com/waf/rate-limiting-rules/: one rule on Free, IP and path, 10 s.
- https://developers.cloudflare.com/r2/pricing/: 1 million class A and 10 million class B a month.
