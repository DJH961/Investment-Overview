"""Backups: settings-driven retention/cadence, list, verify and safe name lookup."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from investment_dashboard import db as db_module
from investment_dashboard.config import get_settings
from investment_dashboard.db import dispose_engines, get_ledger_engine
from investment_dashboard.models import ALL_METADATAS
from investment_dashboard.services import backup_service, settings_service


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
    settings_service.invalidate()
    db_module.clear_dirty()
    try:
        yield db
    finally:
        settings_service.invalidate()
        dispose_engines()
        get_settings.cache_clear()
        db_module.clear_dirty()


def test_retention_and_cadence_follow_settings(app_db: Path) -> None:
    assert backup_service.configured_retention() == backup_service.Retention()
    settings_service.set_many(
        {"backup.retention.hourly": 1, "backup.nightly_hours": 2, "backup.debounce_seconds": 300},
        actor="t",
    )
    assert backup_service.configured_retention().hourly == 1
    assert backup_service.nightly_seconds() == 7200
    assert backup_service.debounce_seconds() == 300


def test_list_verify_and_lookup(app_db: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(backup_service.blob_crypto, "PBKDF2_ITERATIONS", 1000)
    now = datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)
    path = backup_service.create_snapshot(now=now)
    listed = backup_service.describe_snapshots()
    assert [s["name"] for s in listed] == [path.name]
    assert listed[0]["size_bytes"] > 0
    result = backup_service.verify_snapshot(path.name)
    assert result["integrity"] == "ok"
    for bad in ("../app.sqlite", "snapshot-x.sealed.json", path.name + "/.."):
        with pytest.raises(backup_service.SnapshotError):
            backup_service.snapshot_by_name(bad)
    with pytest.raises(backup_service.SnapshotError):
        backup_service.snapshot_by_name("snapshot-20200101-000000.sealed.json")
    assert backup_service.is_due(now + timedelta(days=2))
