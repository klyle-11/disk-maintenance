"""
Tests for running di from the app's di window (backend/di_runner.py and the
/api/di endpoints).
"""

import json
import os
import sys
from pathlib import Path

import pytest

# di_runner imports `backend.*`, so the project root has to be importable.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend import di_runner  # noqa: E402


@pytest.mark.parametrize(
    "argv",
    [
        ["clean", "--yes"],
        ["clean", "~/dev", "-y"],
        ["clean", "--ye"],  # argparse accepts abbreviations
        ["caches", "-vy"],  # and bundled short flags
        ["guard", "--install"],
        ["guard", "--uninstall"],
        ["guard", "--auto"],
        ["ballast", "set", "5G"],
        ["ballast", "release"],
        ["forget", "abc123"],
    ],
)
def test_destructive_commands_are_flagged(argv):
    assert di_runner.destructive_reason(argv)


@pytest.mark.parametrize(
    "argv",
    [
        [],
        ["summary"],
        ["scan", "/", "-d", "1"],
        ["clean", "~/dev"],  # a dry run
        ["caches", "-v"],
        ["guard"],
        ["ballast"],
        ["help", "clean"],
        ["clean", "--help"],
        ["no-such-command"],  # di reports the error itself
    ],
)
def test_read_only_commands_run_without_confirmation(argv):
    assert di_runner.destructive_reason(argv) is None


def test_serve_is_refused():
    with pytest.raises(di_runner.DiRequestError):
        di_runner.validate_argv(["serve"])


@pytest.mark.parametrize("argv", [["scan", "a\x00b"], ["x"] * 40, ["y" * 5000], "scan", [1, 2]])
def test_bad_arguments_are_refused(argv):
    with pytest.raises(di_runner.DiRequestError):
        di_runner.validate_argv(argv)


def test_tilde_is_expanded_like_a_shell_would():
    home = os.path.expanduser("~")
    argv = di_runner.validate_argv(["insights", "~", "~/dev", "a~b"])
    assert argv == ["insights", home, os.path.join(home, "dev"), "a~b"]


def test_destructive_register_needs_confirmation():
    with pytest.raises(di_runner.DiRequestError) as excinfo:
        di_runner.register(["clean", "--yes"], 100, confirmed=False)
    assert excinfo.value.needs_confirm


def test_runs_can_only_be_claimed_once():
    run = di_runner.register(["summary"], 100, confirmed=False)
    try:
        assert di_runner.claim(run.id) is run
        assert di_runner.claim(run.id) is None
    finally:
        di_runner.finish(run)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    from backend.main import app

    return TestClient(app)


def _events(response) -> list[dict]:
    return [json.loads(line[len("data: "):]) for line in response.text.splitlines() if line.startswith("data: ")]


def test_health_reports_the_api_version(client):
    # The app refuses a backend whose API doesn't match (see API_VERSION in
    # main.py, frontend/electron/backend.cjs and frontend/src/api.ts).
    from backend.main import API_VERSION

    assert client.get("/api/health").json() == {"status": "ok", "api": API_VERSION}
    assert API_VERSION >= 2  # the di endpoints arrived in API 2


def test_di_commands_lists_commands_except_serve(client):
    names = [c["name"] for c in client.get("/api/di/commands").json()["commands"]]
    assert "scan" in names and "tips" in names
    assert "serve" not in names


def test_run_streams_coloured_output_and_exit_code(client, tmp_path):
    (tmp_path / "big").mkdir()
    (tmp_path / "big" / "file.bin").write_bytes(b"x" * (2 << 20))
    start = client.post("/api/di/runs", json={"args": ["scan", str(tmp_path), "-m", "1MB"], "columns": 90})
    assert start.status_code == 200
    stream = client.get(f"/api/di/runs/{start.json()['runId']}/stream")
    events = _events(stream)
    output = "".join(e["data"] for e in events if e["type"] == "out")
    assert "\x1b[" in output  # colour is forced on
    assert "big" in output
    assert events[-1] == {"type": "exit", "code": 0, "elapsed": events[-1]["elapsed"]}


def test_run_needs_json_content_type(client):
    response = client.post(
        "/api/di/runs",
        content=json.dumps({"args": ["summary"]}),
        headers={"Content-Type": "text/plain"},
    )
    assert response.status_code in (415, 422)


def test_destructive_run_answers_409_until_confirmed(client):
    response = client.post("/api/di/runs", json={"args": ["ballast", "release"]})
    assert response.status_code == 409
    assert response.json()["detail"]["needsConfirm"] is True


def test_unknown_run_is_404(client):
    assert client.get("/api/di/runs/nope/stream").status_code == 404
