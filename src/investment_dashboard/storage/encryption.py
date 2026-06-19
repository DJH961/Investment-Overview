"""Optional SQLCipher encryption for the ledger and config tiers.

Implements the v2.0 plan §5.1. SQLCipher is an *optional* dependency
installed via the ``[encrypted]`` extra (``pysqlcipher3`` or
``sqlcipher3-binary``). The driver is only required when the user has
enabled encryption (``Settings.encrypt_synced_tiers`` or one of the
tier files ends with ``.enc.sqlite`` etc.); a vanilla install must
keep working without the dependency.

Key material lives in the OS keychain via the ``keyring`` package and
is **never** persisted to disk by us. Loss of passphrase = loss of
data, so :func:`build_recovery_file` produces a printable recovery
document the user can save somewhere safe; the onboarding/Settings UI
collects the passphrase (:func:`store_passphrase_in_keyring`) and
offers the recovery file as a download.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from importlib import import_module
from importlib import util as importlib_util
from pathlib import Path
from types import ModuleType
from typing import Any

log = logging.getLogger(__name__)

_KEYRING_SERVICE = "investment-dashboard"
_KEYRING_USERNAME = "synced-tiers"

#: Keyring usernames for the v3.0 live-web companion secrets. They share the
#: SQLCipher service so all app secrets live in one keychain entry group, but
#: use distinct usernames so the mobile passphrase, publish token, and DB
#: passphrase never collide.
_KEYRING_MOBILE_PASSPHRASE_USERNAME = "mobile-passphrase"
_KEYRING_PUBLISH_TOKEN_USERNAME = "publish-token"

#: Suggested filename for the saved recovery document.
RECOVERY_FILENAME = "investment-dashboard-recovery.txt"

#: Minimum passphrase length accepted by :func:`validate_passphrase`.
MIN_PASSPHRASE_LENGTH = 8


class EncryptionUnavailableError(RuntimeError):
    """Raised when encryption is configured but the driver is missing."""


class PassphraseMissingError(RuntimeError):
    """Raised when encryption is configured but no passphrase is available."""


@dataclass(frozen=True)
class EncryptionConfig:
    """Resolved encryption state for one boot."""

    enabled: bool
    driver: str | None = None  # "pysqlcipher3" or "sqlcipher3"
    passphrase: str | None = None


def sql_string_literal(value: str) -> str:
    """Return ``value`` as a single-quoted SQL string literal."""
    return "'" + value.replace("'", "''") + "'"


def _detect_driver() -> str | None:
    for name in ("pysqlcipher3", "sqlcipher3"):
        if importlib_util.find_spec(name) is not None:
            return name
    return None


def load_passphrase_from_keyring() -> str | None:
    """Look up the synced-tier passphrase in the OS keychain.

    Returns ``None`` if ``keyring`` isn't installed or the entry is
    absent. We treat both equivalently to keep the failure path
    uniform (caller decides whether to prompt).
    """
    return _keyring_get(_KEYRING_USERNAME)


def store_passphrase_in_keyring(passphrase: str) -> bool:
    """Persist the passphrase to the OS keychain. Returns ``True`` on success."""
    return _keyring_set(_KEYRING_USERNAME, passphrase)


def load_mobile_passphrase_from_keyring() -> str | None:
    """Look up the v3.0 live-web companion passphrase in the OS keychain."""
    return _keyring_get(_KEYRING_MOBILE_PASSPHRASE_USERNAME)


def store_mobile_passphrase_in_keyring(passphrase: str) -> bool:
    """Persist the live-web companion passphrase to the OS keychain."""
    return _keyring_set(_KEYRING_MOBILE_PASSPHRASE_USERNAME, passphrase)


def load_publish_token_from_keyring() -> str | None:
    """Look up the GitHub publish PAT in the OS keychain."""
    return _keyring_get(_KEYRING_PUBLISH_TOKEN_USERNAME)


def store_publish_token_in_keyring(token: str) -> bool:
    """Persist the GitHub publish PAT to the OS keychain."""
    return _keyring_set(_KEYRING_PUBLISH_TOKEN_USERNAME, token)


def _keyring_get(username: str) -> str | None:
    try:
        import keyring  # noqa: PLC0415
    except ImportError:
        return None
    try:
        return keyring.get_password(_KEYRING_SERVICE, username)
    except Exception:  # pragma: no cover - backend-specific
        log.warning("keyring lookup failed", exc_info=True)
        return None


def _keyring_set(username: str, secret: str) -> bool:
    try:
        import keyring  # noqa: PLC0415
    except ImportError:
        return False
    try:
        keyring.set_password(_KEYRING_SERVICE, username, secret)
        return True
    except Exception:  # pragma: no cover - backend-specific
        log.warning("keyring store failed", exc_info=True)
        return False


def validate_passphrase(passphrase: str, confirm: str) -> str | None:
    """Validate a user-entered passphrase pair.

    Returns ``None`` when the pair is acceptable, otherwise a short,
    user-facing error message explaining what to fix. Used by the
    onboarding / Settings passphrase prompts before the secret is
    stored in the keychain.
    """
    if not passphrase:
        return "Enter a passphrase."
    if len(passphrase) < MIN_PASSPHRASE_LENGTH:
        return f"Passphrase must be at least {MIN_PASSPHRASE_LENGTH} characters."
    if passphrase != confirm:
        return "The two passphrases don't match."
    return None


def build_recovery_file(passphrase: str, *, generated_at: datetime | None = None) -> str:
    """Return the text of a printable passphrase-recovery document.

    The passphrase is the only thing standing between the user and their
    encrypted ledger/config tiers, and we deliberately never write it to
    disk ourselves. This document lets the user keep their own offline
    copy (printed, in a password manager, etc.). It records the keychain
    location so a future restore knows where the app expects the secret.
    """
    when = (generated_at or datetime.now(UTC)).strftime("%Y-%m-%d %H:%M UTC")
    return (
        "Investment Dashboard — encryption recovery file\n"
        "===============================================\n\n"
        f"Generated: {when}\n\n"
        "This passphrase decrypts your synced ledger and config databases.\n"
        "If you lose it, the encrypted data CANNOT be recovered. Store this\n"
        "file somewhere safe and offline (a password manager or a printout),\n"
        "NOT next to the synced database files.\n\n"
        f"Passphrase: {passphrase}\n\n"
        "Keychain location (where the app stores this secret):\n"
        f"  Service:  {_KEYRING_SERVICE}\n"
        f"  Username: {_KEYRING_USERNAME}\n\n"
        "To restore on a new machine, re-enter this passphrase in\n"
        "Settings -> Storage, or set the INV_DASHBOARD_DB_PASSPHRASE\n"
        "environment variable before launching the app.\n"
    )


def _sqlcipher_dbapi(driver: str) -> ModuleType:
    if driver in {"pysqlcipher3", "sqlcipher3"}:
        return import_module(f"{driver}.dbapi2")
    raise EncryptionUnavailableError(f"unsupported SQLCipher driver: {driver!r}")


def apply_sqlcipher_key(dbapi_conn: Any, config: EncryptionConfig) -> None:
    """Apply the SQLCipher key as the first statement on ``dbapi_conn``."""
    if not config.enabled or config.passphrase is None:
        return
    cursor = dbapi_conn.cursor()
    try:
        cursor.execute(f"PRAGMA key = {sql_string_literal(config.passphrase)}")
    finally:
        cursor.close()


def connect_sqlite(db_path: Path, config: EncryptionConfig | None = None) -> Any:
    """Open a SQLite/SQLCipher connection and apply ``config`` when enabled."""
    if config is not None and config.enabled:
        if config.driver is None:
            raise EncryptionUnavailableError("encryption enabled but no SQLCipher driver resolved")
        sqlcipher = _sqlcipher_dbapi(config.driver)
        conn = sqlcipher.connect(str(db_path))
        apply_sqlcipher_key(conn, config)
        return conn

    import sqlite3  # noqa: PLC0415

    return sqlite3.connect(str(db_path))


def resolve_encryption(
    *,
    encrypt_synced_tiers: bool,
    env_passphrase: str | None,
) -> EncryptionConfig:
    """Decide whether encryption is on for this boot.

    * If ``encrypt_synced_tiers`` is ``False``, return a disabled
      config regardless of driver/passphrase state.
    * Otherwise require both the driver and a passphrase, raising the
      respective error if either is missing.

    Passphrase precedence: env var > keyring.
    """
    if not encrypt_synced_tiers:
        return EncryptionConfig(enabled=False)
    driver = _detect_driver()
    if driver is None:
        raise EncryptionUnavailableError(
            "Encryption is enabled (Settings.encrypt_synced_tiers=True) but "
            "no SQLCipher Python driver is installed. Install with "
            "`pip install investment-dashboard[encrypted]`."
        )
    passphrase = env_passphrase or load_passphrase_from_keyring()
    if not passphrase:
        raise PassphraseMissingError(
            "Encryption is enabled but no passphrase was found. Set "
            "INV_DASHBOARD_DB_PASSPHRASE or store the passphrase via the "
            "onboarding flow (saved to the OS keychain)."
        )
    return EncryptionConfig(enabled=True, driver=driver, passphrase=passphrase)


def to_sqlcipher_url(sqlite_url: str, config: EncryptionConfig) -> str:
    """Rewrite ``sqlite:///...`` to use the SQLCipher driver if enabled.

    The passphrase is *not* placed into the URL — it is applied via
    ``PRAGMA key`` on each connect (see ``db._install_sqlite_pragmas``).
    Embedding it in the URL would leak it into logs.
    """
    if not config.enabled:
        return sqlite_url
    if not sqlite_url.startswith("sqlite:///"):
        return sqlite_url
    if config.driver == "pysqlcipher3":
        return "sqlite+pysqlcipher" + sqlite_url[len("sqlite") :]
    if config.driver == "sqlcipher3":  # pragma: no cover - alternate driver
        return "sqlite+pysqlcipher" + sqlite_url[len("sqlite") :]
    return sqlite_url  # pragma: no cover - belt & braces
