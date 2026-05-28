"""Tier-path resolution.

Implements the v2.0 plan §4.1 precedence chain for each of
``ledger_path`` / ``config_path`` / ``cache_path``:

1. Explicit env var (``INV_DASHBOARD_LEDGER_PATH`` etc.).
2. Value persisted in the config-tier ``app_config`` table
   (**ledger and config only** — the cache path is never persisted to
   a synced file).
3. First-run default: ``detect_cloud_sync_root()`` → ``inv-dashboard``
   subfolder under that root, for ledger and config only. The cache
   stays local regardless.
4. Hard fallback: ``$XDG_DATA_HOME/inv-dashboard`` (POSIX) or
   ``%LOCALAPPDATA%\\inv-dashboard`` (Windows).

This module is a *pure* resolver: it never opens engines, never reads
the DB. Callers pass in the already-loaded persisted overrides
(``config_overrides`` mapping). The actual wiring into ``Settings``
lives in ``config.py`` and ``boot.py``.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from investment_dashboard.storage.cloud import CloudFolder, detect_cloud_sync_root


class ResolverSource(StrEnum):
    """Which step in the precedence chain produced a tier path."""

    ENV = "env"
    PERSISTED = "persisted"
    CLOUD_DEFAULT = "cloud_default"
    LOCAL_DEFAULT = "local_default"


@dataclass(frozen=True)
class ResolvedPath:
    """A resolved tier path plus the step that produced it."""

    path: Path
    source: ResolverSource
    cloud: CloudFolder | None = None


@dataclass(frozen=True)
class StorageLayout:
    """The three resolved tier paths."""

    ledger: ResolvedPath
    config: ResolvedPath
    cache: ResolvedPath


_LEDGER_ENV = "INV_DASHBOARD_LEDGER_PATH"
_CONFIG_ENV = "INV_DASHBOARD_CONFIG_PATH"
_CACHE_ENV = "INV_DASHBOARD_CACHE_PATH"
_LEGACY_ENV = "INV_DASHBOARD_DB_PATH"

_LEDGER_FILENAME = "ledger.sqlite"
_CONFIG_FILENAME = "config.sqlite"
_CACHE_FILENAME = "cache.sqlite"


def _local_default_root() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / "inv-dashboard"


def _env_override(name: str) -> Path | None:
    raw = os.environ.get(name)
    if not raw:
        return None
    return Path(raw).expanduser()


def resolve_storage_layout(
    *,
    config_overrides: dict[str, str] | None = None,
    detect_cloud: bool = True,
) -> StorageLayout:
    """Resolve the three tier paths.

    Args:
        config_overrides: persisted values loaded from the config-tier
            ``app_config`` table. Keys recognised: ``ledger_path``,
            ``config_path``. ``cache_path`` is intentionally ignored
            even if present, per §4.1.
        detect_cloud: when ``False``, skip the cloud-detector step
            (used by tests that don't want to touch the real
            environment).

    The returned :class:`StorageLayout` records *which* resolver step
    produced each path so the Settings UI can show it.
    """
    overrides = config_overrides or {}

    legacy = _env_override(_LEGACY_ENV)
    cloud = detect_cloud_sync_root() if detect_cloud else None

    def _resolve_synced(env_name: str, persist_key: str, filename: str) -> ResolvedPath:
        env_val = _env_override(env_name)
        if env_val is not None:
            return ResolvedPath(env_val, ResolverSource.ENV)
        persisted = overrides.get(persist_key)
        if persisted:
            return ResolvedPath(Path(persisted).expanduser(), ResolverSource.PERSISTED)
        if legacy is not None:
            # Legacy single-file env: derive sibling tier files alongside it.
            parent = legacy.parent if legacy.name else legacy
            return ResolvedPath(parent / filename, ResolverSource.LOCAL_DEFAULT)
        if cloud is not None:
            return ResolvedPath(
                cloud.root / "inv-dashboard" / filename,
                ResolverSource.CLOUD_DEFAULT,
                cloud=cloud,
            )
        return ResolvedPath(_local_default_root() / filename, ResolverSource.LOCAL_DEFAULT)

    def _resolve_local() -> ResolvedPath:
        env_val = _env_override(_CACHE_ENV)
        if env_val is not None:
            return ResolvedPath(env_val, ResolverSource.ENV)
        if legacy is not None:
            parent = legacy.parent if legacy.name else legacy
            return ResolvedPath(parent / _CACHE_FILENAME, ResolverSource.LOCAL_DEFAULT)
        return ResolvedPath(_local_default_root() / _CACHE_FILENAME, ResolverSource.LOCAL_DEFAULT)

    return StorageLayout(
        ledger=_resolve_synced(_LEDGER_ENV, "ledger_path", _LEDGER_FILENAME),
        config=_resolve_synced(_CONFIG_ENV, "config_path", _CONFIG_FILENAME),
        cache=_resolve_local(),
    )
