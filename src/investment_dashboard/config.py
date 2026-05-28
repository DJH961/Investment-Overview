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

    #: Encryption passphrase for the ledger/config tiers. Normally
    #: ``None`` (driver fetches it from the OS keyring); set via the
    #: ``INV_DASHBOARD_DB_PASSPHRASE`` env var for CI/test only.
    db_passphrase: str | None = None
    #: When ``True``, the ledger and config tiers are expected to be
    #: SQLCipher-encrypted (``sqlite+pysqlcipher://``). Without the
    #: driver installed, boot fails fast with a clear message.
    encrypt_synced_tiers: bool = False

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


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
