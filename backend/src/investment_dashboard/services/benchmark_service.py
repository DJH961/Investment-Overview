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
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from itertools import pairwise
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.adapters import yfinance_client
from investment_dashboard.domain.currency import lookup_rate_with_forward_fill
from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.domain.returns import Cashflow, xirr
from investment_dashboard.models import Instrument, Transaction
from investment_dashboard.repositories import (
    app_config_repo,
    instruments_repo,
    prices_repo,
    transactions_repo,
)
from investment_dashboard.services import cashflows, fx_service

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
    end = end or (exchange_today() + timedelta(days=1))
    if end <= start:
        return 0
    instrument = _ensure_benchmark_instrument(session, symbol)

    # The benchmark is never held and its dividends are *not* in the ledger, so
    # we fetch dividend/split-adjusted (total-return) closes. That makes the
    # "what if I'd bought the index instead?" comparison reflect the index's
    # real total return (price + reinvested distributions) rather than price
    # alone — otherwise the benchmark is understated by its dividend yield and
    # the portfolio looks like it beats the market when it doesn't.
    def _fetch_adjusted(syms: list[str], s: date, e: date) -> dict:
        return yfinance_client.fetch_closes(syms, s, e, adjusted=True)

    fetch = fetcher or _fetch_adjusted
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


def _price_in(
    currency: str,
    closes: dict[date, Decimal],
    sorted_dates: list[date],
    eur_to_usd: Mapping[date, Decimal],
    d: date,
) -> Decimal | None:
    """Benchmark close on ``d`` in ``currency``; ``None`` when it can't be priced.

    The benchmark trades in USD, so the USD price is the close itself (no FX).
    EUR divides by the EUR->USD rate in force on ``d`` (forward-filled).
    """
    close_usd = _close_as_of(closes, sorted_dates, d)
    if close_usd is None:
        return None
    if currency == "USD":
        return close_usd
    rate = lookup_rate_with_forward_fill(eur_to_usd, d)
    if rate is None or rate == 0:
        return None
    return close_usd / rate


def _funding_txns(session: Session, end: date) -> list[Transaction]:
    return [
        t
        for t in transactions_repo.list_transactions(session, end=end)
        if t.kind in cashflows.EXTERNAL_FLOW_KINDS
    ]


def simulate_benchmark_xirr(
    session: Session,
    *,
    as_of: date | None = None,
    currency: str = "EUR",
    eur_overrides: Mapping[int, Decimal] | None = None,
) -> Decimal | None:
    """XIRR of a buy-and-hold of the benchmark funded by the portfolio's own
    external contribution cashflows, in ``currency`` (``EUR`` or ``USD``).

    Each deposit/transfer-in buys benchmark shares at that day's close;
    each withdrawal/transfer-out sells shares. The terminal mark is the
    resulting share balance valued at the ``as_of`` close. The EUR path uses the
    EUR cashflow stream (actual EUR sent, incl. FX-pool overrides) and EUR
    prices; the USD path uses the USD cashflow stream and the raw USD close, so
    neither return is ever converted into the other currency.

    Returns ``None`` when there is no benchmark history or no external
    contributions to simulate.
    """
    ccy = currency.upper()
    as_of = as_of or exchange_today()
    txns = _funding_txns(session, as_of)
    if not txns:
        return None
    start = min(t.date for t in txns)
    series = get_series(session, start=start, end=as_of)
    if len(series.closes) < 2:
        return None
    sorted_dates = sorted(series.closes)
    eur_to_usd = fx_service.get_rates(session, base="EUR", quote="USD")
    ov = eur_overrides if eur_overrides is not None else cashflows.eur_overrides_for(session)

    shares = Decimal(0)
    flows: list[Cashflow] = []
    for t in sorted(txns, key=lambda r: (r.date, r.id)):
        amount = cashflows.txn_amount(t, ccy, eur_to_usd=eur_to_usd, eur_overrides=ov)
        if amount is None or amount == 0:
            continue
        price = _price_in(ccy, series.closes, sorted_dates, eur_to_usd, t.date)
        if price is None or price == 0:
            continue
        # Contributions are positive cash in (amount > 0 => buy shares, negative
        # flow); withdrawals are negative cash (amount < 0 => sell shares,
        # positive flow). Both reduce to: shares += amount / price, flow = -amount.
        shares += amount / price
        flows.append(Cashflow(date=t.date, amount=-amount))
    terminal_price = _price_in(ccy, series.closes, sorted_dates, eur_to_usd, as_of)
    if terminal_price is None or not flows:
        return None
    return xirr(flows, as_of=as_of, terminal_value=shares * terminal_price)


def simulate_benchmark_value_series(
    session: Session,
    *,
    start: date,
    end: date,
    currency: str = "EUR",
    eur_overrides: Mapping[int, Decimal] | None = None,
) -> dict[date, Decimal]:
    """Daily mark-to-market value of a benchmark holding **funded by the
    portfolio's own contributions**, in ``currency``.

    This is the fair "what if I'd put the same money into the index?" overlay:
    instead of a single lump sum invested at the window's start (which lets a
    dollar-cost-averaged portfolio look like it always beats a flat benchmark
    line over long horizons), every deposit/transfer-in *buys* benchmark shares
    at that day's close and every withdrawal/transfer-out sells them. The
    resulting share balance is valued at each benchmark close in ``[start, end]``
    so the line tracks the same cash schedule the real portfolio experienced.

    Returns a ``{date: value}`` map (one entry per benchmark close in the
    window); the caller forward-fills across non-trading days. Empty when there
    is no benchmark history or no contributions to simulate.
    """
    currency = currency.upper()
    txns = _funding_txns(session, end)
    if not txns:
        return {}
    first_contribution = min(t.date for t in txns)
    # Fetch closes from the first contribution (so shares accumulated before the
    # window are reflected in the opening value) through the window end.
    series = get_series(session, start=min(first_contribution, start), end=end)
    if not series.closes:
        return {}
    sorted_dates = sorted(series.closes)
    eur_to_usd = fx_service.get_rates(session, base="EUR", quote="USD")
    ov = eur_overrides if eur_overrides is not None else cashflows.eur_overrides_for(session)

    # Shares are accounted in the display ``currency`` itself: USD uses the USD
    # cashflows and raw USD closes (a real USD path); EUR uses the EUR cashflows
    # (actual EUR sent) and EUR-converted closes.
    share_steps: list[tuple[date, Decimal]] = []
    shares = Decimal(0)
    for t in sorted(txns, key=lambda r: (r.date, r.id)):
        amount = cashflows.txn_amount(t, currency, eur_to_usd=eur_to_usd, eur_overrides=ov)
        if amount is None or amount == 0:
            continue
        price_at = _price_in(currency, series.closes, sorted_dates, eur_to_usd, t.date)
        if price_at is None or price_at == 0:
            continue
        shares += amount / price_at
        share_steps.append((t.date, shares))

    if not share_steps:
        return {}

    def _shares_through(d: date) -> Decimal:
        held = Decimal(0)
        for step_date, total in share_steps:
            if step_date <= d:
                held = total
            else:
                break
        return held

    out: dict[date, Decimal] = {}
    for d in sorted_dates:
        if d < start or d > end:
            continue
        price = _price_in(currency, series.closes, sorted_dates, eur_to_usd, d)
        if price is None:
            continue
        out[d] = _shares_through(d) * price
    return out
