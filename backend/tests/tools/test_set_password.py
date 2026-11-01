"""``inv-dashboard-set-password`` loads the SQLCipher key before touching the DB."""

from __future__ import annotations

import io
from contextlib import nullcontext

import pytest

from investment_dashboard import db
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
    monkeypatch.setattr("sys.stdin", io.StringIO("a-long-enough-password\n"))

    assert set_password.main(["--stdin"]) == 0
    assert calls == ["key", "set"]
