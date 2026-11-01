"""Tests for the Settings "Move ledger…" relocation service."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from investment_dashboard.storage.move import (
    MoveError,
    move_synced_tiers,
)
from investment_dashboard.storage.paths import (
    ResolvedPath,
    ResolverSource,
    StorageLayout,
)


def _make_sqlite(path: Path, value: str = "hello") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)")
    conn.execute("INSERT INTO t (v) VALUES (?)", (value,))
    conn.commit()
    conn.close()


def _layout(ledger: Path | None, config: Path | None, cache: Path) -> StorageLayout:
    def _rp(p: Path | None) -> ResolvedPath:
        return ResolvedPath(p if p is not None else Path("/dev/null"), ResolverSource.PERSISTED)

    return StorageLayout(
        ledger=_rp(ledger),
        config=_rp(config),
        cache=ResolvedPath(cache, ResolverSource.LOCAL_DEFAULT),
    )


def _read_value(path: Path) -> str:
    conn = sqlite3.connect(path)
    try:
        return conn.execute("SELECT v FROM t").fetchone()[0]
    finally:
        conn.close()


def test_move_relocates_files_and_removes_sources(tmp_path: Path) -> None:
    src = tmp_path / "src"
    dest = tmp_path / "dest"
    ledger = src / "ledger.sqlite"
    config = src / "config.sqlite"
    _make_sqlite(ledger, "ledger-data")
    _make_sqlite(config, "config-data")
    layout = _layout(ledger, config, src / "cache.sqlite")

    result = move_synced_tiers(dest, layout=layout)

    assert result.moved["ledger"] == dest / "ledger.sqlite"
    assert result.moved["config"] == dest / "config.sqlite"
    # New files exist with the original data and the sources are gone.
    assert _read_value(dest / "ledger.sqlite") == "ledger-data"
    assert _read_value(dest / "config.sqlite") == "config-data"
    assert not ledger.exists()
    assert not config.exists()
    assert not result.leftover_sources
    # A safety backup was taken for each tier before the move.
    assert result.backups["ledger"] is not None
    assert result.backups["config"] is not None


def test_move_removes_sidecars(tmp_path: Path) -> None:
    src = tmp_path / "src"
    dest = tmp_path / "dest"
    ledger = src / "ledger.sqlite"
    config = src / "config.sqlite"
    _make_sqlite(ledger)
    _make_sqlite(config)
    wal = ledger.with_name(ledger.name + "-wal")
    shm = ledger.with_name(ledger.name + "-shm")
    wal.write_bytes(b"stray-wal")
    shm.write_bytes(b"stray-shm")
    layout = _layout(ledger, config, src / "cache.sqlite")

    move_synced_tiers(dest, layout=layout)

    assert not wal.exists()
    assert not shm.exists()


def test_move_creates_missing_destination_folder(tmp_path: Path) -> None:
    src = tmp_path / "src"
    ledger = src / "ledger.sqlite"
    config = src / "config.sqlite"
    _make_sqlite(ledger)
    _make_sqlite(config)
    dest = tmp_path / "a" / "b" / "c"
    layout = _layout(ledger, config, src / "cache.sqlite")

    move_synced_tiers(dest, layout=layout)

    assert (dest / "ledger.sqlite").exists()


def test_move_rejects_empty_destination(tmp_path: Path) -> None:
    layout = _layout(
        tmp_path / "ledger.sqlite", tmp_path / "config.sqlite", tmp_path / "cache.sqlite"
    )
    with pytest.raises(MoveError):
        move_synced_tiers("   ", layout=layout)


def test_move_rejects_same_folder(tmp_path: Path) -> None:
    ledger = tmp_path / "ledger.sqlite"
    config = tmp_path / "config.sqlite"
    _make_sqlite(ledger)
    _make_sqlite(config)
    layout = _layout(ledger, config, tmp_path / "cache.sqlite")
    with pytest.raises(MoveError):
        move_synced_tiers(tmp_path, layout=layout)


def test_move_refuses_to_overwrite_existing_file(tmp_path: Path) -> None:
    src = tmp_path / "src"
    dest = tmp_path / "dest"
    ledger = src / "ledger.sqlite"
    config = src / "config.sqlite"
    _make_sqlite(ledger)
    _make_sqlite(config)
    (dest).mkdir(parents=True)
    (dest / "ledger.sqlite").write_bytes(b"existing")
    layout = _layout(ledger, config, src / "cache.sqlite")
    with pytest.raises(MoveError):
        move_synced_tiers(dest, layout=layout)
    # The pre-existing file is left untouched.
    assert (dest / "ledger.sqlite").read_bytes() == b"existing"


def test_move_records_target_when_source_absent(tmp_path: Path) -> None:
    # A tier file that doesn't exist yet (created lazily on first boot) is
    # still recorded as a new target so the caller can persist it.
    src = tmp_path / "src"
    dest = tmp_path / "dest"
    layout = _layout(src / "ledger.sqlite", src / "config.sqlite", src / "cache.sqlite")

    result = move_synced_tiers(dest, layout=layout)

    assert result.moved["ledger"] == dest / "ledger.sqlite"
    assert result.backups["ledger"] is None
    assert not (dest / "ledger.sqlite").exists()
