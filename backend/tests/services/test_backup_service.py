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


# -- envelope v2: authenticated metadata ----------------------------------------


def _seal_v1(db: Path, dest: Path, passphrase: str) -> Path:
    """A snapshot exactly as the v1 writer produced it (meta not authenticated)."""
    import hashlib

    from investment_dashboard.storage import blob_crypto
    from investment_dashboard.storage.integrity import backup_database

    copy = dest.with_suffix(".copy")
    backup_database(db, copy)
    raw = copy.read_bytes()
    copy.unlink()
    env = blob_crypto.encrypt_bytes(raw, passphrase, iterations=FAST)
    env["kind"] = backup_service.SNAPSHOT_KIND
    env["meta"] = {
        "created": "2026-11-01T12:00:00+00:00",
        "sha256": hashlib.sha256(raw).hexdigest(),
        "size": len(raw),
        "counts": backup_service.row_counts(db),
    }
    dest.write_text(json.dumps(env))
    return dest


def test_v2_snapshot_binds_meta(app_db: Path, tmp_path: Path) -> None:
    dest = backup_service.seal_database(app_db, tmp_path / "s.sealed.json", "pw", iterations=FAST)
    env = json.loads(dest.read_text())
    assert env["snapshot_format"] == 2
    assert env["v"] == 1  # the blob_crypto envelope itself is unchanged
    for field, value in (("counts", {"x": 1}), ("created", "2020-01-01T00:00:00+00:00")):
        tampered = json.loads(dest.read_text())
        tampered["meta"][field] = value
        bad = tmp_path / f"bad-{field}.sealed.json"
        bad.write_text(json.dumps(tampered))
        with pytest.raises(backup_service.SnapshotError):
            backup_service.unseal_snapshot(bad, "pw", tmp_path / f"o-{field}")
        assert not (tmp_path / f"o-{field}").exists()
    # Downgrading the format marker to v1 does not skip the check either.
    downgraded = json.loads(dest.read_text())
    del downgraded["snapshot_format"]
    bad = tmp_path / "bad-format.sealed.json"
    bad.write_text(json.dumps(downgraded))
    with pytest.raises(backup_service.SnapshotError):
        backup_service.unseal_snapshot(bad, "pw", tmp_path / "o-format")


def test_v1_snapshot_still_restores(app_db: Path, tmp_path: Path) -> None:
    dest = _seal_v1(app_db, tmp_path / "snapshot-20261101-120000.sealed.json", "pw")
    out = tmp_path / "out.sqlite"
    meta = backup_service.unseal_snapshot(dest, "pw", out)
    assert _dump(out) == _dump(app_db)
    assert meta["counts"] == backup_service.row_counts(app_db)


def test_renamed_v2_snapshot_is_refused(app_db: Path, tmp_path: Path) -> None:
    now = datetime(2026, 11, 1, 12, 30, 5, tzinfo=UTC)
    path = backup_service.create_snapshot(now=now, retain=False)
    assert backup_service.unseal_snapshot(path, "backup-pass-123", tmp_path / "ok.sqlite")
    moved = path.with_name("snapshot-20261102-000000.sealed.json")
    path.rename(moved)
    with pytest.raises(backup_service.SnapshotError, match="file name"):
        backup_service.unseal_snapshot(moved, "backup-pass-123", tmp_path / "o.sqlite")
    # Any other name (e.g. a browser download renamed by the user) is fine.
    other = moved.rename(tmp_path / "my-backup.json")
    assert backup_service.unseal_snapshot(other, "backup-pass-123", tmp_path / "o2.sqlite")


def test_seal_takes_created_from_a_snapshot_name(app_db: Path, tmp_path: Path) -> None:
    dest = backup_service.seal_database(
        app_db, tmp_path / "snapshot-20261101-120000.sealed.json", "pw", iterations=FAST
    )
    assert json.loads(dest.read_text())["meta"]["created"] == "2026-11-01T12:00:00+00:00"


def test_huge_iteration_count_and_unknown_format_refused(app_db: Path, tmp_path: Path) -> None:
    from investment_dashboard.storage import blob_crypto

    dest = backup_service.seal_database(app_db, tmp_path / "s.sealed.json", "pw", iterations=FAST)
    env = json.loads(dest.read_text())
    env["kdf_params"]["iterations"] = blob_crypto.MAX_PBKDF2_ITERATIONS + 1
    dest.write_text(json.dumps(env))
    with pytest.raises(backup_service.SnapshotError, match="limit"):
        backup_service.unseal_snapshot(dest, "pw", tmp_path / "o")
    env["kdf_params"]["iterations"] = FAST
    env["snapshot_format"] = 3
    dest.write_text(json.dumps(env))
    with pytest.raises(backup_service.SnapshotError, match="format"):
        backup_service.unseal_snapshot(dest, "pw", tmp_path / "o")


def test_blob_crypto_aad_round_trip_and_v1_compat() -> None:
    from investment_dashboard.storage import blob_crypto

    env = blob_crypto.encrypt_bytes(b"data", "pw", iterations=FAST, aad=b"meta")
    assert blob_crypto.decrypt_bytes(env, "pw", aad=b"meta") == b"data"
    with pytest.raises(blob_crypto.EnvelopeError):
        blob_crypto.decrypt_bytes(env, "pw", aad=b"other")
    with pytest.raises(blob_crypto.EnvelopeError):
        blob_crypto.decrypt_bytes(env, "pw")
    plain = blob_crypto.encrypt_bytes(b"data", "pw", iterations=FAST)
    assert set(plain) == {"v", "kdf", "kdf_params", "nonce", "ciphertext", "tag"}
    assert blob_crypto.decrypt_bytes(plain, "pw") == b"data"
