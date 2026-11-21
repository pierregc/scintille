"""Failure alerts: a webhook per failed run, and a pipeline heartbeat for Healthchecks.io."""

import json
import os
import urllib.request
from collections.abc import Iterable
from datetime import datetime, timedelta
from typing import Any

from dagster import (
    DagsterInstance,
    DagsterRunStatus,
    DefaultSensorStatus,
    RunFailureSensorContext,
    RunsFilter,
    run_failure_sensor,
)
from scintille_ingest.runtime.heartbeat import http_post

PIPELINES_HEALTHCHECK = "SCINTILLE_HEALTHCHECK_PIPELINES_URL"
GOLD_MAX_AGE = timedelta(minutes=45)
# Before a job counts as failing; short source gaps fail one or two hourly check runs.
FAILURES_BEFORE_ALERT = {"silver_hourly_checks": 3, "daily_gold": 2, "hourly_cyclones": 3}
# Leaves time for run retries to start a new run.
RETRY_GRACE = timedelta(minutes=3)


def failure_payload(job: str, run_id: str, message: str) -> dict[str, Any]:
    return {"text": f"Scintille: run {run_id[:8]} of {job} failed", "job": job, "error": message}


def post_json(url: str, payload: dict[str, Any]) -> None:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10):
        pass


@run_failure_sensor(
    default_status=DefaultSensorStatus.RUNNING,
    description="Posts failed runs, including blocking check failures, to a webhook.",
)
def alert_on_failure(context: RunFailureSensorContext) -> None:
    url = os.environ.get("SCINTILLE_ALERT_WEBHOOK")
    if not url:
        return
    run = context.dagster_run
    message = context.failure_event.message or "unknown error"
    post_json(url, failure_payload(run.job_name, run.run_id, message))


def failing(instance: DagsterInstance, job: str, now: datetime) -> bool:
    """The job's latest runs all failed, and no run of it is queued or in progress."""
    needed = FAILURES_BEFORE_ALERT.get(job, 1)
    records = instance.get_run_records(RunsFilter(job_name=job), limit=needed)
    if len(records) < needed:
        return False
    if any(r.dagster_run.status != DagsterRunStatus.FAILURE for r in records):
        return False
    ended = records[0].end_time
    return ended is not None and now.timestamp() - ended >= RETRY_GRACE.total_seconds()


def pipeline_health(
    instance: DagsterInstance, jobs: Iterable[str], gold_built: datetime | None, now: datetime
) -> tuple[bool, str]:
    problems = [f"{job} failing" for job in sorted(jobs) if failing(instance, job, now)]
    if gold_built is None or now - gold_built > GOLD_MAX_AGE:
        minutes = None if gold_built is None else (now - gold_built).total_seconds() / 60
        age = "never" if minutes is None else f"{minutes:.0f} min ago"
        problems.insert(0, f"gold last built {age}")
    return (False, "; ".join(problems)) if problems else (True, "gold fresh, no job failing")


def ping(ok: bool, message: str) -> bool:
    """Best effort: a Healthchecks.io outage never fails the sensor."""
    url = os.environ.get(PIPELINES_HEALTHCHECK)
    if not url:
        return False
    target = url.rstrip("/") + ("" if ok else "/fail")
    try:
        http_post(target, message.encode(), 10.0)
    except Exception:
        return False
    return True
