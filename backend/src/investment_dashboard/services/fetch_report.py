"""Process-local record of *which symbols* each data provider last fetched.

The Settings → Connectivity panel already shows each provider's last status and
a recent-activity log, but not *what* it actually asked for. This module keeps a
tiny, in-memory note of the symbols (tickers for yfinance, currency pairs for
Frankfurter) pulled on the most recent refresh, so Settings can answer "what did
you just fetch?" at a glance.

Like :mod:`refresh_status` and :mod:`provider_status`, the store is process-local
and thread-safe — restarts wipe it and the next refresh repopulates it.
"""

from __future__ import annotations

import threading
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime


@dataclass(frozen=True)
class FetchReport:
    """The symbols a provider fetched on its most recent call."""

    provider: str
    symbols: tuple[str, ...]
    at: datetime


_lock = threading.Lock()
_last: dict[str, FetchReport] = {}


def record(provider: str, symbols: Iterable[str], *, at: datetime | None = None) -> None:
    """Note the symbols ``provider`` fetched (deduplicated, order-preserving).

    A fetch that queried nothing is ignored so a no-op refresh does not erase a
    previous, more informative report.
    """
    deduped = tuple(dict.fromkeys(s for s in symbols if s))
    if not deduped:
        return
    report = FetchReport(provider=provider, symbols=deduped, at=at or datetime.now(UTC))
    with _lock:
        _last[provider] = report


def get(provider: str) -> FetchReport | None:
    """Return the last fetch report for ``provider`` (or ``None``)."""
    with _lock:
        return _last.get(provider)


def all_latest() -> dict[str, FetchReport]:
    """Return a snapshot of every provider's last fetch report."""
    with _lock:
        return dict(_last)


def clear() -> None:
    """Drop all recorded reports (used by tests)."""
    with _lock:
        _last.clear()
