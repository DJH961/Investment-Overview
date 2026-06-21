"""Tests for the v3.0 auto-publish triggers (proposal §5.4).

These exercise the gating logic and the never-raise contract in isolation:
``publish_service.publish_now`` is stubbed so no network or encryption runs.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.repositories import app_config_repo
from investment_dashboard.services import auto_publish, publish_service


@pytest.fixture
def patched_scope(session: Session, monkeypatch: pytest.MonkeyPatch) -> Session:
    """Point auto_publish's ``session_scope`` at the in-memory test session."""

    @contextmanager
    def _scope() -> Iterator[Session]:
        try:
            yield session
            session.commit()
        finally:
            pass

    monkeypatch.setattr(auto_publish, "session_scope", _scope, raising=True)
    return session


def _enable(session: Session, **overrides: str) -> None:
    app_config_repo.set_value(session, auto_publish.ENABLED_KEY, "true")
    app_config_repo.set_value(session, auto_publish.REPO_KEY, "octo/portfolio")
    for key, value in overrides.items():
        app_config_repo.set_value(session, key, value)
    session.commit()


def _fake_result() -> publish_service.PublishResult:
    return publish_service.PublishResult(
        repo="octo/portfolio",
        release_tag="live-data",
        asset_name="portfolio.enc",
        asset_id=1,
        browser_download_url=None,
        size_bytes=128,
        published_at=datetime(2026, 6, 21, 12, 0, tzinfo=UTC),
        created_release=False,
    )


def test_disabled_master_switch_is_a_noop(
    patched_scope: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    called = False

    def _publish_now(*_a: object, **_k: object) -> publish_service.PublishResult:
        nonlocal called
        called = True
        return _fake_result()

    monkeypatch.setattr(publish_service, "publish_now", _publish_now, raising=True)
    # Master switch never set → disabled by default.
    assert auto_publish.publish_on_trigger(auto_publish.TRIGGER_IMPORT) is None
    assert called is False


def test_per_trigger_toggle_off_skips(
    patched_scope: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable(patched_scope, **{auto_publish.ON_IMPORT_KEY: "false"})
    monkeypatch.setattr(
        publish_service,
        "publish_now",
        lambda *a, **k: pytest.fail("should not publish when the trigger is off"),
        raising=True,
    )
    assert auto_publish.publish_on_trigger(auto_publish.TRIGGER_IMPORT) is None


def test_enabled_trigger_publishes_and_records_timestamp(
    patched_scope: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable(patched_scope)
    seen: dict[str, object] = {}

    def _publish_now(session: Session, **kwargs: object) -> publish_service.PublishResult:
        seen.update(kwargs)
        return _fake_result()

    monkeypatch.setattr(publish_service, "publish_now", _publish_now, raising=True)

    result = auto_publish.publish_on_trigger(auto_publish.TRIGGER_SHUTDOWN)
    assert result is not None
    assert seen["repo"] == "octo/portfolio"
    assert seen["include_transactions"] is False
    assert (
        app_config_repo.get(patched_scope, auto_publish.LAST_PUBLISHED_KEY)
        == "2026-06-21T12:00:00+00:00"
    )


def test_include_transactions_pref_is_forwarded(
    patched_scope: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable(patched_scope, **{auto_publish.INCLUDE_TX_KEY: "true"})
    seen: dict[str, object] = {}
    monkeypatch.setattr(
        publish_service,
        "publish_now",
        lambda session, **k: seen.update(k) or _fake_result(),
        raising=True,
    )
    auto_publish.publish_on_trigger(auto_publish.TRIGGER_IMPORT)
    assert seen["include_transactions"] is True


def test_publish_error_is_swallowed(
    patched_scope: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable(patched_scope)

    def _boom(*_a: object, **_k: object) -> publish_service.PublishResult:
        raise publish_service.PublishError("no token configured")

    monkeypatch.setattr(publish_service, "publish_now", _boom, raising=True)
    assert auto_publish.publish_on_trigger(auto_publish.TRIGGER_IMPORT) is None
    # No timestamp recorded on failure.
    assert app_config_repo.get(patched_scope, auto_publish.LAST_PUBLISHED_KEY) is None


def test_unexpected_error_is_swallowed(
    patched_scope: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable(patched_scope)

    def _boom(*_a: object, **_k: object) -> publish_service.PublishResult:
        raise RuntimeError("network down")

    monkeypatch.setattr(publish_service, "publish_now", _boom, raising=True)
    assert auto_publish.publish_on_trigger(auto_publish.TRIGGER_IMPORT) is None


def test_unknown_trigger_returns_none(patched_scope: Session) -> None:
    assert auto_publish.publish_on_trigger("nonsense") is None
