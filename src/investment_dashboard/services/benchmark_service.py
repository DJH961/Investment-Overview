"""Benchmark service — manages the comparison index (default VT).

The Analytics page overlays a benchmark equity curve on the user's
portfolio so beta / alpha / "did I beat the market?" can be answered
visually. The benchmark is stored as a regular
:class:`~investment_dashboard.models.Instrument` row that the user
never holds — no transactions reference it, so it never appears in
positions, treemaps, or the import flow. Its closes live in
``price_history`` like any other instrument, refreshed via the usual
:func:`investment_dashboard.adapters.yfinance_client.fetch_closes`
pipeline.

The active benchmark symbol is persisted in ``app_config`` so the
user can pick a different index (e.g. ``URTH`` or ``IWDA.L``) without
losing history of the previous one — switching just creates / fetches
the new instrument; the old rows stay around for free.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from itertools import pairwise
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.adapters import yfinance_client
from investment_dashboard.models import Instrument
from investment_dashboard.repositories import app_config_repo, instruments_repo, prices_repo

log = logging.getLogger(__name__)

DEFAULT_SYMBOL = "VT"
KEY_SYMBOL = "benchmark_symbol"


@dataclass(frozen=True)
class BenchmarkSeries:
    """Daily-close series for a benchmark over a window."""

    symbol: str
    closes: dict[date, Decimal]

    def daily_returns(self) -> list[Decimal]:
        """Simple ``(p_t / p_{t-1}) − 1`` on the sorted close series."""
        if len(self.closes) < 2:
            return []
        sorted_dates = sorted(self.closes)
        out: list[Decimal] = []
        for prev, curr in pairwise(sorted_dates):
            p0 = self.closes[prev]
            p1 = self.closes[curr]
            if p0 == 0:
                continue
            out.append((p1 - p0) / p0)
        return out


def get_symbol(session: Session) -> str:
    raw = app_config_repo.get(session, KEY_SYMBOL)
    if raw is None or not raw.strip():
        return DEFAULT_SYMBOL
    return raw.strip().upper()


def set_symbol(session: Session, symbol: str) -> str:
    cleaned = symbol.strip().upper()
    if not cleaned:
        raise ValueError("symbol must be non-empty")
    app_config_repo.set_value(session, KEY_SYMBOL, cleaned)
    return cleaned


def _ensure_benchmark_instrument(session: Session, symbol: str) -> Instrument:
    """Return the ``Instrument`` row for ``symbol`` (creating a stub if needed).

    Benchmarks are *not* enriched via yfinance ``Ticker.info`` here —
    that's a 1.5s round-trip we don't need for an overlay line. The
    enrichment service can be applied later via the normal flow if
    the symbol ever shows up in a transaction.
    """
    return instruments_repo.get_or_create(
        session,
        symbol=symbol,
        asset_class="etf",
        native_currency="USD",
    )


def refresh_history(
    session: Session,
    *,
    start: date,
    end: date | None = None,
    fetcher: Any = None,
) -> int:
    """Fetch and cache benchmark closes over ``[start, end)``.

    Returns the number of close rows touched. Failures are logged and
    swallowed so the analytics page degrades to "no benchmark line"
    rather than crashing the request.
    """
    symbol = get_symbol(session)
    end = end or (date.today() + timedelta(days=1))
    if end <= start:
        return 0
    instrument = _ensure_benchmark_instrument(session, symbol)
    fetch = fetcher or yfinance_client.fetch_closes
    try:
        closes = fetch([symbol], start, end).get(symbol, {})
    except Exception as exc:  # pragma: no cover - network churn
        log.warning("benchmark fetch for %s failed: %s", symbol, exc)
        return 0
    if not closes:
        return 0
    return prices_repo.upsert_closes(session, instrument.id, closes, source="benchmark")


def get_series(
    session: Session,
    *,
    start: date,
    end: date,
) -> BenchmarkSeries:
    """Return the cached benchmark closes filtered to ``[start, end]``."""
    symbol = get_symbol(session)
    instrument = instruments_repo.get_by_symbol(session, symbol)
    if instrument is None:
        return BenchmarkSeries(symbol=symbol, closes={})
    all_closes = prices_repo.get_closes_for_instrument(session, instrument.id)
    closes = {d: c for d, c in all_closes.items() if start <= d <= end}
    return BenchmarkSeries(symbol=symbol, closes=closes)
