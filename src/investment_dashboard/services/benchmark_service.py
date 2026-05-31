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
from investment_dashboard.domain.currency import lookup_rate_with_forward_fill
from investment_dashboard.domain.returns import Cashflow, xirr
from investment_dashboard.models import Instrument, TransactionKind
from investment_dashboard.repositories import (
    app_config_repo,
    instruments_repo,
    prices_repo,
    transactions_repo,
)
from investment_dashboard.services import fx_service

log = logging.getLogger(__name__)

DEFAULT_SYMBOL = "VT"
KEY_SYMBOL = "benchmark_symbol"

# External-cash kinds that fund (or drain) the simulated benchmark holding,
# mirroring metrics_service's portfolio-XIRR contribution convention so the two
# returns are computed over the same flows.
_CONTRIBUTION_KINDS = {
    TransactionKind.DEPOSIT.value,
    TransactionKind.TRANSFER_IN.value,
}
_WITHDRAWAL_KINDS = {
    TransactionKind.WITHDRAWAL.value,
    TransactionKind.TRANSFER_OUT.value,
}


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
    # Closes live in the cache tier; in split-DB mode the ledger session cannot
    # see ``price_history`` so the write has to go through the cache engine.
    from investment_dashboard.db import cache_write_session  # noqa: PLC0415

    with cache_write_session(session) as cache:
        return prices_repo.upsert_closes(cache, instrument.id, closes, source="benchmark")


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
    # ``price_history`` is a cache-tier table; read it through the cache engine
    # so split-DB installs see the full series instead of the empty ledger copy.
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    with cache_read_session(session) as cache:
        all_closes = prices_repo.get_closes_for_instrument(cache, instrument.id)
    closes = {d: c for d, c in all_closes.items() if start <= d <= end}
    return BenchmarkSeries(symbol=symbol, closes=closes)


def _txn_eur_amount(t: Any) -> Decimal:
    """EUR cash leg of a transaction (cached ``net_eur`` else ``net_native``)."""
    if t.net_eur is not None:
        return t.net_eur
    if t.net_native is not None:
        return t.net_native
    return Decimal(0)


def _close_as_of(closes: dict[date, Decimal], sorted_dates: list[date], d: date) -> Decimal | None:
    """Forward-filled benchmark close on ``d`` (earliest close if ``d`` precedes
    the series), or ``None`` when the series is empty."""
    if not sorted_dates:
        return None
    prev: date | None = None
    for cd in sorted_dates:
        if cd <= d:
            prev = cd
        else:
            break
    chosen = prev if prev is not None else sorted_dates[0]
    return closes[chosen]


def simulate_benchmark_xirr(session: Session, *, as_of: date | None = None) -> Decimal | None:
    """XIRR of a buy-and-hold of the benchmark funded by the portfolio's own
    external contribution cashflows (EUR basis).

    Each deposit/transfer-in buys benchmark shares at that day's close
    (converted to EUR via the EUR→USD history); each withdrawal/transfer-out
    sells shares. The terminal mark is the resulting share balance valued at the
    ``as_of`` close. This makes "vs market" an apples-to-apples XIRR comparison —
    "what return would these same contributions have earned in the index?".

    Returns ``None`` when there is no benchmark history or no external
    contributions to simulate.
    """
    as_of = as_of or date.today()
    txns = [
        t
        for t in transactions_repo.list_transactions(session, end=as_of)
        if t.kind in _CONTRIBUTION_KINDS or t.kind in _WITHDRAWAL_KINDS
    ]
    if not txns:
        return None
    start = min(t.date for t in txns)
    series = get_series(session, start=start, end=as_of)
    if len(series.closes) < 2:
        return None
    sorted_dates = sorted(series.closes)
    eur_to_usd = fx_service.get_rates(session, base="EUR", quote="USD")

    def _price_eur(d: date) -> Decimal | None:
        close_usd = _close_as_of(series.closes, sorted_dates, d)
        if close_usd is None:
            return None
        rate = lookup_rate_with_forward_fill(eur_to_usd, d)
        if rate is None or rate == 0:
            return None
        return close_usd / rate

    shares = Decimal(0)
    flows: list[Cashflow] = []
    for t in sorted(txns, key=lambda r: (r.date, r.id)):
        amount = _txn_eur_amount(t)
        if amount == 0:
            continue
        price = _price_eur(t.date)
        if price is None or price == 0:
            continue
        # Contributions are positive cash in (amount > 0 ⇒ buy shares, negative
        # flow); withdrawals are negative cash (amount < 0 ⇒ sell shares,
        # positive flow). Both reduce to: shares += amount / price, flow = -amount.
        shares += amount / price
        flows.append(Cashflow(date=t.date, amount=-amount))
    terminal_price = _price_eur(as_of)
    if terminal_price is None or not flows:
        return None
    terminal_value = shares * terminal_price
    return xirr(flows, as_of=as_of, terminal_value=terminal_value)
