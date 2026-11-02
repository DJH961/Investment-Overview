"""``inv-dashboard-set-password`` loads the SQLCipher key before touching the DB."""

from __future__ import annotations

import io
from contextlib import nullcontext
from pathlib import Path

import pytest

from investment_dashboard import activity_log, db
from investment_dashboard.services import auth_service
from investment_dashboard.storage import encryption
from investment_dashboard.storage.encryption import EncryptionConfig
from investment_dashboard.tools import set_password


def test_applies_encryption_before_opening_db(monkeypatch: pytest.MonkeyPatch) -> None:
    keyed = EncryptionConfig(enabled=True, driver="sqlcipher3", passphrase="k")
    calls: list[str] = []
    monkeypatch.setattr(encryption, "resolve_encryption", lambda **_: keyed)
    monkeypatch.setattr(
        db, "set_active_encryption", lambda cfg: calls.append("key" if cfg is keyed else "?")
    )
    monkeypatch.setattr(db, "config_session_scope", lambda: nullcontext(object()))
    monkeypatch.setattr(auth_service, "set_password", lambda *_: calls.append("set"))
    monkeypatch.setattr(activity_log, "configure_activity_logs", lambda *_: None)
    monkeypatch.setattr("sys.stdin", io.StringIO("a-long-enough-password\n"))

    assert set_password.main(["--stdin"]) == 0
    assert calls == ["key", "set"]


def test_sets_password_on_a_real_sqlcipher_database(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """End to end: a keyed database is opened with the key, sessions are revoked."""
    pytest.importorskip("sqlcipher3")
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import select

    from investment_dashboard.config import get_settings
    from investment_dashboard.models.auth import AuthCredential, AuthSession
    from investment_dashboard.models.base import ConfigBase

    db_file = tmp_path / "app.sqlite"
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(db_file))
    monkeypatch.setenv("INV_DASHBOARD_LOG_DIR", str(tmp_path / "logs"))
    monkeypatch.setenv("INV_DASHBOARD_ENCRYPT_SYNCED_TIERS", "true")
    monkeypatch.setenv("INV_DASHBOARD_DB_PASSPHRASE", "unit-test-passphrase")
    get_settings.cache_clear()
    db.dispose_engines()
    try:
        keyed = EncryptionConfig(
            enabled=True, driver="sqlcipher3", passphrase="unit-test-passphrase"
        )
        db.set_active_encryption(keyed)
        ConfigBase.metadata.create_all(db.get_config_engine())
        t = datetime(2026, 1, 1, tzinfo=UTC).replace(tzinfo=None)
        with db.config_session_scope() as s:
            s.add(
                AuthSession(
                    id="a" * 64,
                    created_at=t,
                    last_seen_at=t,
                    expires_at=t + timedelta(days=30),
                )
            )
        db.dispose_engines()
        # A fresh process knows no key until the tool loads it.
        db.set_active_encryption(EncryptionConfig(enabled=False))

        monkeypatch.setattr("sys.stdin", io.StringIO("a-long-enough-password\n"))
        assert set_password.main(["--stdin"]) == 0

        db.dispose_engines()
        db.set_active_encryption(keyed)
        with db.config_session_scope() as s:
            assert s.scalars(select(AuthSession)).all() == []
            assert s.scalars(select(AuthCredential)).one().password_hash.startswith("$argon2")
        # The file really is encrypted.
        assert not db_file.read_bytes().startswith(b"SQLite format 3")
    finally:
        db.dispose_engines()
        db.set_active_encryption(EncryptionConfig(enabled=False))
        get_settings.cache_clear()
