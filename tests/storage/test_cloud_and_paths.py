"""Tests for the cloud-folder detector and tier-path resolver."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from investment_dashboard.storage.cloud import (
    detect_cloud_sync_root,
    path_is_in_cloud_folder,
)
from investment_dashboard.storage.paths import (
    ResolverSource,
    resolve_storage_layout,
)


@pytest.fixture(autouse=True)
def _clear_cloud_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Strip cloud env vars so detector doesn't see the runner's HOME."""
    for var in (
        "OneDrive",
        "OneDriveConsumer",
        "OneDriveCommercial",
        "INV_DASHBOARD_DB_PATH",
        "INV_DASHBOARD_LEDGER_PATH",
        "INV_DASHBOARD_CONFIG_PATH",
        "INV_DASHBOARD_CACHE_PATH",
    ):
        monkeypatch.delenv(var, raising=False)


def test_detect_cloud_sync_root_returns_none_when_nothing_present(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    assert detect_cloud_sync_root() is None


def test_detect_onedrive_from_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    od = tmp_path / "OneDriveX"
    od.mkdir()
    monkeypatch.setenv("OneDrive", str(od))
    cloud = detect_cloud_sync_root()
    assert cloud is not None
    assert cloud.provider == "onedrive"
    assert cloud.root == od.resolve()


def test_detect_dropbox_via_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    (tmp_path / "Dropbox").mkdir()
    cloud = detect_cloud_sync_root()
    assert cloud is not None
    assert cloud.provider == "dropbox"


def test_detect_dropbox_via_info_json(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    relocated = tmp_path / "Elsewhere" / "Dropbox"
    relocated.mkdir(parents=True)
    info = tmp_path / ".dropbox" / "info.json"
    info.parent.mkdir()
    info.write_text(json.dumps({"personal": {"path": str(relocated)}}))
    cloud = detect_cloud_sync_root()
    assert cloud is not None
    assert cloud.provider == "dropbox"
    assert cloud.root == relocated.resolve()


def test_detect_gdrive_via_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    (tmp_path / "Google Drive").mkdir()
    cloud = detect_cloud_sync_root()
    assert cloud is not None
    assert cloud.provider == "gdrive"


def test_path_is_in_cloud_folder(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    od = tmp_path / "OneDrive"
    od.mkdir()
    monkeypatch.setenv("OneDrive", str(od))
    inside = od / "inv-dashboard" / "ledger.sqlite"
    outside = tmp_path / "elsewhere" / "ledger.sqlite"
    assert path_is_in_cloud_folder(inside) is not None
    assert path_is_in_cloud_folder(outside) is None


def test_resolver_env_wins(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    monkeypatch.setenv("INV_DASHBOARD_LEDGER_PATH", str(tmp_path / "ledger.sqlite"))
    monkeypatch.setenv("INV_DASHBOARD_CONFIG_PATH", str(tmp_path / "config.sqlite"))
    monkeypatch.setenv("INV_DASHBOARD_CACHE_PATH", str(tmp_path / "cache.sqlite"))
    layout = resolve_storage_layout()
    assert layout.ledger.source is ResolverSource.ENV
    assert layout.config.source is ResolverSource.ENV
    assert layout.cache.source is ResolverSource.ENV


def test_resolver_persisted_overrides_default(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    layout = resolve_storage_layout(
        config_overrides={
            "ledger_path": str(tmp_path / "x" / "ledger.sqlite"),
            "config_path": str(tmp_path / "x" / "config.sqlite"),
            # cache_path is *intentionally ignored*
            "cache_path": str(tmp_path / "x" / "cache.sqlite"),
        }
    )
    assert layout.ledger.source is ResolverSource.PERSISTED
    assert layout.config.source is ResolverSource.PERSISTED
    # Cache must NOT come from persisted, even if a key is present.
    assert layout.cache.source is not ResolverSource.PERSISTED


def test_resolver_falls_back_to_local_default(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "share"))
    layout = resolve_storage_layout(detect_cloud=False)
    assert layout.ledger.source is ResolverSource.LOCAL_DEFAULT
    assert layout.ledger.path == tmp_path / "share" / "inv-dashboard" / "ledger.sqlite"
    assert layout.cache.path == tmp_path / "share" / "inv-dashboard" / "cache.sqlite"


def test_resolver_uses_cloud_default_when_detected(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "share"))
    od = tmp_path / "OneDrive"
    od.mkdir()
    monkeypatch.setenv("OneDrive", str(od))
    layout = resolve_storage_layout()
    assert layout.ledger.source is ResolverSource.CLOUD_DEFAULT
    assert layout.ledger.path == od.resolve() / "inv-dashboard" / "ledger.sqlite"
    assert layout.config.source is ResolverSource.CLOUD_DEFAULT
    # Cache *must* stay local even when a cloud root is detected.
    assert layout.cache.source is ResolverSource.LOCAL_DEFAULT
    assert "OneDrive" not in str(layout.cache.path)


def test_resolver_legacy_env_seeds_sibling_files(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    legacy = tmp_path / "legacy" / "db.sqlite"
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(legacy))
    layout = resolve_storage_layout(detect_cloud=False)
    assert layout.ledger.path == legacy.parent / "ledger.sqlite"
    assert layout.config.path == legacy.parent / "config.sqlite"
    assert layout.cache.path == legacy.parent / "cache.sqlite"
