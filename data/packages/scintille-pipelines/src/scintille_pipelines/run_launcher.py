"""Run launcher that tells run monitoring when a run worker is gone (ADR 0024)."""

import json
import os

from dagster import DagsterRun, DefaultRunLauncher
from dagster._core.launcher import CheckRunHealthResult, WorkerStatus
from dagster._core.storage.tags import GRPC_INFO_TAG
from dagster._grpc.client import DagsterGrpcClient
from dagster._grpc.types import CanCancelExecutionRequest, CanCancelExecutionResult
from dagster._serdes import deserialize_value

ALIVE = CheckRunHealthResult(WorkerStatus.RUNNING)


class MonitoredRunLauncher(DefaultRunLauncher):
    """A code server lives until its last run ends, so a missing socket, a refused connection or an
    unknown run means the worker died, typically with the daemon container on a deploy. Anything
    unclear counts as alive and is left to the runtime limits."""

    @property
    def supports_check_run_worker_health(self) -> bool:
        return True

    def check_run_worker_health(self, run: DagsterRun) -> CheckRunHealthResult:
        info = json.loads(run.tags.get(GRPC_INFO_TAG, "{}"))
        socket = info.get("socket")
        if socket and not os.path.exists(socket):
            return CheckRunHealthResult(WorkerStatus.FAILED, f"code server socket {socket} is gone")
        if not socket and not info.get("port"):
            return ALIVE
        client = DagsterGrpcClient(
            port=info.get("port"),
            socket=socket,
            host=info.get("host", "localhost"),
            use_ssl=bool(info.get("use_ssl", False)),
        )
        try:
            result = deserialize_value(
                client.can_cancel_execution(
                    CanCancelExecutionRequest(run_id=run.run_id), timeout=10
                ),
                CanCancelExecutionResult,
            )
        except Exception as error:
            code = getattr(error.__cause__, "code", None)
            if callable(code) and code().name == "UNAVAILABLE":
                return CheckRunHealthResult(WorkerStatus.FAILED, "the code server is unreachable")
            return ALIVE
        if result.can_cancel:
            return ALIVE
        return CheckRunHealthResult(
            WorkerStatus.FAILED, "the code server has no worker for this run"
        )
