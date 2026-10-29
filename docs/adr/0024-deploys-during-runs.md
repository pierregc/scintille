# 0024 · Deploys during Dagster runs: fail dead runs fast and retry them

- Status: accepted
- Date: 2026-10-29

## Context

Every merge touching `data/` or the compose file redeploys the VPS and recreates the Dagster daemon
container. Run workers live in that container (default run launcher, code server started by the
daemon), so a deploy kills the runs in progress. Dagster's `DefaultRunLauncher` cannot tell run
monitoring that a worker is gone: the run stays `STARTED` until its runtime limit (1 hour for the
storm catalog, 6 hours otherwise), keeps its concurrency slot and blocks its pool (#326).

## Options

- **Drain before deploying.** Pause the queue, wait for runs to end, then recreate the daemon.
  Deploys wait minutes, longer during backfills, and a deploy that times out still kills runs.
- **Run workers outside the daemon** (`DockerRunLauncher`, one container per run). Runs survive a
  daemon restart and the launcher can resume them, but each run starts a container and needs the
  Docker socket in the daemon: more moving parts and memory on an 8 GB VPS.
- **Startup sweep.** Mark every in-progress run failed when the daemon starts. Simple, but wrong
  for a run launched from elsewhere.
- **Health check in the launcher.** Subclass `DefaultRunLauncher` so that run monitoring can ask
  whether the worker is alive, and let run retries relaunch dead runs.

## Decision

`MonitoredRunLauncher` answers run monitoring's health check. A code server keeps its socket until
its last run ends, so a missing socket, a refused connection, or a server that does not know the run
means the worker died; any other error counts as alive and is left to the runtime limits. Run
monitoring polls every minute and fails the run; `run_retries` relaunches it from the failure, at
most twice. Step failures are not retried this way (`retry_on_asset_or_op_failure: false`): assets
keep their own retry policies.

## Consequences

- A deploy can happen at any time: runs it kills are failed within about two minutes of the new
  daemon starting and rerun on their own, with no manual `terminateRun`.
- The launcher relies on two internals of Dagster (the gRPC tag on runs and `CanCancelExecution`);
  a Dagster upgrade must keep `tests/test_run_launcher.py` green.
- A killed run still loses the work of its current step. Long backfills are retried from the failed
  step, not from the start.
