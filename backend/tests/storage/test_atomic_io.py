"""Tests for the crash-safe atomic-write helper (C2)."""

from __future__ import annotations

from pathlib import Path

from investment_dashboard.storage.atomic_io import atomic_write_bytes, atomic_write_text


def test_atomic_write_text_creates_file(tmp_path: Path) -> None:
    target = tmp_path / "out.json"
    atomic_write_text(target, '{"a": 1}')
    assert target.read_text(encoding="utf-8") == '{"a": 1}'


def test_atomic_write_creates_parent_dirs(tmp_path: Path) -> None:
    target = tmp_path / "nested" / "dir" / "blob.enc"
    atomic_write_bytes(target, b"\x00\x01\x02")
    assert target.read_bytes() == b"\x00\x01\x02"


def test_atomic_write_overwrites_existing(tmp_path: Path) -> None:
    target = tmp_path / "out.txt"
    target.write_text("old", encoding="utf-8")
    atomic_write_text(target, "new")
    assert target.read_text(encoding="utf-8") == "new"


def test_no_temp_file_left_behind(tmp_path: Path) -> None:
    target = tmp_path / "out.txt"
    atomic_write_text(target, "content")
    # Only the final file should remain — no ``.out.txt.tmp.<pid>`` sidecar.
    leftovers = [p.name for p in tmp_path.iterdir() if p.name != "out.txt"]
    assert leftovers == []
