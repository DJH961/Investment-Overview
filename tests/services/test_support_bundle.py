"""Tests for the shareable support-bundle service."""

from __future__ import annotations

from pathlib import Path

import pytest

from investment_dashboard.config import Settings
from investment_dashboard.services import support_bundle


def _patch_settings(monkeypatch: pytest.MonkeyPatch, settings: Settings) -> None:
    monkeypatch.setattr(support_bundle, "get_settings", lambda: settings)


def test_read_recent_log_text_missing_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    settings = Settings(db_path=tmp_path / "db.sqlite")
    _patch_settings(monkeypatch, settings)
    text = support_bundle.read_recent_log_text()
    assert "no log file found" in text


def test_read_recent_log_text_tails_large_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = Settings(db_path=tmp_path / "db.sqlite")
    _patch_settings(monkeypatch, settings)
    log_file = settings.log_file_path
    log_file.parent.mkdir(parents=True, exist_ok=True)
    lines = [f"line {i}\n" for i in range(1000)]
    log_file.write_text("".join(lines), encoding="utf-8")

    text = support_bundle.read_recent_log_text(max_bytes=100)
    assert "line 999" in text
    assert "line 0\n" not in text


def test_read_recent_log_text_redacts_secret(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = Settings(db_path=tmp_path / "db.sqlite")
    _patch_settings(monkeypatch, settings)
    log_file = settings.log_file_path
    log_file.parent.mkdir(parents=True, exist_ok=True)
    log_file.write_text("leaked ghp_" + "B" * 30 + "\n", encoding="utf-8")

    text = support_bundle.read_recent_log_text()
    assert "ghp_" not in text
    assert "«redacted»" in text


def test_build_support_bundle_has_header_and_logs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = Settings(db_path=tmp_path / "db.sqlite")
    _patch_settings(monkeypatch, settings)
    settings.log_file_path.parent.mkdir(parents=True, exist_ok=True)
    settings.log_file_path.write_text("a diagnostic line\n", encoding="utf-8")

    bundle = support_bundle.build_support_bundle()
    assert "Investment Dashboard — support bundle" in bundle
    assert "app version" in bundle
    assert "a diagnostic line" in bundle


def test_recent_errors_text_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    from investment_dashboard.services import runtime_status

    runtime_status.reset()
    text = support_bundle.recent_errors_text()
    assert "no errors or warnings recorded" in text


def test_recent_errors_text_lists_errors_and_warnings() -> None:
    from investment_dashboard.services import runtime_status

    runtime_status.reset()
    runtime_status.record_error("Price refresh", "boom: no such column market_value_eur")
    runtime_status.record_warning("stderr", "WARNING a soft notice")

    text = support_bundle.recent_errors_text()
    assert "ERROR" in text
    assert "Price refresh: boom: no such column market_value_eur" in text
    assert "WARNING" in text
    assert "stderr: WARNING a soft notice" in text
    runtime_status.reset()


def test_recent_errors_text_redacts_secret() -> None:
    from investment_dashboard.services import runtime_status

    runtime_status.reset()
    runtime_status.record_error("token", "leaked ghp_" + "C" * 30)
    text = support_bundle.recent_errors_text()
    assert "ghp_" not in text
    assert "«redacted»" in text
    runtime_status.reset()


def test_build_support_bundle_embeds_recorded_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from investment_dashboard.services import runtime_status

    settings = Settings(db_path=tmp_path / "db.sqlite")
    _patch_settings(monkeypatch, settings)
    runtime_status.reset()
    runtime_status.record_error("Live refresh", "intraday_value.market_value_eur missing")

    bundle = support_bundle.build_support_bundle()
    assert "Recent errors and warnings" in bundle
    assert "Live refresh: intraday_value.market_value_eur missing" in bundle
    assert "Databases" in bundle
    assert "Data health" in bundle
    runtime_status.reset()


def test_bundle_filename_shape() -> None:
    name = support_bundle.bundle_filename()
    assert name.startswith("inv-dashboard-support-")
    assert name.endswith(".txt")
