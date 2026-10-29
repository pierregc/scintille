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
- Storms are scarce in some places and seasons: over the 7 days to 2026-10-29, Europe had 67
  published storms, 54 of them in Turkey, 2 in Italy and none in mainland France. A 200 or 500 km
  radius would often answer nothing, so the service must also reach the nearest storms far away.

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

Without R*Tree, a key table `(UTC day, tile, slug)` lets SQLite seek exactly the days and tiles a
query covers. Filtering storm centroids by latitude and longitude ranges misses long tracks and
reads the whole period. For radii up to 500 km, 2° tiles: 1° tiles quadruple the keys a query
probes, 5° tiles read many unrelated storms in the tropics. Beyond, up to 3,000 km, 2° tiles would
mean thousands of keys, so the same table also holds 10° tiles.

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

`scintille-search` (Previews: `scintille-search-preview`, loaded by hand with a production sample),
location hint Western Europe. The writer owns the schema (`CREATE ... IF NOT EXISTS`, version in `meta`); a
breaking change creates new tables and refills them.

| Table | Content |
|---|---|
| `storms` | `slug` key, `t_start`, `t_end`, `level`, `score` (ADR 0009: square root of flashes × peak rate), `summary` (the published `StormSummary` JSON, verbatim), `path` (hourly centroids), `radius_km` (disc of the largest hourly area), `c_lat`, `c_lon` and `spread_km` (spherical mean of the path and the distance to its farthest point, which bound distances in SQL), `digest`. `WITHOUT ROWID`, no other index. |
| `storm_tiles` | Key `(day, tile, slug)`, `WITHOUT ROWID`: one row per UTC day from `t_start` to `t_end` and per 2° and 10° tile met by the path, each segment's box widened by `radius_km` and 10 km for the arc's bulge. |
| `meta` | Schema version, `last_observation_time` of the synced catalog, `published_at` of the sync, storms still `pending`, retention. |

### Sync

`storm_catalog` syncs after `publish_catalog`, from exactly the summaries it published and the gold
tracks it already loaded, so search never names a storm whose detail is missing. Rows are compared by
digest with `_pipeline/storms/search-state.json.gz` on R2, which also keeps each storm's tiles; changed rows are upserted and expired ones
deleted through the D1 REST API, in transactional batches that pass rows as one JSON parameter
(`json_each`). The state records only committed batches: an interrupted sync resumes at the next
run, and upserts are idempotent. A D1 failure is logged in the run metadata and never fails the
publication. Writes are capped at 50,000 rows a UTC day (the D1 cap is per account), counted from the responses, most recent
storms first; the initial load (about 150,000 rows for the 32,000 storms published so far) spreads
over three days. Rows leave when `t_start` is 58 days
old (replays live 60 days). Without a state file, the run rebuilds it from D1: deleting the file is
the recovery after a D1 restore.

### Routes

Contract `search` v1: JSON schema in `data/contract/`, generated types, version in every response.

- `GET /api/location` (`VisitorLocation`): `status` `approximate` with `lat`, `lon` rounded to 0.1°,
  `city`, `region`, `country_code`, only when the city and its coordinates are known; otherwise
  `unavailable` with nulls. A country alone is not a location. No time zone, postal code or IP.
  `Cache-Control: private, no-store`, never stored by the Worker.
- `GET /api/storms/nearby?lat&lon&hours&km&limit` (`StormsNearby`): point rounded to 0.1°, `hours`
  1 to 168 (72), `km` 10 to 3,000 (200), `limit` 1 to 8 (4). Out of range is a 400, never clamped.
  The response echoes the rounded point, window and radius, states the catalog (`min_level` 3,
  retention, `published_at`, `last_observation_time`, `stale` past 3 hours, `complete` once nothing
  waits to be indexed), the number of matches and the ranked storms, each with its published summary,
  `distance_km` and score. SQL keeps the storms whose centroid bound can reach the disc and returns
  them without paths; the Worker reads the paths of the storms near the edge and of those that may
  rank, and counts the others as certainly in. More than 4,000 candidates or 400 paths is a 422
  `too-broad`; D1 errors and exhausted
  caps are a 503 `unavailable`. An empty list means no matching published storm, never no
  lightning. The response depends on the URL only: `public, max-age=60`, and `caches.default` keeps
  it 5 minutes keyed by the normalized query and the deployed version (ADR 0005). The interface may
  ask a second, explicitly wider query when the first is empty; the service never widens by itself.
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
| D1, 100,000 rows written a day | about 22,000 (4.8 rows per storm measured, updates and retention), capped at 50,000 |
| D1, 5 million rows read a day | measured on 3 days of real storms: 24 to 550 rows for 200 km and 72 h, up to 1,700 for 500 km and 7 days, 400 to 7,200 for 3,000 km and 7 days (about twice with a full week) |
| D1, 500 MB per database | about 100 MB at 60 days (0.9 KB per storm with its tiles) |
| R2 class A, 1 million a month | +720 (sync state) |
| Static assets | 436 place files, 1.1 MB gzip in all, 40 KB for the largest |

- These are the first on-demand routes. The adapter's Worker already answers requests that match no
  static file (404s); static assets stay free and unmetered.
- A bot or a bug can exhaust a D1 cap and make search unavailable until 00:00 UTC. On Workers Free it
  cannot cost money. `caches.default` absorbs repeated queries in each data center.
- Each query waits for one round trip to the D1 primary; read replication (Sessions API) only if
  measurements ask for it.
- Privacy page: approximate city of the connection asked to Cloudflare when the panel opens, rounded
  to about 10 km, used for that answer only, never stored, logged or sent to analytics.
- Human steps: D1 permission for the Terraform and deploy tokens, Terraform for both databases, a
  D1 token for the pipeline on the VPS.
- #282 adds a search route on the same tables. Country or period filters add indexes, each about
  6,300 more rows written a day. Storms older than their replay would need longer retention; 500 MB
  holds roughly 7 to 10 months of storms.
- Measurements: `docs/analysis/search/measure.py` and its results. Loading 3 days (5,400 storms)
  wrote 25,700 rows. The candidate query takes 130 to 270 ms through the REST API from Europe,
  network included. Parsing and ranking 2,000 light candidates takes under 3 ms of CPU on a laptop.
  Wide queries cost the most reads: about 700 uncached ones a day would exhaust the read cap, so
  they are meant as an explicit second step where nothing is near.

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
