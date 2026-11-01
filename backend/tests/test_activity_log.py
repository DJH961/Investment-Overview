"""Per-subject activity logs: routing, retention, request events."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from investment_dashboard import activity_log
from investment_dashboard.activity_log import SUBJECTS, activity, configure_activity_logs
from investment_dashboard.api.activity import log_request_activity, subject_for


@pytest.fixture
def folder(tmp_path: Path) -> Iterator[Path]:
    out = configure_activity_logs(tmp_path)
    assert out is not None
    yield out
    for subject, prefixes in SUBJECTS.items():
        for name in (f"activity.{subject}", *prefixes):
            logger = logging.getLogger(name)
            for h in [h for h in logger.handlers if isinstance(h, TimedRotatingFileHandler)]:
                logger.removeHandler(h)
                h.close()


def _flush() -> None:
    for subject in SUBJECTS:
        for h in logging.getLogger(f"activity.{subject}").handlers:
            h.flush()


def test_module_loggers_route_to_their_subject(folder: Path) -> None:
    logging.getLogger("investment_dashboard.services.prices_service").setLevel(logging.INFO)
    logging.getLogger("investment_dashboard.services.prices_service").info("fetched 3 tickers")
    activity("backups").info("sealed snapshot written")
    _flush()
    assert "fetched 3 tickers" in (folder / "market_data.log").read_text(encoding="utf-8")
    assert "sealed snapshot" in (folder / "backups.log").read_text(encoding="utf-8")
    assert not (folder / "auth.log").exists()


def test_retention_is_about_three_months(folder: Path) -> None:
    handlers = logging.getLogger("activity.auth").handlers
    rotating = [h for h in handlers if isinstance(h, TimedRotatingFileHandler)]
    assert len(rotating) == 1  # idempotent: no duplicates after reconfiguring
    assert rotating[0].backupCount == activity_log.RETENTION_DAYS == 90


def test_reconfigure_does_not_duplicate(folder: Path) -> None:
    configure_activity_logs(folder.parent)
    activity("auth").info("once")
    _flush()
    assert (folder / "auth.log").read_text(encoding="utf-8").count("once") == 1


def test_secrets_are_scrubbed(folder: Path) -> None:
    activity("auth").info("token=ghp_abcdefghijklmnopqrstuvwxyz0123456789")
    _flush()
    assert "ghp_abcdefghijklmnopqrstuvwxyz0123456789" not in (folder / "auth.log").read_text(
        encoding="utf-8"
    )


def test_unknown_subject_is_refused() -> None:
    with pytest.raises(ValueError, match="unknown activity subject"):
        activity("nope")


@pytest.mark.parametrize(
    ("method", "path", "subject"),
    [
        ("POST", "/api/auth/login", "auth"),
        ("POST", "/api/imports", "imports"),
        ("POST", "/api/refresh", "market_data"),
        ("PUT", "/api/transactions/3", "changes"),
        ("PUT", "/api/settings", "changes"),
        ("GET", "/api/backup", "backups"),
        ("GET", "/api/overview", None),
        ("POST", "/api/calculator", None),
        ("POST", "/api/auth/passkey/login/options", None),
    ],
)
def test_subject_for(method: str, path: str, subject: str | None) -> None:
    assert subject_for(method, path) == subject


def test_middleware_logs_failed_login(folder: Path) -> None:
    app = FastAPI()
    app.middleware("http")(log_request_activity)

    @app.post("/api/auth/login", status_code=401)
    def login() -> dict[str, str]:
        return {"detail": "Invalid credentials."}

    TestClient(app).post("/api/auth/login", json={"password": "never-logged-123"})
    _flush()
    text = (folder / "auth.log").read_text(encoding="utf-8")
    assert "login FAILED (password) status=401" in text
    assert "never-logged-123" not in text
