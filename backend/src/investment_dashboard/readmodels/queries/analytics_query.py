"""Query helpers for ``/analytics`` — equity curve, risk extras, attribution.

Assembles inputs from snapshots / positions / metrics and feeds the
pure domain math in :mod:`investment_dashboard.domain.risk`,
:mod:`investment_dashboard.domain.risk_extras`,
:mod:`investment_dashboard.domain.returns` and
:mod:`investment_dashboard.domain.attribution`.

Designed to be safe to call on a brand-new database: every field that
can't be computed (insufficient history, no benchmark cache, no
risk-free rate) is returned as ``None`` and the page renders an
"unavailable" tag instead of crashing.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import date, timedelta
from decimal import Decimal
from itertools import pairwise
from typing import TYPE_CHECKING

from sqlalchemy.orm import Session

from investment_dashboard.domain import market_hours
from investment_dashboard.domain.attribution import (
    AttributionRow,
    InstrumentReturn,
    attribute_portfolio_return,
)
from investment_dashboard.domain.currency import lookup_rate_with_forward_fill
from investment_dashboard.domain.kinds import TransactionKind
from investment_dashboard.domain.returns import (
    annualize_return,
    growth_index,
    rebase_funded_series,
)
from investment_dashboard.domain.risk import (
    alpha,
    annualized_volatility,
    beta,
    max_drawdown,
    sharpe_ratio,
    sortino_ratio,
)
from investment_dashboard.domain.risk_extras import (
    DEFAULT_VAR_ALPHA,
    calmar_ratio,
    excess_kurtosis,
    historical_cvar,
    historical_var,
    skewness,
    ulcer_index,
)
from investment_dashboard.repositories import accounts_repo, transactions_repo
from investment_dashboard.services import (
    benchmark_service,
    cashflows,
    fx_service,
    metrics_service,
    positions_service,
    risk_free_service,
    snapshots_service,
)

if TYPE_CHECKING:
    from investment_dashboard.models import Transaction
    from investment_dashboard.services.positions_service import Position

ZERO = Decimal(0)

#: How many trailing days the analytics equity curve may recompute live on the
#: request thread when the snapshot cache is cold. Older uncached days are read
#: straight from the persistent snapshot cache (the background warm fills any
#: gap in for a later render) so a cold cache or a long lookback never blocks the
#: event loop rebuilding thousands of days synchronously — the failure mode that
#: made the Analytics tab appear to hang and never load. Mirrors the Yearly
#: chart's bounded recompute.
CURVE_RECOMPUTE_TAIL_DAYS = 30


@dataclass(frozen=True)
class EquityCurvePoint:
    """One date on the analytics equity curve."""

    date: date
    portfolio_value: Decimal
    cumulative_contributions: Decimal
    benchmark_value: Decimal | None


@dataclass(frozen=True)
class AnalyticsBundle:
    """All the data the ``/analytics`` page needs in one round-trip."""

    as_of: date
    start: date
    currency: str
    curve: list[EquityCurvePoint]
    cagr: Decimal | None
    twr: Decimal | None
    xirr: Decimal | None
    volatility: Decimal | None
    sharpe: Decimal | None
    sortino: Decimal | None
    max_drawdown: Decimal
    calmar: Decimal | None
    ulcer: Decimal | None
    var_95: Decimal | None
    cvar_95: Decimal | None
    skew: Decimal | None
    kurtosis: Decimal | None
    beta: Decimal | None
    alpha: Decimal | None
    risk_free_rate: Decimal | None
    risk_free_symbol: str
    benchmark_symbol: str
    benchmark_is_funded: bool
    attribution: list[AttributionRow]
    metrics: metrics_service.PortfolioMetrics


def _session_returns(
    session: Session,
    curve: list[EquityCurvePoint],
    index: list[Decimal],
    benchmark_closes: dict[date, Decimal],
    *,
    currency: str,
) -> tuple[list[Decimal], list[Decimal], list[Decimal]]:
    """Trading-day returns of the growth index, and the benchmark's on the same days.

    The curve has one point per calendar day, but every risk figure annualises
    with 252 trading days, so weekend and holiday points (a zero move each) are
    dropped: the returns run from one trading day's close to the next (the
    benchmark's close dates; weekdays when there is no benchmark). Beta and alpha
    pair the portfolio and the benchmark return of the SAME day; pairing the last
    N calendar-day returns with the last N trading-day returns matched different
    days, which is why beta read about zero. The benchmark is valued in the
    display currency at each day's own rate (USD: the raw close), like the funded
    line.

    Returns ``(portfolio returns, paired portfolio returns, paired benchmark
    returns)``.
    """
    ccy = currency.upper()
    rates = fx_service.get_rates(session, base="EUR", quote="USD") if ccy == "EUR" else {}

    def bench_value(d: date) -> Decimal | None:
        close = benchmark_closes.get(d)
        if close is None or ccy != "EUR":
            return close
        rate = lookup_rate_with_forward_fill(rates, d)
        return close / rate if rate else None

    has_bench = bool(benchmark_closes)
    trading = [
        (pt.date, idx)
        for pt, idx in zip(curve, index, strict=True)
        if (pt.date in benchmark_closes if has_bench else pt.date.weekday() < 5)
    ]
    rets: list[Decimal] = []
    paired: list[Decimal] = []
    bench: list[Decimal] = []
    for (d0, i0), (d1, i1) in pairwise(trading):
        if i0 == 0:
            continue
        r = i1 / i0 - 1
        rets.append(r)
        b0, b1 = bench_value(d0), bench_value(d1)
        if b0 and b1 is not None:
            paired.append(r)
            bench.append(b1 / b0 - 1)
    return rets, paired, bench


class _LedgerCash:
    """Every account's ledger cash, valued in ``currency``.

    The one rule (7.4 P18, :func:`positions_service.ledger_cash`): savings / cash
    balances and uninvested brokerage cash outside money-market funds, never below
    zero. Since P18 the snapshot value counts this cash itself, so the Risk curve no
    longer adds it on top (B-017: before, a deposit waiting in an unswept account
    was missing from the value and the buy read as a gain). The attribution table's
    "Cash" row reads it, so its rows add up to the same book as the curve. A fully
    swept account (Vanguard: every cash row has its money-market counter-leg on the
    same day) sums to zero.

    Each native amount is valued at ``day``'s own rate (one instant, a valuation,
    never a converted return); a missing rate omits it rather than counting it at
    par, like the snapshot.
    """

    def __init__(
        self,
        session: Session,
        txns: list[Transaction],
        *,
        currency: str,
    ) -> None:
        native_of = {a.id: a.native_currency.upper() for a in accounts_repo.list_accounts(session)}
        end = max((t.date for t in txns), default=None)
        self._cash = positions_service.ledger_cash(session, end=end) if end else None
        self._native_of = native_of
        self._session = session
        self._ccy = currency.upper()
        #: EUR -> quote rate series per currency, loaded once when first needed.
        self._rates: dict[str, dict[date, Decimal]] = {}
        self.account_ids = frozenset(native_of)

    def _rate(self, quote: str, day: date) -> Decimal | None:
        if quote not in self._rates:
            self._rates[quote] = fx_service.get_rates(self._session, base="EUR", quote=quote)
        return lookup_rate_with_forward_fill(self._rates[quote], day)

    def _value(self, native: str, amount: Decimal, day: date) -> Decimal | None:
        """``amount`` of ``native`` in the display currency at ``day``'s rate."""
        if native == self._ccy:
            return amount
        # native -> EUR at the day's EUR->native rate, then EUR -> display.
        eur = amount
        if native != "EUR":
            rate = self._rate(native, day)
            if not rate:
                return None
            eur = amount / rate
        if self._ccy == "EUR":
            return eur
        rate = self._rate(self._ccy, day)
        return eur * rate if rate else None

    def through(self, day: date) -> Decimal:
        """Cash after every transaction dated ``<= day``."""
        if self._cash is None:
            return ZERO
        running: dict[str, Decimal] = {}
        for account_id, native in self._native_of.items():
            amount = self._cash.at(account_id, day)
            if amount:
                running[native] = running.get(native, ZERO) + amount
        total = ZERO
        for native, amount in running.items():
            value = self._value(native, amount, day)
            if value is not None:
                total += value
        return total


def _build_curve(
    session: Session,
    *,
    start: date,
    end: date,
    currency: str,
    benchmark_closes: dict[date, Decimal],
    benchmark_values: dict[date, Decimal] | None = None,
    recompute_tail_days: int | None = CURVE_RECOMPUTE_TAIL_DAYS,
) -> list[EquityCurvePoint]:
    """One point per calendar day in ``[start, end]`` (inclusive).

    Daily granularity keeps drawdown / vol math honest. The portfolio
    valuation is read-through-cached and loaded in bulk via
    :func:`snapshots_service.series_in_currency`, so historical days are O(1).

    ``benchmark_value`` on each point is the **funded** benchmark simulation
    (``benchmark_values``) when supplied — a "same contributions into the index"
    line already expressed in ``currency`` and directly comparable to the
    portfolio value. When it is ``None`` the raw ``benchmark_closes`` are
    forward-filled instead (the web export rebases those itself). Either series
    is forward-filled across weekends and holidays from the most recent print.
    """
    # Cashflows by date for the cumulative-contributions overlay. Counts the
    # same external-flow kinds as the rest of the app (deposits/withdrawals *and*
    # transfer_in/transfer_out) so the contributions line tracks real funding
    # instead of staying flat when money enters via a transfer rather than a
    # plain deposit. See cashflows.EXTERNAL_FLOW_KINDS.
    txns = list(transactions_repo.list_transactions(session, end=end))
    contribs_by_date: dict[date, Decimal] = {}
    use_usd = currency.upper() == "USD"
    eur_to_usd = fx_service.get_rates(session, base="EUR", quote="USD")
    ov = cashflows.eur_overrides_for(session)
    for t in txns:
        if t.kind not in cashflows.EXTERNAL_FLOW_KINDS:
            continue
        amt = cashflows.txn_amount(
            t, "USD" if use_usd else "EUR", eur_to_usd=eur_to_usd, eur_overrides=ov
        )
        if amt is None:
            continue  # leg can't be derived: omitted, never counted as 0
        contribs_by_date[t.date] = contribs_by_date.get(t.date, ZERO) + amt

    # The benchmark overlay source: prefer the funded simulation (already in the
    # display currency, comparable to the portfolio value); otherwise fall back
    # to raw closes for the caller to rebase.
    bench_source = benchmark_values if benchmark_values is not None else benchmark_closes
    sorted_benchmark = sorted(bench_source)
    bench_idx = 0
    last_bench: Decimal | None = None

    # Bulk-load the daily portfolio valuations once (single snapshot read +
    # single FX-series load) instead of reopening a cache session per day. The
    # recompute tail bounds how many uncached days are rebuilt live: on a cold
    # cache the older days are simply omitted from the series (the background
    # warm fills them in for a later render) rather than recomputed
    # synchronously, which is what used to block the event loop and stop the
    # Analytics page from ever finishing its first paint.
    series = snapshots_service.series_in_currency(
        session,
        start,
        end,
        currency,
        recompute_tail_days=recompute_tail_days,
    )
    if len(series) < (end - start).days + 1:
        # Uncached days older than the recompute tail were left out (a cold cache
        # after an import or edit of past trades drops every snapshot from that
        # date on, and only the evening job used to fill them back). Fill them off
        # the request thread; a ``refresh`` event then makes the page re-read.
        snapshots_service.fill_missing_in_background(start, end)

    # Cumulative contributions must account for flows on every calendar day,
    # including days the bounded series skipped, so the overlay stays correct
    # even when the value curve is sparse. Walk the (sorted) contribution dates
    # in tandem with the emitted days.
    sorted_contrib_dates = sorted(contribs_by_date)
    contrib_idx = 0
    cumulative = ZERO

    points: list[EquityCurvePoint] = []
    for day, value in series:
        while contrib_idx < len(sorted_contrib_dates) and sorted_contrib_dates[contrib_idx] <= day:
            cumulative += contribs_by_date[sorted_contrib_dates[contrib_idx]]
            contrib_idx += 1
        while bench_idx < len(sorted_benchmark) and sorted_benchmark[bench_idx] <= day:
            last_bench = bench_source[sorted_benchmark[bench_idx]]
            bench_idx += 1
        points.append(
            EquityCurvePoint(
                date=day,
                portfolio_value=value,
                cumulative_contributions=cumulative,
                benchmark_value=last_bench,
            )
        )
    return points


def build_curve(
    session: Session,
    *,
    start: date,
    end: date,
    currency: str,
    benchmark_closes: dict[date, Decimal],
    benchmark_values: dict[date, Decimal] | None = None,
    recompute_tail_days: int | None = None,
) -> list[EquityCurvePoint]:
    """Public wrapper for analytics curve construction.

    Defaults to a gap-free curve (``recompute_tail_days=None``) so the
    full-history "All" range exported to the web companion honestly extends back
    to inception. The interactive desktop bundle uses the bounded recompute
    instead to keep long-lookback views responsive on a cold cache.
    """
    return _build_curve(
        session,
        start=start,
        end=end,
        currency=currency,
        benchmark_closes=benchmark_closes,
        benchmark_values=benchmark_values,
        recompute_tail_days=recompute_tail_days,
    )


def _attribution_for_window(
    session: Session,
    *,
    start: date,
    end: date,
    currency: str = "EUR",
) -> list[AttributionRow]:
    """Per-instrument P&L over ``[start, end]`` using snapshot deltas, in ``currency``.

    Approximates start/end instrument values by the mark on each boundary date.
    EUR uses the EUR mark; USD uses the native USD value (a EUR-native holding is
    converted at that boundary's own rate, a single-instant conversion).
    ``net_contribution`` and dividends are the buy/sell and cash-dividend legs in
    the window at each transaction's own date's rate, so the headline P&L does not
    double-count the user's own additions. A multi-account instrument is one row
    (its positions are summed). Nothing is converted after the fact.
    """
    ccy = currency.upper()
    eur_to_usd = fx_service.get_rates(session, base="EUR", quote="USD")

    def _marks(positions: list[Position], on: date) -> dict[int, Decimal]:
        out: dict[int, Decimal] = {}
        for p in positions:
            if ccy == "EUR":
                value = p.current_value_eur
            elif p.account.native_currency.upper() == "USD":
                value = p.current_value_native
            else:
                rate = lookup_rate_with_forward_fill(eur_to_usd, on)
                value = p.current_value_eur * rate if rate else ZERO
            out[p.instrument.id] = out.get(p.instrument.id, ZERO) + value
        return out

    start_positions = positions_service.compute_positions(session, as_of=start)
    end_positions = positions_service.compute_positions(session, as_of=end)
    start_marks = _marks(start_positions, start)
    end_marks = _marks(end_positions, end)
    # The short ticker, never the long fund name: the attribution table is a
    # compact list and full names (often 60+ characters) made it unreadable.
    names: dict[int, str] = {}
    for p in end_positions:
        names.setdefault(
            p.instrument.id,
            p.effective.symbol if p.effective and p.effective.symbol else p.instrument.symbol,
        )
    for p in start_positions:
        names.setdefault(p.instrument.id, p.instrument.symbol)
    # Flows over ``(start, end]``: the start marks are taken AFTER the start day's
    # own transactions (``compute_positions(as_of=start)`` includes them), so a
    # start-day buy or sweep leg counted again here was a phantom loss. On "All"
    # (which starts on the first invested day) the first deposit's money-market
    # leg sat in the start value and in the net contribution: the sweep fund
    # showed the whole deposit as a loss.
    txns = list(
        transactions_repo.list_transactions(session, start=start + timedelta(days=1), end=end)
    )

    contribs: dict[int, Decimal] = {}
    dividends: dict[int, Decimal] = {}
    # Dated money into each holding (buy +, sell −, paid-out dividend −) for the
    # row's own Modified Dietz return (P17).
    flows: dict[int, list[tuple[date, Decimal]]] = {}
    for t in txns:
        if t.instrument_id is None:
            continue
        net = cashflows.txn_amount(t, ccy, eur_to_usd=eur_to_usd)
        if net is None:
            continue
        if t.kind in {TransactionKind.BUY.value, TransactionKind.SELL.value}:
            contribs[t.instrument_id] = contribs.get(t.instrument_id, ZERO) + (-net)
            flows.setdefault(t.instrument_id, []).append((t.date, -net))
        elif t.kind == TransactionKind.DIVIDEND_CASH.value:
            dividends[t.instrument_id] = dividends.get(t.instrument_id, ZERO) + net
            flows.setdefault(t.instrument_id, []).append((t.date, -net))

    rows: list[InstrumentReturn] = []
    held_at_end = {p.instrument.id for p in end_positions}
    for instr_id in [*dict.fromkeys(p.instrument.id for p in end_positions)]:
        rows.append(
            InstrumentReturn(
                instrument_id=instr_id,
                symbol=names[instr_id],
                start_value=start_marks.get(instr_id, ZERO),
                end_value=end_marks[instr_id],
                net_contribution=contribs.get(instr_id, ZERO),
                dividends_cash=dividends.get(instr_id, ZERO),
                flows=tuple(flows.get(instr_id, ())),
            )
        )
    # Instruments held at start but fully exited by end still attribute P&L.
    for instr_id in dict.fromkeys(p.instrument.id for p in start_positions):
        if instr_id in held_at_end:
            continue
        rows.append(
            InstrumentReturn(
                instrument_id=instr_id,
                symbol=names[instr_id],
                start_value=start_marks[instr_id],
                end_value=ZERO,
                net_contribution=contribs.get(instr_id, ZERO),
                dividends_cash=dividends.get(instr_id, ZERO),
                flows=tuple(flows.get(instr_id, ())),
            )
        )
    cash_row = _cash_row(session, start=start, end=end, currency=ccy, eur_to_usd=eur_to_usd)
    if cash_row is not None:
        rows.append(cash_row)
    return attribute_portfolio_return(rows, window=(start, end))


#: ``instrument_id`` of the attribution table's "Cash" row (no instrument has id 0).
CASH_ROW_ID = 0
_TRADE_KINDS = frozenset(
    {
        TransactionKind.BUY.value,
        TransactionKind.SELL.value,
        TransactionKind.DIVIDEND_CASH.value,
    }
)


def _cash_row(
    session: Session,
    *,
    start: date,
    end: date,
    currency: str,
    eur_to_usd: dict[date, Decimal],
) -> InstrumentReturn | None:
    """Ledger cash (savings balances and uninvested brokerage cash) as one row.

    The Risk curve counts this cash, so the table must too or its End would not be
    the curve's end value. Start and End are the cash on those days at their own
    rate. Net added is the money moved into cash over ``(start, end]``: deposits
    and withdrawals (each at its own date's rate, as the contributions line), plus
    the cash legs of the trades and paid-out dividends the holding rows count
    (equal and opposite, so they cancel in the total). What is left, P&L, is what
    the cash earned: interest less fees, plus (in a currency other than the
    cash's own) its revaluation. ``None`` when the book never held cash.
    """
    txns = list(transactions_repo.list_transactions(session, end=end))
    cash = _LedgerCash(session, txns, currency=currency)
    start_value = cash.through(start)
    end_value = cash.through(end)
    ov = cashflows.eur_overrides_for(session)
    moved_in = ZERO
    flows: list[tuple[date, Decimal]] = []
    for t in txns:
        if t.date <= start or t.account_id not in cash.account_ids or not t.net_native:
            continue
        if t.kind in cashflows.EXTERNAL_FLOW_KINDS:
            amt = cashflows.txn_amount(t, currency, eur_to_usd=eur_to_usd, eur_overrides=ov)
        elif t.instrument_id is not None and t.kind in _TRADE_KINDS:
            amt = cashflows.txn_amount(t, currency, eur_to_usd=eur_to_usd)
        else:
            continue  # interest, fees, tax: what the cash earned or paid
        if amt is not None:
            moved_in += amt
            flows.append((t.date, amt))
    if start_value == 0 and end_value == 0 and moved_in == 0:
        return None
    return InstrumentReturn(
        instrument_id=CASH_ROW_ID,
        symbol="Cash",
        start_value=start_value,
        end_value=end_value,
        net_contribution=moved_in,
        flows=tuple(flows),
    )


def build_bundle(
    session: Session,
    *,
    currency: str = "EUR",
    lookback_days: int = 365,
    as_of: date | None = None,
    var_alpha: Decimal | None = None,
) -> AnalyticsBundle:
    """Compose every analytics figure into a single :class:`AnalyticsBundle`.

    ``var_alpha`` defaults to the ``risk.var_alpha`` setting (0.05 = 95 % VaR).
    """
    # Default the as-of (and therefore the equity curve's last day stamp) to the
    # New-York exchange date, not the publisher's local `date.today()`: a daily
    # close must be filed under its NYSE trading day so the exported curve sits on
    # the same ET grid the web companion buckets by (`legacy/v5:docs/time_alignment_plan.md`).
    as_of = as_of or market_hours.exchange_today()
    start = as_of - timedelta(days=lookback_days)

    benchmark_series = benchmark_service.get_series(session, start=start, end=as_of)
    # Fund the benchmark with the portfolio's own contribution schedule so the
    # overlay is an apples-to-apples "same money into the index" line rather than
    # a lump sum invested at the window start (which made long horizons look like
    # an automatic win for a dollar-cost-averaged portfolio).
    benchmark_values = benchmark_service.simulate_benchmark_value_series(
        session, start=start, end=as_of, currency=currency
    )
    benchmark_is_funded = bool(benchmark_values)
    curve = _build_curve(
        session,
        start=start,
        end=as_of,
        currency=currency,
        benchmark_closes=benchmark_series.closes,
        benchmark_values=benchmark_values or None,
    )

    # A window that starts before the first investment (5Y on a 2-year history, or
    # All) begins on the first day with money invested, so no figure divides by an
    # empty start value and a 5Y window equals All. An all-zero curve is left as is.
    lead = next((i for i, p in enumerate(curve) if p.portfolio_value > 0), 0)
    if lead:
        curve = curve[lead:]
        start = curve[0].date
        benchmark_series = benchmark_service.get_series(session, start=start, end=as_of)

    new_money = [
        pt.cumulative_contributions - curve[i - 1].cumulative_contributions if i else ZERO
        for i, pt in enumerate(curve)
    ]
    if benchmark_is_funded and curve:
        # Rebase the funded benchmark so it starts the window at the portfolio's own
        # value (common base) instead of carrying all pre-window index gains.
        rebased = rebase_funded_series(
            curve[0].portfolio_value, [p.benchmark_value for p in curve], new_money
        )
        curve = [
            replace(p, benchmark_value=b if p.benchmark_value is not None else None)
            for p, b in zip(curve, rebased, strict=True)
        ]

    portfolio_values = [p.portfolio_value for p in curve]
    # Every risk figure runs on the flow-adjusted growth index, not on raw values:
    # a deposit is not a gain and a withdrawal is not a drawdown. Over a long window
    # (All, 5Y) the raw values are mostly new money, which made CAGR, volatility,
    # VaR and beta meaningless there.
    index = growth_index(portfolio_values, new_money)
    daily_rets, portfolio_tail, bench_tail = _session_returns(
        session, curve, index, benchmark_series.closes, currency=currency
    )
    n = len(portfolio_tail)

    portfolio_metrics = metrics_service.compute_portfolio_metrics(session, as_of=as_of)
    rf_snapshot = risk_free_service.get_risk_free_rate(session)
    rf_rate = rf_snapshot.rate if rf_snapshot.rate is not None else None

    # CAGR = the growth index annualised over the days actually invested in the
    # window (from the first day with a value), so it is the annualised TWR and a
    # window longer than the ledger is not diluted by empty days. Spans under a
    # year are not annualised (GIPS): a 4 % month would otherwise read as 60 %/yr.
    first_invested = next((p.date for p in curve if p.portfolio_value > 0), None)
    invested_days = (curve[-1].date - first_invested).days if first_invested else 0
    cagr_val = (
        annualize_return(index[-1] - Decimal(1), max(invested_days, 365))
        if index and invested_days > 0
        else None
    )

    # TWR is the chained growth index over the invested part of the window (the
    # same chain :func:`twr` builds), so All and any window longer than the ledger
    # report it instead of failing on an empty start value.
    twr_val = index[-1] - Decimal(1) if first_invested and len(index) >= 2 else None

    vol = annualized_volatility(daily_rets)
    sharpe = sharpe_ratio(daily_rets, rf_rate) if rf_rate is not None else None
    sortino = sortino_ratio(daily_rets, rf_rate) if rf_rate is not None else None
    mdd = max_drawdown(index)
    calmar = calmar_ratio(daily_rets, index)
    ulcer = ulcer_index(index)
    if var_alpha is None:
        from investment_dashboard.services import settings_service  # noqa: PLC0415

        var_alpha = settings_service.get_or("risk.var_alpha", DEFAULT_VAR_ALPHA, session)
    var_95 = historical_var(daily_rets, var_alpha)
    cvar_95 = historical_cvar(daily_rets, var_alpha)
    skew_val = skewness(daily_rets)
    kurt_val = excess_kurtosis(daily_rets)
    beta_val = beta(portfolio_tail, bench_tail) if n >= 2 else None
    alpha_val = (
        alpha(portfolio_tail, bench_tail, rf_rate) if n >= 2 and rf_rate is not None else None
    )

    attribution = _attribution_for_window(session, start=start, end=as_of, currency=currency)

    return AnalyticsBundle(
        as_of=as_of,
        start=start,
        currency=currency,
        curve=curve,
        cagr=cagr_val,
        twr=twr_val,
        # Each currency's XIRR is built from its own cashflow stream; never
        # report the EUR figure as the USD one.
        xirr=portfolio_metrics.xirr_usd if currency.upper() == "USD" else portfolio_metrics.xirr,
        volatility=vol,
        sharpe=sharpe,
        sortino=sortino,
        max_drawdown=mdd,
        calmar=calmar,
        ulcer=ulcer,
        var_95=var_95,
        cvar_95=cvar_95,
        skew=skew_val,
        kurtosis=kurt_val,
        beta=beta_val,
        alpha=alpha_val,
        risk_free_rate=rf_rate,
        risk_free_symbol=rf_snapshot.symbol,
        benchmark_symbol=benchmark_series.symbol,
        benchmark_is_funded=benchmark_is_funded,
        attribution=attribution,
        metrics=portfolio_metrics,
    )
