"""``inv-dashboard-check-config`` reports PASS/FAIL per rule and never leaks secrets."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from investment_dashboard.tools import check_config

_KEYS = (
    "INV_DASHBOARD_SERVER_MODE",
    "INV_DASHBOARD_COOKIE_SECURE",
    "INV_DASHBOARD_WEBAUTHN_ORIGIN",
    "INV_DASHBOARD_WEBAUTHN_RP_ID",
    "INV_DASHBOARD_DB_PASSPHRASE",
    "INV_DASHBOARD_BACKUP_PASSPHRASE",
)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    # The tool writes into os.environ; work on a private copy so nothing leaks.
    monkeypatch.setattr(os, "environ", os.environ.copy())
    for key in _KEYS:
        monkeypatch.delenv(key, raising=False)


def _write(tmp_path: Path, text: str) -> Path:
    path = tmp_path / "app.env"
    path.write_text(text, encoding="utf-8")
    return path


GOOD = (
    "INV_DASHBOARD_SERVER_MODE=true\n"
    "INV_DASHBOARD_WEBAUTHN_ORIGIN=https://app.example.com\n"
    "INV_DASHBOARD_WEBAUTHN_RP_ID=app.example.com\n"
    "INV_DASHBOARD_DB_PASSPHRASE=" + "a" * 32 + "\n"
    "INV_DASHBOARD_BACKUP_PASSPHRASE=" + "b" * 32 + "\n"
)


def test_good_config_passes(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    assert check_config.main(["--env-file", str(_write(tmp_path, GOOD))]) == 0
    out = capsys.readouterr().out
    assert "FAIL" not in out
    assert "OK:" in out


def test_bad_config_fails_without_printing_secrets(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    bad = (
        "INV_DASHBOARD_SERVER_MODE=true\n"
        "INV_DASHBOARD_COOKIE_SECURE=false\n"
        "INV_DASHBOARD_WEBAUTHN_ORIGIN=http://app.example.com\n"
        "INV_DASHBOARD_WEBAUTHN_RP_ID=other.example.org\n"
        "INV_DASHBOARD_DB_PASSPHRASE=short-secret-xyz\n"
    )
    assert check_config.main(["--env-file", str(_write(tmp_path, bad))]) == 1
    out = capsys.readouterr().out
    assert out.count("FAIL") >= 4
    assert "short-secret-xyz" not in out
