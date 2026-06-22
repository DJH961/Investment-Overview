"""Analytics preferences — persists the lookback window the user picked.

The Analytics page lets the user pick a lookback (1M … 5Y). That choice
used to live only in the URL query string, so navigating away and back
(or following a plain ``/analytics`` link) snapped the toggle back to the
1Y default. We persist the last picked window so the page reopens on the
time frame the user was last looking at.

Persistence is via the ``app_config`` table, key ``analytics_lookback_days``.
The stored value is an integer number of days, clamped to the same bounds
the page enforces (one week … ten years). The default is 365 (1Y) to
preserve the previous behaviour.
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from investment_dashboard.repositories import app_config_repo

DEFAULT_LOOKBACK_DAYS = 365
MIN_LOOKBACK_DAYS = 7
MAX_LOOKBACK_DAYS = 365 * 10

_CONFIG_KEY = "analytics_lookback_days"


def clamp_lookback_days(value: int) -> int:
    """Clamp a lookback to the supported ``[MIN, MAX]`` day range."""
    return max(MIN_LOOKBACK_DAYS, min(value, MAX_LOOKBACK_DAYS))


def get_lookback_days(session: Session) -> int:
    """Return the persisted lookback in days, defaulting to 365 (1Y)."""
    raw = app_config_repo.get(session, _CONFIG_KEY)
    if raw is None:
        return DEFAULT_LOOKBACK_DAYS
    try:
        value = int(raw.strip())
    except (ValueError, AttributeError):
        return DEFAULT_LOOKBACK_DAYS
    return clamp_lookback_days(value)


def set_lookback_days(session: Session, days: int) -> int:
    """Persist a new lookback window. Returns the normalised (clamped) value."""
    normalised = clamp_lookback_days(int(days))
    app_config_repo.set_value(session, _CONFIG_KEY, str(normalised))
    return normalised
