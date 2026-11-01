"""Sealed snapshots: round trip, retention, tampering, dirty flag, scheduler hook."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from investment_dashboard import db as db_module
from investment_dashboard.config import get_settings
from investment_dashboard.db import (
    config_session_scope,
    dispose_engines,
    get_ledger_engine,
)
from investment_dashboard.models import ALL_METADATAS
from investment_dashboard.repositories import app_config_repo
from investment_dashboard.services import backup_service

FAST = 1000  # PBKDF2 iterations for tests that do not exercise the default


@pytest.fixture
def app_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    db = tmp_path / "app.sqlite"
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(db))
    for tier in ("LEDGER", "CONFIG", "CACHE"):
        monkeypatch.delenv(f"INV_DASHBOARD_{tier}_PATH", raising=False)
    monkeypatch.setenv("INV_DASHBOARD_BACKUP_PASSPHRASE", "backup-pass-123")
    monkeypatch.setenv("INV_DASHBOARD_BACKUP_DIR", str(tmp_path / "backups"))
    get_settings.cache_clear()
    dispose_engines()
    engine = get_ledger_engine()
    for metadata in ALL_METADATAS:
        metadata.create_all(engine)
    db_module.clear_dirty()
    try:
        yield db
    finally:
        dispose_engines()
        get_settings.cache_clear()
        db_module.clear_dirty()


def _dump(path: Path) -> dict[str, list[tuple[object, ...]]]:
    conn = sqlite3.connect(path)
    try:
        names = [
            r[0]
            for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        ]
        return {n: list(conn.execute(f'SELECT * FROM "{n}" ORDER BY 1')) for n in names}
    finally:
        conn.close()


def test_seal_unseal_round_trip_is_identical(app_db: Path, tmp_path: Path) -> None:
    with config_session_scope() as s:
        app_config_repo.set_value(s, "theme", "dark")
    dest = backup_service.seal_database(app_db, tmp_path / "s.sealed.json", "pw", iterations=FAST)
    out = tmp_path / "out.sqlite"
    meta = backup_service.unseal_snapshot(dest, "pw", out)
    assert _dump(out) == _dump(app_db)
    assert meta["counts"] == backup_service.row_counts(app_db)
    assert b"SQLite format" not in dest.read_bytes()  # sealed, not plain


def test_wrong_passphrase_and_tampering_refused(app_db: Path, tmp_path: Path) -> None:
    dest = backup_service.seal_database(app_db, tmp_path / "s.sealed.json", "pw", iterations=FAST)
    with pytest.raises(backup_service.SnapshotError):
        backup_service.unseal_snapshot(dest, "nope", tmp_path / "o1")
    env = json.loads(dest.read_text())
    env["ciphertext"] = env["ciphertext"][:-8] + "AAAAAAA="
    dest.write_text(json.dumps(env))
    with pytest.raises(backup_service.SnapshotError):
        backup_service.unseal_snapshot(dest, "pw", tmp_path / "o2")
    assert not (tmp_path / "o2").exists()


def test_create_snapshot_names_and_default_dir(app_db: Path, tmp_path: Path) -> None:
    now = datetime(2026, 11, 1, 12, 30, 5, tzinfo=UTC)
    path = backup_service.create_snapshot(now=now)
    assert path.parent == tmp_path / "backups"
    assert path.name == "snapshot-20261101-123005.sealed.json"
    assert [s.path for s in backup_service.list_snapshots()] == [path]


def test_create_snapshot_needs_a_passphrase(app_db: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("INV_DASHBOARD_BACKUP_PASSPHRASE")
    get_settings.cache_clear()
    with pytest.raises(backup_service.SnapshotError):
        backup_service.create_snapshot()


def test_retention_keeps_hourly_daily_monthly(tmp_path: Path) -> None:
    start = datetime(2026, 11, 1, 12, tzinfo=UTC)
    for i in range(24 * 100):  # hourly for 100 days
        name = f"snapshot-{(start - timedelta(hours=i)):%Y%m%d-%H%M%S}.sealed.json"
        (tmp_path / name).write_text("{}")
    (tmp_path / "unrelated.txt").write_text("x")
    backup_service.prune(tmp_path, backup_service.Retention(hourly=3, daily=2, monthly=2))
    kept = {s.created for s in backup_service.list_snapshots(tmp_path)}
    assert {start - timedelta(hours=h) for h in range(3)} <= kept  # last 3 hours
    assert datetime(2026, 10, 31, 23, tzinfo=UTC) in kept  # newest of previous day
    assert datetime(2026, 10, 31, 23, tzinfo=UTC) in kept
    assert len(kept) <= 3 + 2 + 2
    assert (tmp_path / "unrelated.txt").exists()


def test_dirty_flag_tracks_durable_writes(app_db: Path) -> None:
    assert db_module.dirty_since() is None
    with config_session_scope() as s:
        app_config_repo.set_value(s, "theme", "dark")
    assert db_module.dirty_since() is not None


def test_is_due_debounce_and_nightly(app_db: Path) -> None:
    now = datetime.now(UTC)
    assert backup_service.is_due(now)  # no snapshot yet -> nightly rule
    backup_service.create_snapshot(now=now)
    assert not backup_service.is_due(now + timedelta(seconds=5))
    db_module.mark_dirty()
    assert not backup_service.is_due(now)
    assert backup_service.is_due(now + timedelta(seconds=backup_service.DEBOUNCE_SECONDS + 5))
    db_module.clear_dirty()
    assert backup_service.is_due(now + timedelta(hours=25))


def test_run_scheduled_clears_dirty_and_remarks_on_failure(
    app_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_module.mark_dirty()
    backup_service.run_scheduled()
    assert db_module.dirty_since() is None
    assert len(backup_service.list_snapshots()) == 1

    def boom(**_: object) -> Path:
        raise RuntimeError("disk full")

    monkeypatch.setattr(backup_service, "create_snapshot", boom)
    with pytest.raises(RuntimeError):
        backup_service.run_scheduled()
    assert db_module.dirty_since() is not None
