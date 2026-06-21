"""Tests for log-path resolution on :class:`Settings`."""

from __future__ import annotations

from pathlib import Path

from investment_dashboard.config import Settings


def test_log_dir_defaults_beside_database(tmp_path: Path) -> None:
    settings = Settings(db_path=tmp_path / "data" / "db.sqlite")
    assert settings.resolved_log_dir == tmp_path / "data" / "logs"
    assert settings.log_file_path == tmp_path / "data" / "logs" / "dashboard.log"


def test_log_dir_override_wins(tmp_path: Path) -> None:
    override = tmp_path / "elsewhere"
    settings = Settings(db_path=tmp_path / "db.sqlite", log_dir=override)
    assert settings.resolved_log_dir == override
    assert settings.log_file_path == override / "dashboard.log"


def test_log_dir_for_in_memory_db_uses_data_dir() -> None:
    settings = Settings(db_path=Path(":memory:"))
    # Must not resolve to the working tree ("." parent of ":memory:").
    assert settings.resolved_log_dir.name == "logs"
    assert settings.resolved_log_dir.parent.name == "inv-dashboard"
