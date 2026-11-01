"""Tests for the ``inv-dashboard-publish-web`` CLI (``tools.publish_web``).

The CLI wires argument parsing to the publish service. These tests stub the
boot sequence, settings, DB session and publish service so they exercise the
CLI's control flow (dry-run vs. upload, error mapping) without touching the
network, the keyring or a real database.
"""

from __future__ import annotations

import contextlib
import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from investment_dashboard import boot
from investment_dashboard.config import Settings
from investment_dashboard.db import session_scope as _real_session_scope  # noqa: F401
from investment_dashboard.services import publish_service
from investment_dashboard.tools import publish_web


@pytest.fixture(autouse=True)
def _stub_boot_and_session(monkeypatch: pytest.MonkeyPatch) -> None:
    """Replace boot + session_scope so ``main`` never touches the real app."""
    monkeypatch.setattr(boot, "run_boot_sequence", lambda **_: None)

    @contextlib.contextmanager
    def _fake_scope():  # type: ignore[no-untyped-def]
        yield object()

    monkeypatch.setattr("investment_dashboard.db.session_scope", _fake_scope)


def _stub_settings(monkeypatch: pytest.MonkeyPatch, settings: Settings) -> None:
    monkeypatch.setattr("investment_dashboard.config.get_settings", lambda: settings)


def _result(**overrides: object) -> publish_service.PublishResult:
    base = dict(
        repo="octo/portfolio",
        release_tag="live-data",
        asset_name=publish_service.ASSET_NAME,
        asset_id=8,
        browser_download_url="https://example/portfolio.enc",
        size_bytes=123,
        published_at=datetime(2025, 1, 1, tzinfo=UTC),
        created_release=False,
    )
    base.update(overrides)
    return publish_service.PublishResult(**base)  # type: ignore[arg-type]


def test_help_exits_zero(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as excinfo:
        publish_web.main(["--help"])
    assert excinfo.value.code == 0
    assert "publish" in capsys.readouterr().out.lower()


def test_dry_run_writes_encrypted_blob(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _stub_settings(monkeypatch, Settings(mobile_passphrase="pw-strong-enough"))
    envelope = {"v": 1, "ciphertext": "AA=="}
    monkeypatch.setattr(publish_service, "build_envelope", lambda *a, **k: envelope)

    out = tmp_path / "nested" / "portfolio.enc"
    rc = publish_web.main(["--output", str(out)])

    assert rc == 0
    assert json.loads(out.read_text()) == envelope
    # The blob is written compactly (no spaces between separators).
    assert " " not in out.read_text()


def test_dry_run_without_passphrase_returns_2(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _stub_settings(monkeypatch, Settings())
    monkeypatch.setattr(publish_service, "resolve_mobile_passphrase", lambda _s: None)

    out = tmp_path / "portfolio.enc"
    rc = publish_web.main(["--output", str(out)])

    assert rc == 2
    assert not out.exists()


def test_publish_success_returns_0(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_settings(monkeypatch, Settings())
    captured: dict[str, object] = {}

    def _publish_now(_session, *, settings, include_transactions):  # type: ignore[no-untyped-def]
        captured["include_transactions"] = include_transactions
        return _result(created_release=True)

    monkeypatch.setattr(publish_service, "publish_now", _publish_now)

    rc = publish_web.main([])

    assert rc == 0
    assert captured["include_transactions"] is False


def test_include_transactions_flag_is_passed_through(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stub_settings(monkeypatch, Settings())
    captured: dict[str, object] = {}

    def _publish_now(_session, *, settings, include_transactions):  # type: ignore[no-untyped-def]
        captured["include_transactions"] = include_transactions
        return _result()

    monkeypatch.setattr(publish_service, "publish_now", _publish_now)

    assert publish_web.main(["--include-transactions"]) == 0
    assert captured["include_transactions"] is True


def test_settings_default_enables_transactions(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_settings(monkeypatch, Settings(publish_include_transactions=True))
    captured: dict[str, object] = {}

    def _publish_now(_session, *, settings, include_transactions):  # type: ignore[no-untyped-def]
        captured["include_transactions"] = include_transactions
        return _result()

    monkeypatch.setattr(publish_service, "publish_now", _publish_now)

    assert publish_web.main([]) == 0
    assert captured["include_transactions"] is True


def test_publish_error_maps_to_exit_2(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_settings(monkeypatch, Settings())

    def _boom(*_a, **_k):  # type: ignore[no-untyped-def]
        raise publish_service.PublishError("no token configured")

    monkeypatch.setattr(publish_service, "publish_now", _boom)

    rc = publish_web.main([])

    assert rc == 2
