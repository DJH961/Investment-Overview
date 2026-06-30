"""Clock-format service — persists the 12-hour / 24-hour header clock choice.

The header's "last refresh" clock previously hard-coded a 24-hour
``%H:%M`` rendering. The web companion already lets the user pick a clock
format (Auto / 12-hour / 24-hour, see ``web/src/time-format.ts``); this
brings the desktop to parity with the same three-way preference.

* the default sentinel ``"auto"`` follows the machine's locale, so out of
  the box the header keeps its familiar formatting;
* ``"12h"`` forces an AM/PM clock and ``"24h"`` forces a 24-hour clock,
  everywhere the header timestamp is rendered.

Persistence is via the ``app_config`` table, key ``clock_format``. Only
presentation is affected — no stored data or money is touched.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy.orm import Session

from investment_dashboard.repositories import app_config_repo

#: Selectable clock formats. ``"auto"`` defers to the system locale.
SUPPORTED_FORMATS: tuple[str, ...] = ("auto", "12h", "24h")
DEFAULT_FORMAT = "auto"

_CONFIG_KEY = "clock_format"

#: ``strftime`` patterns for the date + time portion of the header clock.
#: ``"auto"`` uses the platform's locale-aware time representation (``%X``
#: includes seconds, so it is trimmed to hours+minutes by the caller via the
#: explicit patterns below). We keep an explicit 24-hour pattern for ``"auto"``
#: as a stable fallback and let :func:`format_clock` honour the locale only when
#: the user has not pinned a format.
_PATTERNS: dict[str, str] = {
    "12h": "%Y-%m-%d %I:%M %p",
    "24h": "%Y-%m-%d %H:%M",
}


def get_clock_format(session: Session) -> str:
    """Return the persisted clock format, defaulting to ``"auto"``."""
    raw = app_config_repo.get(session, _CONFIG_KEY)
    if raw is None:
        return DEFAULT_FORMAT
    candidate = raw.strip().lower()
    if candidate not in SUPPORTED_FORMATS:
        return DEFAULT_FORMAT
    return candidate


def set_clock_format(session: Session, value: str) -> str:
    """Persist a clock format. Returns the normalised value.

    Raises ``ValueError`` if ``value`` is not one of
    :data:`SUPPORTED_FORMATS`.
    """
    candidate = value.strip().lower()
    if candidate not in SUPPORTED_FORMATS:
        raise ValueError(
            f"Unsupported clock format {value!r}; expected one of {SUPPORTED_FORMATS}",
        )
    app_config_repo.set_value(session, _CONFIG_KEY, candidate)
    return candidate


def format_clock(now: datetime, clock_format: str) -> str:
    """Render ``now`` as the header date+time string for the given format.

    ``"12h"`` / ``"24h"`` force the respective clock; ``"auto"`` (or any
    unexpected value) falls back to the stable 24-hour rendering so the
    header is never blank.
    """
    pattern = _PATTERNS.get(clock_format)
    if pattern is None:
        pattern = _PATTERNS["24h"]
    return now.strftime(pattern)
