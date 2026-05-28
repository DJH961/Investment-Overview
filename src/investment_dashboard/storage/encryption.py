"""Optional SQLCipher encryption for the ledger and config tiers.

Implements the v2.0 plan §5.1. SQLCipher is an *optional* dependency
installed via the ``[encrypted]`` extra (``pysqlcipher3`` or
``sqlcipher3-binary``). The driver is only required when the user has
enabled encryption (``Settings.encrypt_synced_tiers`` or one of the
tier files ends with ``.enc.sqlite`` etc.); a vanilla install must
keep working without the dependency.

Key material lives in the OS keychain via the ``keyring`` package and
is **never** persisted to disk by us. Loss of passphrase = loss of
data; we offer a "save recovery file" prompt during onboarding (out
of scope here; surfaced as a UI follow-up).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from importlib import util as importlib_util

log = logging.getLogger(__name__)

_KEYRING_SERVICE = "investment-dashboard"
_KEYRING_USERNAME = "synced-tiers"


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


def _detect_driver() -> str | None:
    for name in ("pysqlcipher3", "sqlcipher3"):
        if importlib_util.find_spec(name) is not None:
            return name
    return None


def driver_available() -> bool:
    """``True`` if a SQLCipher Python binding is importable."""
    return _detect_driver() is not None


def load_passphrase_from_keyring() -> str | None:
    """Look up the synced-tier passphrase in the OS keychain.

    Returns ``None`` if ``keyring`` isn't installed or the entry is
    absent. We treat both equivalently to keep the failure path
    uniform (caller decides whether to prompt).
    """
    try:
        import keyring  # noqa: PLC0415
    except ImportError:
        return None
    try:
        return keyring.get_password(_KEYRING_SERVICE, _KEYRING_USERNAME)
    except Exception:  # pragma: no cover - backend-specific
        log.warning("keyring lookup failed", exc_info=True)
        return None


def store_passphrase_in_keyring(passphrase: str) -> bool:
    """Persist the passphrase to the OS keychain. Returns ``True`` on success."""
    try:
        import keyring  # noqa: PLC0415
    except ImportError:
        return False
    try:
        keyring.set_password(_KEYRING_SERVICE, _KEYRING_USERNAME, passphrase)
        return True
    except Exception:  # pragma: no cover - backend-specific
        log.warning("keyring store failed", exc_info=True)
        return False


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
