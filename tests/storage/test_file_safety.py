"""Tests for sidecar, lock, integrity, backup, and encryption helpers."""

from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path

import pytest

from investment_dashboard.storage.backup import (
    RetentionPolicy,
    snapshot,
    verify_backup,
)
from investment_dashboard.storage.encryption import (
    EncryptionUnavailableError,
    PassphraseMissingError,
    resolve_encryption,
)
from investment_dashboard.storage.integrity import IntegrityCheckFailed, integrity_check
from investment_dashboard.storage.lock import WriteLockError, acquire_write_lock
from investment_dashboard.storage.sidecar import (
    StraySidecarError,
    assert_no_sidecars_in_cloud,
    repair_sidecars,
    scan_sidecars,
    should_use_truncate_journal,
)


@pytest.fixture(autouse=True)
def _clear_cloud_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    for var in (
        "OneDrive",
        "OneDriveConsumer",
        "OneDriveCommercial",
        "INV_DASHBOARD_DB_PATH",
        "INV_DASHBOARD_LEDGER_PATH",
        "INV_DASHBOARD_CONFIG_PATH",
        "INV_DASHBOARD_CACHE_PATH",
        "INV_DASHBOARD_DB_PASSPHRASE",
    ):
        monkeypatch.delenv(var, raising=False)


def _make_sqlite(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)")
    conn.execute("INSERT INTO t (v) VALUES ('hello')")
    conn.commit()
    conn.close()


# --- sidecar / journal-mode ------------------------------------------


def test_should_use_truncate_for_cloud_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    od = tmp_path / "OneDrive"
    od.mkdir()
    monkeypatch.setenv("OneDrive", str(od))
    assert should_use_truncate_journal(od / "inv-dashboard" / "ledger.sqlite") is True
    assert should_use_truncate_journal(tmp_path / "local" / "ledger.sqlite") is False


def test_assert_no_sidecars_in_cloud_local_is_fine(tmp_path: Path) -> None:
    local = tmp_path / "ledger.sqlite"
    local.touch()
    (tmp_path / "ledger.sqlite-wal").touch()
    # Not in a cloud folder -> must NOT raise.
    assert_no_sidecars_in_cloud([local])


def test_assert_no_sidecars_in_cloud_raises_when_present(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    od = tmp_path / "OneDrive"
    od.mkdir()
    monkeypatch.setenv("OneDrive", str(od))
    db = od / "inv-dashboard" / "ledger.sqlite"
    db.parent.mkdir(parents=True)
    db.touch()
    (db.parent / "ledger.sqlite-wal").touch()
    with pytest.raises(StraySidecarError):
        assert_no_sidecars_in_cloud([db])


def test_repair_sidecars_removes_and_switches_journal(tmp_path: Path) -> None:
    db = tmp_path / "ledger.sqlite"
    _make_sqlite(db)
    (tmp_path / "ledger.sqlite-wal").touch()
    (tmp_path / "ledger.sqlite-shm").touch()
    after = repair_sidecars(db)
    assert after.wal is None
    assert after.shm is None
    # Sanity: data still readable.
    conn = sqlite3.connect(db)
    assert conn.execute("SELECT COUNT(*) FROM t").fetchone()[0] == 1
    conn.close()
    # Fresh scan also clean.
    assert not scan_sidecars(db).found


# --- lock ------------------------------------------------------------


def test_write_lock_blocks_second_acquire(tmp_path: Path) -> None:
    db = tmp_path / "ledger.sqlite"
    _make_sqlite(db)
    first = acquire_write_lock(db)
    try:
        with pytest.raises(WriteLockError):
            acquire_write_lock(db)
    finally:
        first.release()
    # After release the lock is acquirable again.
    second = acquire_write_lock(db)
    second.release()


def test_write_lock_for_memory_is_noop(tmp_path: Path) -> None:
    lock = acquire_write_lock(Path(":memory:"))
    # Releasing twice is fine.
    lock.release()
    lock.release()


# --- integrity -------------------------------------------------------


def test_integrity_check_ok(tmp_path: Path) -> None:
    db = tmp_path / "ledger.sqlite"
    _make_sqlite(db)
    assert integrity_check(db) == "ok"


def test_integrity_check_missing(tmp_path: Path) -> None:
    assert integrity_check(tmp_path / "absent.sqlite") == "missing"


def test_integrity_check_corrupt(tmp_path: Path) -> None:
    db = tmp_path / "ledger.sqlite"
    db.write_bytes(b"this is not a sqlite file")
    with pytest.raises((IntegrityCheckFailed, sqlite3.DatabaseError)):
        integrity_check(db)


# --- backup ----------------------------------------------------------


def test_snapshot_creates_file_and_prunes(tmp_path: Path) -> None:
    db = tmp_path / "ledger.sqlite"
    _make_sqlite(db)
    policy = RetentionPolicy(hourly=2, daily=1, monthly=1)
    # First snapshot promotes to monthly, second to daily (new day), then
    # four hourlies on that same day → hourly bucket has 4 entries which
    # gets pruned to 2.
    base = datetime(2025, 1, 1, 10, 0, 0)
    snapshot(db, policy=policy, now=base)
    snapshot(db, policy=policy, now=datetime(2025, 1, 2, 10, 0, 0))
    for i in range(4):
        snapshot(db, policy=policy, now=datetime(2025, 1, 2, 11 + i, 0, 0))
    bdir = tmp_path / "backups"
    hourly = sorted(p.name for p in bdir.iterdir() if "hourly" in p.name)
    daily = sorted(p.name for p in bdir.iterdir() if "daily" in p.name)
    monthly = sorted(p.name for p in bdir.iterdir() if "monthly" in p.name)
    assert len(hourly) == 2
    assert len(daily) == 1
    assert len(monthly) == 1


def test_snapshot_returns_none_when_db_missing(tmp_path: Path) -> None:
    assert snapshot(tmp_path / "absent.sqlite") is None


def test_verify_backup_returns_row_counts(tmp_path: Path) -> None:
    db = tmp_path / "ledger.sqlite"
    _make_sqlite(db)
    out = snapshot(db, now=datetime(2025, 1, 1, 0, 0, 0))
    assert out is not None
    counts = verify_backup(out)
    assert counts == {"t": 1}


# --- encryption ------------------------------------------------------


def test_resolve_encryption_disabled_short_circuits() -> None:
    cfg = resolve_encryption(encrypt_synced_tiers=False, env_passphrase=None)
    assert cfg.enabled is False


def test_resolve_encryption_missing_driver_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("investment_dashboard.storage.encryption._detect_driver", lambda: None)
    with pytest.raises(EncryptionUnavailableError):
        resolve_encryption(encrypt_synced_tiers=True, env_passphrase="x")


def test_resolve_encryption_missing_passphrase_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "investment_dashboard.storage.encryption._detect_driver",
        lambda: "pysqlcipher3",
    )
    monkeypatch.setattr(
        "investment_dashboard.storage.encryption.load_passphrase_from_keyring",
        lambda: None,
    )
    with pytest.raises(PassphraseMissingError):
        resolve_encryption(encrypt_synced_tiers=True, env_passphrase=None)


def test_resolve_encryption_happy_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "investment_dashboard.storage.encryption._detect_driver",
        lambda: "pysqlcipher3",
    )
    cfg = resolve_encryption(encrypt_synced_tiers=True, env_passphrase="hunter2")
    assert cfg.enabled is True
    assert cfg.driver == "pysqlcipher3"
    assert cfg.passphrase == "hunter2"
