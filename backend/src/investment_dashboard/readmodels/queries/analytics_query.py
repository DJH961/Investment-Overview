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


def _daily_returns(values: list[Decimal]) -> list[Decimal]:
    out: list[Decimal] = []
    for prev, curr in pairwise(values):
        if prev == 0:
            continue
        out.append((curr - prev) / prev)
    return out


class _BrokerageCash:
    """Uninvested brokerage cash, walked forward day by day, valued in ``currency``.

    The snapshot value counts holdings (money-market sweep funds included) plus
    savings/cash account balances, but NOT cash sitting in a brokerage account
    outside a money-market fund (B-017). A deposit into such an account is an
    external flow on its own date while the value only rose when the cash was
    invested, so the daily return read the buy as a gain, and a deposit before the
    first valued day was dropped entirely: TWR, volatility, beta and the funded
    benchmark went wrong for every window holding such a flow. The Risk curve
    therefore adds that cash back: the running sum of every cash leg
    (``net_native``) of a non-savings account. A fully swept account (Vanguard:
    every cash row has its money-market counter-leg) sums to zero, so nothing is
    counted twice. Each native amount is valued at ``day``'s own rate (one
    instant); a missing rate omits it rather than counting it at par.
    """

    def __init__(
        self,
        session: Session,
        txns: list[Transaction],
        *,
        currency: str,
        eur_to_usd: dict[date, Decimal],
    ) -> None:
        native_of = {
            a.id: a.native_currency.upper()
            for a in accounts_repo.list_accounts(session)
            if a.account_type not in positions_service.CASH_ACCOUNT_TYPES
        }
        deltas: dict[date, dict[str, Decimal]] = {}
        for t in txns:
            native = native_of.get(t.account_id)
            if native is None or not t.net_native:
                continue
            per_day = deltas.setdefault(t.date, {})
            per_day[native] = per_day.get(native, ZERO) + t.net_native
        self._deltas = deltas
        self._dates = sorted(deltas)
        self._idx = 0
        self._running: dict[str, Decimal] = {}
        self._ccy = currency.upper()
        self._rates = eur_to_usd

    def through(self, day: date) -> Decimal:
        """Cash after every transaction dated ``<= day`` (call with rising days)."""
        while self._idx < len(self._dates) and self._dates[self._idx] <= day:
            for native, amount in self._deltas[self._dates[self._idx]].items():
                self._running[native] = self._running.get(native, ZERO) + amount
            self._idx += 1
        total = ZERO
        for native, amount in self._running.items():
            if amount == 0:
                continue
            if native == self._ccy:
                total += amount
                continue
            rate = lookup_rate_with_forward_fill(self._rates, day)
            if not rate:
                continue
            if native == "USD" and self._ccy == "EUR":
                total += amount / rate
            elif native == "EUR" and self._ccy == "USD":
                total += amount * rate
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

    cash = _BrokerageCash(session, txns, currency=currency, eur_to_usd=eur_to_usd)

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
                portfolio_value=value + cash.through(day),
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
    for t in txns:
        if t.instrument_id is None:
            continue
        net = cashflows.txn_amount(t, ccy, eur_to_usd=eur_to_usd)
        if net is None:
            continue
        if t.kind in {TransactionKind.BUY.value, TransactionKind.SELL.value}:
            contribs[t.instrument_id] = contribs.get(t.instrument_id, ZERO) + (-net)
        elif t.kind == TransactionKind.DIVIDEND_CASH.value:
            dividends[t.instrument_id] = dividends.get(t.instrument_id, ZERO) + net

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
            )
        )
    return attribute_portfolio_return(rows)


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
    daily_rets = _daily_returns(index)
    bench_rets = benchmark_series.daily_returns()
    # Align lengths for beta/alpha (last N pairs).
    n = min(len(daily_rets), len(bench_rets))
    portfolio_tail = daily_rets[-n:] if n else []
    bench_tail = bench_rets[-n:] if n else []

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
