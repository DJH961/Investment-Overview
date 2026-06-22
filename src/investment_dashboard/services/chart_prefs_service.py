"""Chart-preference service — remembers each graph's time-range selection.

The dashboard's charts (Overview value-over-time, Analytics lookback, Projection
granularity) each have a small range/granularity toggle. Without persistence the
selection resets to a hard-coded default on every reload or page visit, which is
annoying when you habitually look at, say, the *All* range or a *5Y* lookback.

This service stores the last picked value per chart in the same ``app_config``
key/value table used for the display-currency and theme preferences, so the
choice sticks across reloads and across app restarts. Values are validated
against the caller's allowed set, so a stale or hand-edited key degrades to the
supplied default rather than breaking the page.
"""

from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy.orm import Session

from investment_dashboard.repositories import app_config_repo

#: Namespace so chart prefs are easy to spot in ``app_config`` and never collide
#: with other single-user settings.
_PREFIX = "chart_pref."


def get_pref(
    session: Session,
    key: str,
    *,
    default: str,
    allowed: Iterable[str] | None = None,
) -> str:
    """Return the stored selection for ``key`` (or ``default``).

    When ``allowed`` is given, a stored value outside that set falls back to
    ``default`` — keeps the UI honest if the option list ever changes.
    """
    raw = app_config_repo.get(session, _PREFIX + key)
    if raw is None:
        return default
    value = raw.strip()
    if allowed is not None and value not in set(allowed):
        return default
    return value


def set_pref(session: Session, key: str, value: str) -> None:
    """Persist ``value`` as the selection for ``key``."""
    app_config_repo.set_value(session, _PREFIX + key, value.strip())
