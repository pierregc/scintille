# Operations

How Scintille is watched in production and what to do when an alert fires. Everything here is free:
[Healthchecks.io](https://healthchecks.io) for heartbeats, alerts by email to the maintainer.

## Signals

| Signal | Detects | Alerts |
|---|---|---|
| Container healthcheck (`ingest`, `GET :8080/healthz`) | A source or disk loop died | `docker compose ps` shows `unhealthy`; a deploy rolls back |
| Heartbeat `ingest-live` | Collector stopped, crashed, VPS down, a loop stopped | Healthchecks.io, within 5 min |
| Heartbeat `live-manifest` | Public manifest older than 3 min, unreadable or invalid, or https://scintille.app down | Healthchecks.io, within 1 min |
| Heartbeat `active-storms` | `storms/active.json` not rewritten for 15 min | Healthchecks.io, within 15 min |
| Heartbeat `storm-catalog` | Catalog's last tracked hour over 3 h old (`authoritative_until`) | Healthchecks.io, at the next update |
| Heartbeat `pipelines` | Gold not rebuilt for 45 min, a job failing, Dagster daemon down | Healthchecks.io, within 15 min |
| Dagster sensor `alert_on_failure` | Each failed run, retried or not | `SCINTILLE_ALERT_WEBHOOK` if set ([pipelines](pipelines.md)) |

### Collector heartbeat

`ingest-live` pings `SCINTILLE_HEALTHCHECK_URL` every 60 s from its main loop while every source loop
runs. When one has stopped, it pings `<url>/fail` with the names of the stopped loops. When the
collector or the VPS stops, the pings stop and Healthchecks.io alerts once the grace time is over.

Pings are best effort: a timeout or an outage of Healthchecks.io only counts
`heartbeat_errors_total` in `/metrics` and logs a warning, it never slows down or stops ingestion.
Without the variable, nothing is pinged.

### Live manifest freshness

The `live-probe` service (`scintille-ingest live-probe`) reads the public manifest
(https://data.scintille.app/live/manifest.json, through Cloudflare like a visitor) every 60 s and
checks `generated_at` against the clock. The manifest is rewritten at least every 30 s, so older than 180 s
means the live feed is stuck even if the collector looks alive (R2 writes failing, a cache serving an
old copy). It also reads https://scintille.app. It pings `SCINTILLE_HEALTHCHECK_LIVE_URL` when both pass and
`<url>/fail` with the reason otherwise (`stale: generated 240 s ago`, `unreachable: URLError (timed out)`,
`invalid manifest`, `site unreachable: HTTPError (Service Unavailable)`). About 3 % of reads from the VPS
failed in November with a bare `URLError`, isolated, so a failed read is retried twice, 10 s apart,
before it counts; the logs keep each retry with its reason.

The probe runs on the VPS, but the alert does not depend on it: if the VPS is down, the pings stop
and the check goes down too. A one-off check from anywhere:

```sh
uv run scintille-ingest live-probe --once   # exit code 1 if not fresh, never pings
```

`--url` (or `SCINTILLE_LIVE_MANIFEST_URL`), `--site-url` (empty to skip) and `--max-age` override the
defaults.

### Pipelines

The `ops_status` sensor runs every minute in the Dagster daemon and pings
`SCINTILLE_HEALTHCHECK_PIPELINES_URL`. It pings `<url>/fail` when gold was last built over 45 minutes
ago (gold is rebuilt only when silver changes, so this also catches a stuck `lake-writer`) or when a
job is failing: its latest runs failed, with none queued or running and the last one ended over
3 minutes ago, time for run retries to start. One failed run is enough, except for
`silver_hourly_checks` (three in a row: short source gaps fail one or two hourly checks, about
twice a week) and `daily_gold` (two in a row: the next run usually succeeds). Manual runs (`__ASSET_JOB`) never count. When
the daemon stops, the pings stop. Healthchecks.io emails on each change of state only, so a job
failing for hours sends one email, and another when it recovers.

### Active storms

The `active-storms` service ([ADR 0021](adr/0021-active-storm-cells.md)) pings
`SCINTILLE_HEALTHCHECK_ACTIVE_URL` after each snapshot it writes, every 5 minutes. A failed update
keeps the previous object; once the last write is over 15 minutes old it pings `<url>/fail` with the
error. It pings `SCINTILLE_HEALTHCHECK_CATALOG_URL` after each update, `/fail` when the catalog's
last tracked hour ended over 3 hours ago: the feed keeps working, but its ids stay provisional.

`GET :8082/metrics` reports each update: `active_storms_processing_seconds` (start to written),
`active_storms_age_seconds{source}` (`published_at - observed_until`), `active_storms_catalog_lag_seconds`,
`active_storms_final_id_share{scope}` once the catalog tracks an hour, snapshot size and files read.

## Setup (by hand, once)

1. **Healthchecks.io.** Create an account and a project, add the maintainer's email as an
   integration, then five checks:

   | Check | Schedule | Grace time | Variable in `/srv/scintille/.env` |
   |---|---|---|---|
   | `ingest-live` | Simple, period 1 minute | 2 minutes | `SCINTILLE_HEALTHCHECK_URL` |
   | `live-manifest` | Simple, period 1 minute | 2 minutes | `SCINTILLE_HEALTHCHECK_LIVE_URL` |
   | `active-storms` | Simple, period 5 minutes | 10 minutes | `SCINTILLE_HEALTHCHECK_ACTIVE_URL` |
   | `storm-catalog` | Simple, period 5 minutes | 10 minutes | `SCINTILLE_HEALTHCHECK_CATALOG_URL` |
   | `pipelines` | Simple, period 5 minutes | 10 minutes | `SCINTILLE_HEALTHCHECK_PIPELINES_URL` |

   With a 1-minute period and 2 minutes of grace, a stopped collector is reported 3 to 4 minutes
   after its last ping. A `/fail` ping alerts at once. Ping URLs hold a secret UUID: keep them in
   `.env` only ([secrets](secrets.md)).
2. **Deploy.** Recreate the services so they read the new variables:
   `docker compose up -d` in the current release.

## Test

Stopping the collector must raise an alert within 5 minutes:

```sh
docker compose stop ingest     # note the time
# within 5 min: "ingest-live is DOWN" email, then "live-manifest is DOWN" about 4 min after the stop
docker compose start ingest    # both checks come back up at the next ping
```

## When an alert fires

- **`ingest-live` down.** `docker compose ps` on the VPS, then the logs of `ingest`
  (`journalctl CONTAINER_NAME=<container>`). A `/fail` names the stopped loop:
  `docker compose restart ingest` and look for the error that stopped it. If the VPS does not
  answer, check it in the OVH console.
- **`live-manifest` down while `ingest-live` is up.** The collector runs but the feed is not
  published: look for live feed errors in the `ingest` logs (R2 credentials, R2 outage), then fetch
  the manifest by hand and compare its `generated_at` with the time.
- **`active-storms` down.** The logs of `active-storms` name the failed step (silver, catalog,
  contract check, R2 write); the public object keeps its last snapshot and visitors see its age.
- **`storm-catalog` down.** `hourly_storm_catalog` stopped tracking hours: see the runs in the
  Dagster UI and catch up as in [pipelines](pipelines.md).
- **`live-manifest` fails with `site unreachable`.** Check the Cloudflare status page and the last
  `web` deploy ([deploy](deploy.md)).
- **`pipelines` down.** The `/fail` body names the problem. `gold last built ... ago`: is
  `lake-writer` committing (its logs), is the daemon up (`docker compose ps`)? `<job> failing`: open
  its last run in the Dagster UI ([deploy](deploy.md#data-services)). No ping at all: the daemon
  or the VPS is down.
- **Runs stuck in `NOT_STARTED`.** A run whose submission failed (#271) is never launched. Run
  monitoring marks it failed after 10 minutes. Fix the cause, let the next schedule and sensor ticks
  submit fresh runs, and backfill the missed `daily_gold` partitions from the UI.
- **Run killed by a deploy.** A deploy restarts the daemon and its run workers. Run monitoring fails
  the run within about two minutes and run retries relaunch it ([ADR 0024](adr/0024-deploys-during-runs.md));
  nothing to do by hand. A run still `STARTED` long after a deploy points to a broken health check.

## Reboots

Unattended upgrades install Debian security updates every day. When one needs a reboot (kernel,
core libraries), the host reboots by itself at the next 04:20 UTC, after the nightly jobs and
before the hourly catalog run at :35 ([`bootstrap.sh`](../infra/vps/bootstrap.sh)). Docker starts at
boot and every service has `restart: unless-stopped`, so the stack comes back without a deploy:

- Compose `depends_on` is not applied at boot: `ingest`, `lake-writer` and Dagster may restart a
  few times until Postgres is ready.
- `ingest` continues the published manifest; flashes still in its outbox go into the next chunk
  ([hot path](hot-path.md)). `clouds` continues its manifest too.
- A Dagster run cut by the reboot is failed by run monitoring and retried, as after a deploy.
- `lake-writer` and `live-probe` have no health check (#194): only the `pipelines` heartbeat (gold
  not rebuilt for 45 min) shows a `lake-writer` that did not come back.
- The minute or two offline can raise a short `ingest-live` or `live-manifest` alert.

After a reboot, as `deploy`: `uptime`, no `/var/run/reboot-required`, and `docker compose ps` in
`/srv/scintille` shows every service running, `healthy` where it has a health check; the
Healthchecks.io checks are up. To reboot outside the window, `sudo reboot` as `debian`, then the same checks.
