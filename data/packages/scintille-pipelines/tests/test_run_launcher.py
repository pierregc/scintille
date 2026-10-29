"""MonitoredRunLauncher against a real code server (#326)."""

import json
import os
import socket
import tempfile
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from dagster import DagsterInstance, DagsterRunStatus, job, op
from dagster._core.launcher import WorkerStatus
from dagster._core.storage.tags import GRPC_INFO_TAG
from dagster._core.test_utils import create_run_for_test, instance_for_test
from dagster._core.workspace.context import WorkspaceProcessContext
from dagster._core.workspace.load_target import PythonFileTarget
from dagster_shared.yaml_utils import load_yaml_from_path

RELEASE = "SCINTILLE_TEST_RELEASE"


@op
def wait_for_release() -> None:
    deadline = time.monotonic() + 60
    while not Path(os.environ[RELEASE]).exists() and time.monotonic() < deadline:
        time.sleep(0.1)


@job
def held() -> None:
    wait_for_release()


@pytest.fixture
def instance(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[DagsterInstance]:
    monkeypatch.setenv(RELEASE, str(tmp_path / "release"))
    launcher = {"module": "scintille_pipelines.run_launcher", "class": "MonitoredRunLauncher"}
    with instance_for_test(overrides={"run_launcher": launcher}) as instance:
        yield instance


def health(instance: DagsterInstance, run_id: str, grpc_info: dict[str, object]) -> WorkerStatus:
    instance.add_run_tags(run_id, {GRPC_INFO_TAG: json.dumps(grpc_info)})
    run = instance.get_run_by_id(run_id)
    assert run is not None
    return instance.run_launcher.check_run_worker_health(run).status


def test_live_worker_is_running_and_unknown_runs_failed(instance: DagsterInstance) -> None:
    target = PythonFileTarget(
        python_file=__file__, attribute=None, working_directory=None, location_name="test"
    )
    with WorkspaceProcessContext(instance, target) as context:
        workspace = context.create_request_context()
        location = workspace.get_code_location("test")
        remote = next(iter(location.get_repositories().values())).get_full_job("held")
        run = instance.create_run_for_job(
            job_def=held,
            remote_job_origin=remote.get_remote_origin(),
            job_code_origin=remote.get_python_origin(),
        )
        instance.launch_run(run.run_id, workspace)
        deadline = time.monotonic() + 60
        while instance.get_run_by_id(run.run_id).status != DagsterRunStatus.STARTED:  # type: ignore[union-attr]
            assert time.monotonic() < deadline
            time.sleep(0.2)
        started = instance.get_run_by_id(run.run_id)
        assert started is not None
        grpc_info = json.loads(started.tags[GRPC_INFO_TAG])
        try:
            assert instance.run_launcher.check_run_worker_health(started).status == (
                WorkerStatus.RUNNING
            )
            stranger = create_run_for_test(instance, job_name="held")
            assert health(instance, stranger.run_id, grpc_info) == WorkerStatus.FAILED
        finally:
            Path(os.environ[RELEASE]).touch()
        instance.run_launcher.join(timeout=60)


def test_gone_or_dead_code_server_fails_the_run(instance: DagsterInstance, tmp_path: Path) -> None:
    run_id = create_run_for_test(instance, job_name="held").run_id
    assert health(instance, run_id, {"host": "localhost", "socket": str(tmp_path / "gone")}) == (
        WorkerStatus.FAILED
    )
    with tempfile.TemporaryDirectory(dir="/tmp") as short:
        stale = os.path.join(short, "s")
        with socket.socket(socket.AF_UNIX) as server:
            server.bind(stale)
        assert health(instance, run_id, {"host": "localhost", "socket": stale}) == (
            WorkerStatus.FAILED
        )


def test_run_without_code_server_counts_as_alive(instance: DagsterInstance) -> None:
    run = create_run_for_test(instance, job_name="held")
    assert instance.run_launcher.check_run_worker_health(run).status == WorkerStatus.RUNNING


def test_production_instance_fails_and_retries_dead_runs() -> None:
    config: Any = load_yaml_from_path(str(Path(__file__).parents[1] / "dagster_home/dagster.yaml"))
    assert config["run_launcher"]["class"] == "MonitoredRunLauncher"
    assert config["run_monitoring"]["enabled"]
    assert config["run_retries"] == {
        "enabled": True,
        "max_retries": 2,
        "retry_on_asset_or_op_failure": False,
    }
