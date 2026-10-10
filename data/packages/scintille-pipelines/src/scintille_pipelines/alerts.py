"""Failure alerts: a JSON POST to `SCINTILLE_ALERT_WEBHOOK` when a run fails."""

import json
import os
import urllib.request
from typing import Any

from dagster import RunFailureSensorContext, run_failure_sensor


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
    description="Posts failed runs, including blocking check failures, to a webhook."
)
def alert_on_failure(context: RunFailureSensorContext) -> None:
    url = os.environ.get("SCINTILLE_ALERT_WEBHOOK")
    if not url:
        context.log.warning("SCINTILLE_ALERT_WEBHOOK is not set; failure not sent")
        return
    run = context.dagster_run
    message = context.failure_event.message or "unknown error"
    post_json(url, failure_payload(run.job_name, run.run_id, message))
