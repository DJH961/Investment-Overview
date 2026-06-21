"""Application configuration loaded from env vars and optional .env file."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _default_data_dir() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / "inv-dashboard"


def _default_db_path() -> Path:
    """Legacy single-file path. Retained for back-compat."""
    return _default_data_dir() / "db.sqlite"


class Settings(BaseSettings):
    """Top-level app settings.

    Storage tier paths (rework v2.0):
      * ``ledger_path`` — accounts, instruments, transactions, target
        allocations. Source of truth; safe to sync to the cloud (with
        encryption — see Phase 4).
      * ``config_path`` — user-overridable display/UX settings
        (``instrument_overrides``, ``app_config``). Small, syncable.
      * ``cache_path`` — derived data (prices, FX, snapshots,
        ``price_cache_metadata``). Local-only by default; cheap to
        rebuild.

    Back-compat: ``db_path`` and the legacy ``INV_DASHBOARD_DB_PATH``
    env var continue to work — they seed a single shared file used by
    all three tiers when individual tier paths aren't set.
    """

    model_config = SettingsConfigDict(
        env_prefix="INV_DASHBOARD_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    db_path: Path = Field(default_factory=_default_db_path)
    ledger_path: Path | None = None
    config_path: Path | None = None
    cache_path: Path | None = None
    host: str = "0.0.0.0"
    port: int = 8080
    log_level: str = "INFO"

    #: Optional override for where rotating log files are written. When
    #: ``None`` (default) logs land in a ``logs/`` folder beside the active
    #: database file so they're easy to find and share. Set via
    #: ``INV_DASHBOARD_LOG_DIR`` to relocate them.
    log_dir: Path | None = None
    #: Max size of a single log file before it rolls over (bytes).
    log_max_bytes: int = 2_000_000
    #: How many rolled-over log files to keep alongside the active one.
    log_backup_count: int = 5

    #: Encryption passphrase for the ledger/config tiers. Normally
    #: ``None`` (driver fetches it from the OS keyring); set via the
    #: ``INV_DASHBOARD_DB_PASSPHRASE`` env var for CI/test only.
    db_passphrase: str | None = None
    #: When ``True``, the ledger and config tiers are expected to be
    #: SQLCipher-encrypted (``sqlite+pysqlcipher://``). Without the
    #: driver installed, boot fails fast with a clear message.
    encrypt_synced_tiers: bool = False

    #: When ``True``, the read-only JSON API (see
    #: :mod:`investment_dashboard.api`) is mounted on the NiceGUI server
    #: under ``/api``. Off by default so the default LAN experience is
    #: unchanged.
    api_enabled: bool = False
    #: Optional bearer token guarding every ``/api`` route. When ``None``
    #: the API is unauthenticated (acceptable on a trusted LAN); set it
    #: the moment the server is reachable beyond the LAN (e.g. via a VPN
    #: or reverse proxy). Compared in constant time.
    api_token: str | None = None
    #: Output path for ``inv-dashboard-export-snapshot``. Defaults to a
    #: ``mobile_snapshot.json`` next to the config tier so it rides the
    #: same consumer-cloud sync the user already set up.
    snapshot_path: Path | None = None

    # --- v3.0 live-web companion publishing (docs/v3.0 proposal §5.5) -------
    # All additive and off by default: a vanilla install never publishes.
    #: Master toggle. When ``False`` (default) no publishing happens, and the
    #: auto-publish triggers stay dormant.
    publish_enabled: bool = False
    #: Target repository in ``owner/name`` form (e.g. ``DJH961/Investment-Overview``)
    #: that hosts the GitHub Pages app + the encrypted release asset.
    publish_repo: str | None = None
    #: Release tag whose single asset is overwritten on each publish. Keeping
    #: the ciphertext on a fixed release (not committed into the tree) keeps
    #: old encrypted snapshots out of git history.
    publish_release_tag: str = "live-data"
    #: GitHub fine-grained PAT (Contents: write on ``publish_repo`` only).
    #: Normally ``None`` — resolved from the OS keyring; set via env for CI.
    publish_token: str | None = None
    #: Passphrase the browser uses to decrypt the published blob. Separate from
    #: ``db_passphrase``. Normally ``None`` — resolved from the OS keyring.
    mobile_passphrase: str | None = None
    #: Whether the published export includes the (larger) transaction list.
    publish_include_transactions: bool = False

    #: Optional password gating the Settings "Developer tools" panel (the
    #: full audit export). When ``None`` the panel is ungated — fine for the
    #: single-user, local-first default; set it to keep the export tucked
    #: away behind a password. Compared in constant time.
    dev_password: str | None = None

    #: When ``True``, the server stops itself a short grace period after the
    #: last browser tab disconnects, releasing the single-writer lock (see
    #: :mod:`investment_dashboard.shutdown`). Off by default so a server left
    #: open intentionally (e.g. a LAN host) keeps running; the desktop user
    #: can enable it from Settings. Acts as the initial value only — the
    #: persisted ``auto_shutdown_on_tab_close`` app-config key wins when set.
    shutdown_on_tab_close: bool = False

    @field_validator("log_level")
    @classmethod
    def _upper(cls, v: str) -> str:
        return v.upper()

    @model_validator(mode="after")
    def _resolve_tier_paths(self) -> Settings:
        # When a tier path isn't set explicitly, fall back to the
        # legacy single-file ``db_path`` so existing installations and
        # tests keep working unchanged.
        if self.ledger_path is None:
            object.__setattr__(self, "ledger_path", self.db_path)
        if self.config_path is None:
            object.__setattr__(self, "config_path", self.db_path)
        if self.cache_path is None:
            object.__setattr__(self, "cache_path", self.db_path)
        return self

    def storage_layout(
        self,
        *,
        config_overrides: dict[str, str] | None = None,
        detect_cloud: bool = True,
    ):
        """Return the cloud-aware :class:`StorageLayout` for this run.

        See :mod:`investment_dashboard.storage.paths` for resolution
        rules. ``Settings`` itself remains the back-compat surface;
        ``boot.apply_resolved_layout()`` mutates the active settings
        instance with the resolved paths before any engine is created.
        """
        from investment_dashboard.storage import resolve_storage_layout  # noqa: PLC0415

        return resolve_storage_layout(config_overrides=config_overrides, detect_cloud=detect_cloud)

    @staticmethod
    def _to_url(path: Path) -> str:
        # In-memory databases are referenced as ``:memory:`` (Pydantic
        # coerces this to a ``Path`` but as_posix() round-trips fine).
        as_str = path.as_posix()
        if as_str == ":memory:":
            return "sqlite:///:memory:"
        return f"sqlite:///{as_str}"

    @property
    def resolved_log_dir(self) -> Path:
        """Directory that holds the rotating log files.

        Uses ``log_dir`` when set, otherwise a ``logs/`` folder beside the
        active database so logs sit next to the data they describe. In-memory
        databases (tests) fall back to the default data dir so nothing is
        written into the working tree.
        """
        if self.log_dir is not None:
            return self.log_dir
        base = self.db_path
        if base.as_posix() == ":memory:":
            return _default_data_dir() / "logs"
        return base.parent / "logs"

    @property
    def log_file_path(self) -> Path:
        """Absolute path of the active (non-rotated) log file."""
        return self.resolved_log_dir / "dashboard.log"

    @property
    def db_url(self) -> str:
        """Legacy single-file URL (== ``ledger_url``)."""
        return self._to_url(self.db_path)

    @property
    def ledger_url(self) -> str:
        assert self.ledger_path is not None
        return self._to_url(self.ledger_path)

    @property
    def config_url(self) -> str:
        assert self.config_path is not None
        return self._to_url(self.config_path)

    @property
    def cache_url(self) -> str:
        assert self.cache_path is not None
        return self._to_url(self.cache_path)

    @property
    def is_split_db(self) -> bool:
        """True when at least one tier points at a distinct file."""
        return not (self.ledger_path == self.config_path == self.cache_path)

    @property
    def resolved_snapshot_path(self) -> Path:
        """Where ``inv-dashboard-export-snapshot`` writes by default.

        Uses ``snapshot_path`` when set, otherwise a ``mobile_snapshot.json``
        beside the config tier so it inherits the user's existing
        consumer-cloud sync.
        """
        if self.snapshot_path is not None:
            return self.snapshot_path
        base = self.config_path if self.config_path is not None else self.db_path
        return base.parent / "mobile_snapshot.json"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
