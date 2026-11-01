"""Cloud-sync folder detection.

Implements ``detect_cloud_sync_root`` per the v2.0 plan §4.3 and the
helper ``path_is_in_cloud_folder`` used by the journal-mode and
encryption guards in Phases 4 and 5.

All checks are best-effort: a directory only counts as "cloud-synced"
if it actually exists on disk. The detector never executes the cloud
client; it just inspects well-known paths and config files.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class CloudFolder:
    """A detected cloud-sync root."""

    #: ``onedrive``, ``icloud``, ``dropbox``, ``gdrive``.
    provider: str
    #: Absolute path on disk.
    root: Path


def _env_path(name: str) -> Path | None:
    raw = os.environ.get(name)
    if not raw:
        return None
    p = Path(raw).expanduser()
    return p if p.exists() else None


def _existing(*candidates: Path) -> Path | None:
    for cand in candidates:
        try:
            if cand.exists():
                return cand
        except OSError:
            continue
    return None


def _detect_onedrive() -> Path | None:
    for var in ("OneDrive", "OneDriveConsumer", "OneDriveCommercial"):
        p = _env_path(var)
        if p is not None:
            return p
    home = Path.home()
    return _existing(home / "OneDrive")


def _detect_icloud() -> Path | None:
    home = Path.home()
    mac = home / "Library" / "Mobile Documents" / "com~apple~CloudDocs"
    win = home / "iCloudDrive"
    return _existing(mac, win)


def _parse_dropbox_info(info_path: Path) -> Path | None:
    try:
        data = json.loads(info_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    for account in data.values():
        if not isinstance(account, dict):
            continue
        raw = account.get("path")
        if not isinstance(raw, str):
            continue
        p = Path(raw).expanduser()
        if p.exists():
            return p
    return None


def _detect_dropbox() -> Path | None:
    home = Path.home()
    # Well-known default first; covers most users.
    p = _existing(home / "Dropbox")
    if p is not None:
        return p
    # Relocated installs leave a JSON file on Windows under APPDATA
    # and on POSIX under ~/.dropbox/info.json.
    info_candidates = [
        home / ".dropbox" / "info.json",
        Path(os.environ.get("APPDATA", "")) / "Dropbox" / "info.json"
        if os.environ.get("APPDATA")
        else home / ".dropbox" / "info.json",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Dropbox" / "info.json"
        if os.environ.get("LOCALAPPDATA")
        else home / ".dropbox" / "info.json",
    ]
    seen: set[Path] = set()
    for info in info_candidates:
        if info in seen:
            continue
        seen.add(info)
        if not info.exists():
            continue
        parsed = _parse_dropbox_info(info)
        if parsed is not None:
            return parsed
    return None


def _detect_gdrive() -> Path | None:
    home = Path.home()
    candidates = [
        home / "Google Drive",
        home / "GoogleDrive",
        home / "My Drive",
    ]
    p = _existing(*candidates)
    if p is not None:
        return p
    # macOS modern Drive for Desktop layout.
    cloud_storage = home / "Library" / "CloudStorage"
    if cloud_storage.exists():
        try:
            for child in cloud_storage.iterdir():
                if child.name.startswith("GoogleDrive-") and child.exists():
                    return child
        except OSError:
            pass
    return None


_DETECTORS: list[tuple[str, callable[[], Path | None]]] = [
    ("onedrive", _detect_onedrive),
    ("icloud", _detect_icloud),
    ("dropbox", _detect_dropbox),
    ("gdrive", _detect_gdrive),
]


@lru_cache(maxsize=1)
def detect_cloud_sync_root() -> CloudFolder | None:
    """Return the first detected cloud-sync root, or ``None``.

    Order matches the spec (OneDrive → iCloud → Dropbox → Google Drive);
    the first detector that returns an existing path wins.

    The result is deterministic for the life of the process (the cloud root
    cannot change mid-run) and each detection performs several filesystem
    probes plus a Dropbox JSON parse, so it is memoized. Tests that vary the
    environment should call ``detect_cloud_sync_root.cache_clear()``.
    """
    for provider, fn in _DETECTORS:
        try:
            root = fn()
        except Exception:  # pragma: no cover - paranoia
            log.warning("cloud detector %s raised", provider, exc_info=True)
            continue
        if root is not None:
            return CloudFolder(provider=provider, root=root.resolve())
    return None


def _all_cloud_roots() -> list[CloudFolder]:
    """Return every cloud root the detector can find (not just the first)."""
    found: list[CloudFolder] = []
    for provider, fn in _DETECTORS:
        try:
            root = fn()
        except Exception:  # pragma: no cover
            continue
        if root is not None:
            found.append(CloudFolder(provider=provider, root=root.resolve()))
    return found


def path_is_in_cloud_folder(path: Path) -> CloudFolder | None:
    """If ``path`` lives inside a detected cloud root, return that root.

    The check is purely lexical against the resolved parent paths; it
    does not stat ``path`` itself (it may not exist yet).
    """
    try:
        target = path.expanduser().resolve()
    except OSError:
        target = path.expanduser()
    for cloud in _all_cloud_roots():
        try:
            target.relative_to(cloud.root)
            return cloud
        except ValueError:
            continue
    return None
