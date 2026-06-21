"""Tests for file-based logging configuration."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from logging.handlers import RotatingFileHandler
from pathlib import Path

import pytest

from investment_dashboard import logging as app_logging
from investment_dashboard.config import Settings


@pytest.fixture
def _clean_root_logger() -> Iterator[None]:
    """Snapshot and restore the root logger so tests don't leak handlers."""
    root = logging.getLogger()
    saved_handlers = root.handlers[:]
    saved_level = root.level
    root.handlers.clear()
    try:
        yield
    finally:
        for handler in root.handlers[:]:
            handler.close()
        root.handlers = saved_handlers
        root.setLevel(saved_level)


@pytest.mark.usefixtures("_clean_root_logger")
def test_configure_logging_writes_to_rotating_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = Settings(db_path=tmp_path / "db.sqlite", log_level="INFO")
    monkeypatch.setattr(app_logging, "get_settings", lambda: settings)

    logging.getLogger().handlers.clear()
    app_logging.configure_logging()

    root = logging.getLogger()
    file_handlers = [h for h in root.handlers if isinstance(h, RotatingFileHandler)]
    assert file_handlers, "expected a RotatingFileHandler on the root logger"

    logging.getLogger("test.logging").warning("hello from the test")
    for handler in file_handlers:
        handler.flush()

    log_file = settings.log_file_path
    assert log_file.exists()
    assert "hello from the test" in log_file.read_text(encoding="utf-8")


@pytest.mark.usefixtures("_clean_root_logger")
def test_configure_logging_redacts_secrets_in_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = Settings(db_path=tmp_path / "db.sqlite")
    monkeypatch.setattr(app_logging, "get_settings", lambda: settings)

    logging.getLogger().handlers.clear()
    app_logging.configure_logging()
    logging.getLogger("test.logging").info("token ghp_%s", "A" * 30)
    for handler in logging.getLogger().handlers:
        handler.flush()

    contents = settings.log_file_path.read_text(encoding="utf-8")
    assert "ghp_" not in contents
    assert "«redacted»" in contents


@pytest.mark.usefixtures("_clean_root_logger")
def test_configure_logging_is_idempotent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    settings = Settings(db_path=tmp_path / "db.sqlite")
    monkeypatch.setattr(app_logging, "get_settings", lambda: settings)

    logging.getLogger().handlers.clear()
    app_logging.configure_logging()
    count = len(logging.getLogger().handlers)
    app_logging.configure_logging()
    assert len(logging.getLogger().handlers) == count


@pytest.mark.usefixtures("_clean_root_logger")
def test_warning_logs_are_mirrored_into_runtime_status(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from investment_dashboard.services import runtime_status

    settings = Settings(db_path=tmp_path / "db.sqlite", log_level="INFO")
    monkeypatch.setattr(app_logging, "get_settings", lambda: settings)

    runtime_status.reset()
    logging.getLogger().handlers.clear()
    app_logging.configure_logging()

    # INFO/DEBUG must NOT toast; only WARNING and above are mirrored.
    logging.getLogger("some.library").info("just chatter")
    assert runtime_status.sequence() == 0

    logging.getLogger("some.library").error("disk on fire")
    latest = runtime_status.latest()
    assert latest is not None
    assert latest.source == "some.library"
    assert latest.message == "disk on fire"
    runtime_status.reset()


@pytest.mark.usefixtures("_clean_root_logger")
def test_runtime_status_skip_and_source_override(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from investment_dashboard.services import runtime_status

    settings = Settings(db_path=tmp_path / "db.sqlite")
    monkeypatch.setattr(app_logging, "get_settings", lambda: settings)

    runtime_status.reset()
    logging.getLogger().handlers.clear()
    app_logging.configure_logging()

    # A record opting out is not mirrored.
    logging.getLogger("x").warning("handled elsewhere", extra={"runtime_status_skip": True})
    assert runtime_status.sequence() == 0

    # A record can override the displayed source label.
    logging.getLogger("x").warning("oops", extra={"runtime_status_source": "Friendly name"})
    latest = runtime_status.latest()
    assert latest is not None
    assert latest.source == "Friendly name"
    runtime_status.reset()


@pytest.mark.usefixtures("_clean_root_logger")
def test_file_handler_falls_back_when_dir_unwritable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = Settings(db_path=tmp_path / "db.sqlite")
    monkeypatch.setattr(app_logging, "get_settings", lambda: settings)

    def _boom(*_args: object, **_kwargs: object) -> None:
        raise OSError("read-only filesystem")

    monkeypatch.setattr(Path, "mkdir", _boom)
    logging.getLogger().handlers.clear()
    app_logging.configure_logging()

    root = logging.getLogger()
    assert not any(isinstance(h, RotatingFileHandler) for h in root.handlers)
    # Console logging still works — boot must not be blocked.
    assert any(isinstance(h, logging.StreamHandler) for h in root.handlers)
