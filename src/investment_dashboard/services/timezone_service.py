"""Timezone service — persists the timezone used to render header timestamps.

The header's "last refresh" clock previously hard-coded UTC, which is
confusing for a single-user local app where the relevant wall-clock time
is the user's own. v2.8.1 makes the timezone a persisted preference:

* the default sentinel ``"Local"`` follows the machine's local timezone,
  so out of the box the header already reads in the user's current
  timezone;
* the user can override it from Settings with any IANA zone name (e.g.
  ``"Europe/Berlin"``) or ``"UTC"``.

Persistence is via the ``app_config`` table, key ``display_timezone``.
"""

from __future__ import annotations

from datetime import UTC, datetime, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError, available_timezones

from sqlalchemy.orm import Session

from investment_dashboard.repositories import app_config_repo

#: Sentinel meaning "follow the machine's local timezone".
LOCAL = "Local"
DEFAULT_TIMEZONE = LOCAL

_CONFIG_KEY = "display_timezone"


def supported_timezones() -> list[str]:
    """Return the selectable timezone names: ``Local``, ``UTC``, then IANA zones."""
    zones = sorted(available_timezones())
    # Keep the two friendly sentinels first, then the full IANA list (with UTC
    # de-duplicated since it appears in ``available_timezones`` too).
    rest = [z for z in zones if z != "UTC"]
    return [LOCAL, "UTC", *rest]


def _local_tzinfo() -> tzinfo:
    """Return the machine's local ``tzinfo`` (never ``None``)."""
    local = datetime.now().astimezone().tzinfo
    return local if local is not None else UTC


def get_timezone(session: Session) -> str:
    """Return the persisted timezone name, defaulting to ``"Local"``."""
    raw = app_config_repo.get(session, _CONFIG_KEY)
    if raw is None:
        return DEFAULT_TIMEZONE
    candidate = raw.strip()
    if not candidate:
        return DEFAULT_TIMEZONE
    if candidate in (LOCAL, "UTC"):
        return candidate
    try:
        ZoneInfo(candidate)
    except (ZoneInfoNotFoundError, ValueError):
        return DEFAULT_TIMEZONE
    return candidate


def set_timezone(session: Session, name: str) -> str:
    """Persist a timezone name. Returns the normalised value.

    Raises ``ValueError`` if ``name`` is neither a sentinel nor a valid
    IANA zone.
    """
    candidate = name.strip()
    if candidate not in (LOCAL, "UTC"):
        try:
            ZoneInfo(candidate)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError(f"Unknown timezone {name!r}") from exc
    app_config_repo.set_value(session, _CONFIG_KEY, candidate)
    return candidate


def resolve_tzinfo(name: str) -> tzinfo:
    """Map a stored timezone name to a concrete ``tzinfo``."""
    if name == LOCAL:
        return _local_tzinfo()
    if name == "UTC":
        return UTC
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return _local_tzinfo()


def now(session: Session) -> datetime:
    """Return the current time in the persisted timezone."""
    return datetime.now(tz=resolve_tzinfo(get_timezone(session)))
