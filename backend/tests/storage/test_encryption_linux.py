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


def test_encrypted_engine_uses_a_queue_pool(tmp_path: Path) -> None:
    """SQLAlchemy's pysqlcipher dialect defaults to SingletonThreadPool, which
    closes in-use connections once more than 5 threads touch it ("Error closing
    cursor" on the server). File databases must get a normal QueuePool."""
    from sqlalchemy.pool import QueuePool

    eng = make_engine(f"sqlite:///{tmp_path / 'app.sqlite'}", encryption_config=_cfg(KEY))
    try:
        assert isinstance(eng.pool, QueuePool)
    finally:
        eng.dispose()


def test_encrypted_engine_survives_many_threads(tmp_path: Path) -> None:
    import threading

    eng = make_engine(f"sqlite:///{tmp_path / 'app.sqlite'}", encryption_config=_cfg(KEY))
    with eng.begin() as c:
        c.execute(text("CREATE TABLE t (x INTEGER)"))
    errors: list[BaseException] = []
    hold = threading.Barrier(12)

    def work() -> None:
        try:
            with eng.connect() as c:
                hold.wait(timeout=10)  # every thread holds a connection at once
                c.execute(text("SELECT count(*) FROM t")).scalar_one()
        except BaseException as exc:
            errors.append(exc)

    threads = [threading.Thread(target=work) for _ in range(12)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    eng.dispose()
    assert errors == []
