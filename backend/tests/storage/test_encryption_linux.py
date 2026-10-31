"""SQLCipher round-trip with the ``sqlcipher3`` driver (Linux image; skipped elsewhere)."""

from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("sqlcipher3")

from sqlalchemy import text

from investment_dashboard.db import make_engine
from investment_dashboard.storage.encryption import (
    EncryptionConfig,
    connect_sqlite,
    verify_database_key,
)

KEY = "test-key-changeme"


def _cfg(passphrase: str | None) -> EncryptionConfig:
    return EncryptionConfig(enabled=True, driver="sqlcipher3", passphrase=passphrase)


def test_encrypted_db_roundtrip_and_wrong_key(tmp_path: Path) -> None:
    path = tmp_path / "app.sqlite"
    conn = connect_sqlite(path, _cfg(KEY))
    conn.execute("CREATE TABLE t (x INTEGER)")
    conn.execute("INSERT INTO t VALUES (1)")
    conn.commit()
    conn.close()

    assert not path.read_bytes().startswith(b"SQLite format 3")
    assert verify_database_key(path, _cfg(KEY))
    assert not verify_database_key(path, _cfg("wrong-key"))
    assert not verify_database_key(path, EncryptionConfig(enabled=False))


def test_engine_opens_encrypted_db(tmp_path: Path) -> None:
    path = tmp_path / "app.sqlite"
    cfg = _cfg(KEY)
    eng = make_engine(f"sqlite:///{path}", encryption_config=cfg)
    with eng.begin() as c:
        c.execute(text("CREATE TABLE t (x INTEGER)"))
    eng.dispose()
    assert verify_database_key(path, cfg)
    assert not verify_database_key(path, _cfg("nope"))
