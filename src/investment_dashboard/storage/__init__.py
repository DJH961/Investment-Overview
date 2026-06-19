"""Storage-tier helpers: cloud detection, path resolution, file safety.

This package implements the v2.0 plan's storage layer:

* ``cloud`` — detect whether a directory belongs to a known cloud-sync
  client (OneDrive / iCloud / Dropbox / Google Drive).
* ``paths`` — resolve the three tier paths (ledger / config / cache)
  through the precedence chain documented in §4.1 of the plan.
* ``encryption`` — optional SQLCipher integration (Phase 4).
* ``blob_crypto`` — AES-256-GCM envelope for the v3.0 live-web blob.
* ``lock`` — single-writer file lock (Phase 5).
* ``sidecar`` — boot-time stray ``-wal`` / ``-shm`` scanner (Phase 5).
* ``integrity`` — ``PRAGMA integrity_check`` helpers (Phase 5).
* ``backup`` — rolling-backup service + verified-backup CLI helper.
"""

from __future__ import annotations

from investment_dashboard.storage.cloud import (
    CloudFolder,
    detect_cloud_sync_root,
    path_is_in_cloud_folder,
)
from investment_dashboard.storage.paths import (
    ResolvedPath,
    ResolverSource,
    StorageLayout,
    resolve_storage_layout,
)

__all__ = [
    "CloudFolder",
    "ResolvedPath",
    "ResolverSource",
    "StorageLayout",
    "detect_cloud_sync_root",
    "path_is_in_cloud_folder",
    "resolve_storage_layout",
]
