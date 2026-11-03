"""A machine without an OS keychain (the v6 server) must not report problems."""

from __future__ import annotations

import logging

import keyring
import pytest
from keyring.errors import KeyringError, NoKeyringError

from investment_dashboard.storage import encryption


def _raise(exc: Exception):
    def fn(*_args: object, **_kwargs: object) -> None:
        raise exc

    return fn


def test_lookup_without_keyring_backend_is_silent(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(keyring, "get_password", _raise(NoKeyringError("no backend")))
    with caplog.at_level(logging.WARNING, logger=encryption.__name__):
        assert encryption.load_tiingo_token_from_keyring() is None
    assert not caplog.records


def test_delete_without_keyring_backend_counts_as_cleared(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(keyring, "delete_password", _raise(NoKeyringError("no backend")))
    assert encryption.delete_tiingo_token_from_keyring() is True


def test_other_keyring_failures_still_warn(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(keyring, "get_password", _raise(KeyringError("locked")))
    with caplog.at_level(logging.WARNING, logger=encryption.__name__):
        assert encryption.load_tiingo_token_from_keyring() is None
    assert any(r.getMessage() == "keyring lookup failed" for r in caplog.records)
