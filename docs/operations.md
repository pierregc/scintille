# Operations

How Scintille is watched in production and what to do when an alert fires. Everything here is free:
[Healthchecks.io](https://healthchecks.io) for heartbeats, an external uptime monitor for the site,
alerts by email to the maintainer.

## Signals

| Signal | Detects | Alerts |
|---|---|---|
| Container healthcheck (`ingest`, `GET :8080/healthz`) | A source or disk loop died | `docker compose ps` shows `unhealthy`; a deploy rolls back |
| Heartbeat `ingest-live` | Collector stopped, crashed, VPS down, a loop stopped | Healthchecks.io, within 5 min |
| Heartbeat `live-manifest` | Public manifest older than 3 min, unreadable or invalid | Healthchecks.io, within 1 min |
| Uptime of https://scintille.app | Site down or erroring | External monitor |
| Dagster sensor `alert_on_failure` | A pipeline run failed | `SCINTILLE_ALERT_WEBHOOK` ([pipelines](pipelines.md)) |

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
checks `generated_at` against the clock. The manifest is rewritten every 30 s, so older than 180 s
means the live feed is stuck even if the collector looks alive (R2 writes failing, a cache serving an
old copy). It pings `SCINTILLE_HEALTHCHECK_LIVE_URL` when fresh and `<url>/fail` with the reason
otherwise (`stale: generated 240 s ago`, `unreachable: HTTPError`, `invalid manifest`).

The probe runs on the VPS, but the alert does not depend on it: if the VPS is down, the pings stop
and the check goes down too. A one-off check from anywhere:

```sh
uv run scintille-ingest live-probe --once   # exit code 1 if not fresh
```

`--url` (or `SCINTILLE_LIVE_MANIFEST_URL`) and `--max-age` override the defaults.

## Setup (by hand, once)

1. **Healthchecks.io.** Create an account and a project, add the maintainer's email as an
   integration, then two checks:

   | Check | Schedule | Grace time | Variable in `/srv/scintille/.env` |
   |---|---|---|---|
   | `ingest-live` | Simple, period 1 minute | 2 minutes | `SCINTILLE_HEALTHCHECK_URL` |
   | `live-manifest` | Simple, period 1 minute | 2 minutes | `SCINTILLE_HEALTHCHECK_LIVE_URL` |

   With a 1-minute period and 2 minutes of grace, a stopped collector is reported 3 to 4 minutes
   after its last ping. A `/fail` ping alerts at once. Ping URLs hold a secret UUID: keep them in
   `.env` only ([secrets](secrets.md)).
2. **Uptime.** In an external uptime monitor (for example UptimeRobot, free plan), add an HTTPS
   monitor on https://scintille.app every 5 minutes, alerting the same email.
3. **Deploy.** Restart the services so they read the new variables:
   `docker compose up -d ingest live-probe` in the current release.

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
- **Site down.** Check the Cloudflare status page and the last `web` deploy ([deploy](deploy.md)).
- **Pipeline run failed.** Open the run in the Dagster UI ([deploy](deploy.md#data-services)).
