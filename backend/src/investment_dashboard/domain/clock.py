"""The one place the backend reads "now" for market-time-sensitive logic.

Read models and the market-hours helpers call :func:`now` instead of
``datetime.now(UTC)`` so tests can pin the instant (see the ``market_clock``
fixture in ``tests/conftest.py``). Behavior is unchanged: it returns the current
aware UTC instant.
"""

from __future__ import annotations

from datetime import UTC, datetime


def now() -> datetime:
    """The current instant as an aware UTC datetime."""
    return datetime.now(UTC)
