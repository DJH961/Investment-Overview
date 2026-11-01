"""``inv-dashboard-restore``: verified, atomic swap with the old file kept aside."""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

import pytest

from investment_dashboard.services import backup_service
from investment_dashboard.tools import restore_db

FAST = 1000
NOW = datetime(2026, 11, 1, 12, 0, 0, tzinfo=UTC)


def _make_db(path: Path, rows: int) -> None:
    conn = sqlite3.connect(path)
    try:
        conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
        conn.executemany("INSERT INTO t (v) VALUES (?)", [(f"row{i}",) for i in range(rows)])
        conn.commit()
    finally:
        conn.close()


def _rows(path: Path) -> list[tuple[int, str]]:
    conn = sqlite3.connect(path)
    try:
        return list(conn.execute("SELECT id, v FROM t ORDER BY id"))
    finally:
        conn.close()


@pytest.fixture
def snapshot(tmp_path: Path) -> tuple[Path, Path]:
    src = tmp_path / "src.sqlite"
    _make_db(src, 5)
    snap = backup_service.seal_database(
        src, tmp_path / "snapshot-20261101-120000.sealed.json", "pw", iterations=FAST
    )
    return src, snap


def test_round_trip_identical_rows_and_old_file_kept(
    tmp_path: Path, snapshot: tuple[Path, Path]
) -> None:
    src, snap = snapshot
    live = tmp_path / "app.sqlite"
    _make_db(live, 2)
    (tmp_path / "app.sqlite-wal").write_bytes(b"stale")
    result = restore_db.restore_snapshot(snap, live, seal_passphrase="pw", now=NOW)
    assert _rows(live) == _rows(src)
    assert result.counts == {"t": 5}
    assert result.aside is not None
    assert len(_rows(result.aside)) == 2  # old database preserved
    assert not (tmp_path / "app.sqlite-wal").exists()  # stale WAL not applied
    assert not (tmp_path / "app.sqlite.restoring").exists()


def test_restore_into_empty_target(tmp_path: Path, snapshot: tuple[Path, Path]) -> None:
    src, snap = snapshot
    live = tmp_path / "data" / "app.sqlite"
    result = restore_db.restore_snapshot(snap, live, seal_passphrase="pw")
    assert result.aside is None
    assert _rows(live) == _rows(src)


def test_corrupt_snapshot_refused_and_live_db_untouched(
    tmp_path: Path, snapshot: tuple[Path, Path]
) -> None:
    _, snap = snapshot
    live = tmp_path / "app.sqlite"
    _make_db(live, 2)
    env = json.loads(snap.read_text())
    env["ciphertext"] = env["ciphertext"][:-8] + "AAAAAAA="
    snap.write_text(json.dumps(env))
    with pytest.raises(restore_db.RestoreError):
        restore_db.restore_snapshot(snap, live, seal_passphrase="pw")
    assert len(_rows(live)) == 2
    assert not list(tmp_path.glob("*.before-restore-*"))
    assert not (tmp_path / "app.sqlite.restoring").exists()


def test_wrong_passphrase_refused(tmp_path: Path, snapshot: tuple[Path, Path]) -> None:
    _, snap = snapshot
    live = tmp_path / "app.sqlite"
    _make_db(live, 2)
    with pytest.raises(restore_db.RestoreError):
        restore_db.restore_snapshot(snap, live, seal_passphrase="wrong")
    assert len(_rows(live)) == 2


def test_row_count_mismatch_refused(tmp_path: Path, snapshot: tuple[Path, Path]) -> None:
    _, snap = snapshot
    env = json.loads(snap.read_text())
    env["meta"]["counts"] = {"t": 99}
    snap.write_text(json.dumps(env))
    live = tmp_path / "app.sqlite"
    with pytest.raises(restore_db.RestoreError, match="row counts"):
        restore_db.restore_snapshot(snap, live, seal_passphrase="pw")
    assert not live.exists()


def test_cli_latest(
    tmp_path: Path,
    snapshot: tuple[Path, Path],
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    src, snap = snapshot
    backups = tmp_path / "backups"
    backups.mkdir()
    snap.replace(backups / snap.name)
    live = tmp_path / "live.sqlite"
    monkeypatch.setenv("INV_DASHBOARD_BACKUP_PASSPHRASE", "pw")
    code = restore_db.main(["--latest", "--yes", "--dir", str(backups), "--db", str(live)])
    assert code == 0
    assert _rows(live) == _rows(src)
    assert "Restored" in capsys.readouterr().out


def test_cli_empty_dir_explains_how_to_fetch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv(restore_db.ENV_REMOTE, raising=False)
    args = ["--latest", "--yes", "--dir", str(tmp_path), "--db", str(tmp_path / "x")]
    assert restore_db.main(args) == 2
    assert "rclone" in capsys.readouterr().err
