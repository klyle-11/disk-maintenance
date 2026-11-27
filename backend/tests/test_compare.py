"""
Tests for POST /api/compare with paths and files typical of external drives.
"""

import os
import sys
from pathlib import Path

import pytest

# main imports `backend.*`, so the project root has to be importable.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from fastapi.testclient import TestClient  # noqa: E402

from backend.main import app, _iso_mtime, _same_mtime  # noqa: E402

client = TestClient(app)

T0 = 1_700_000_001.25


def _write(path: Path, text: str = "abc", mtime: float = T0) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    os.utime(path, (mtime, mtime))


def _compare(source, target) -> dict:
    r = client.post(
        "/api/compare",
        json={"source_path": str(source), "target_path": str(target)},
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_folder_name_with_double_dots_is_accepted(tmp_path):
    src = tmp_path / "Photos"
    dst = tmp_path / "USB DRIVE" / "Backup..2024"
    _write(src / "a.jpg")
    _write(dst / "a.jpg")

    summary = _compare(src, dst)["summary"]
    assert summary["identical"] == 1


@pytest.mark.parametrize("segment", ["..", "...", ".. "])
def test_parent_segment_is_still_rejected(tmp_path, segment):
    (tmp_path / "a").mkdir()
    r = client.post(
        "/api/compare",
        json={
            "source_path": str(tmp_path / "a" / segment / "a"),
            "target_path": str(tmp_path / "a"),
        },
    )
    assert r.status_code == 400
    assert "dangerous" in r.json()["detail"]


@pytest.mark.parametrize("quote", ['"', "'"])
def test_quoted_path_is_accepted(tmp_path, quote):
    src = tmp_path / "src"
    dst = tmp_path / "USB DRIVE" / "src"
    _write(src / "a.txt")
    _write(dst / "a.txt")

    data = _compare(f"{quote}{src}{quote}", f"{quote}{dst}{quote}")
    assert data["target_path"] == str(dst)
    assert data["summary"]["identical"] == 1


def test_fat_rounded_and_dst_shifted_copies_are_identical(tmp_path):
    src = tmp_path / "src"
    dst = tmp_path / "dst"
    for name in ("rounded.txt", "dst.txt", "edited.txt"):
        _write(src / name)
    _write(dst / "rounded.txt", mtime=T0 + 0.75)  # FAT32 2 s rounding
    _write(dst / "dst.txt", mtime=T0 + 3600)  # FAT local time across DST
    _write(dst / "edited.txt", mtime=T0 + 100)  # a real later edit

    summary = _compare(src, dst)["summary"]
    assert summary["identical"] == 2
    assert summary["modified"] == 1


def test_same_mtime_bounds():
    assert _same_mtime(T0, T0 + 2)
    assert not _same_mtime(T0, T0 + 3)
    assert _same_mtime(T0, T0 - 3600)
    assert not _same_mtime(T0, T0 + 7200)


def test_out_of_range_timestamp_does_not_fail():
    assert _iso_mtime(1e20) is None
    assert _iso_mtime(T0) is not None
