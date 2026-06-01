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

from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from itertools import pairwise

from sqlalchemy.orm import Session

from investment_dashboard.domain.attribution import (
    AttributionRow,
    InstrumentReturn,
    attribute_portfolio_return,
)
from investment_dashboard.domain.returns import (
    Cashflow,
    DailyValuation,
    cagr,
    twr,
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
    calmar_ratio,
    excess_kurtosis,
    historical_cvar,
    historical_var,
    skewness,
    ulcer_index,
)
from investment_dashboard.models import TransactionKind
from investment_dashboard.repositories import transactions_repo
from investment_dashboard.services import (
    benchmark_service,
    metrics_service,
    positions_service,
    risk_free_service,
    snapshots_service,
)

ZERO = Decimal(0)


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
    attribution: list[AttributionRow]


def _daily_returns(values: list[Decimal]) -> list[Decimal]:
    out: list[Decimal] = []
    for prev, curr in pairwise(values):
        if prev == 0:
            continue
        out.append((curr - prev) / prev)
    return out


def _build_curve(
    session: Session,
    *,
    start: date,
    end: date,
    currency: str,
    benchmark_closes: dict[date, Decimal],
) -> list[EquityCurvePoint]:
    """One point per calendar day in ``[start, end]`` (inclusive).

    Daily granularity keeps drawdown / vol math honest. The portfolio
    valuation is read-through-cached and loaded in bulk via
    :func:`snapshots_service.series_in_currency`, so historical days are O(1).
    Benchmark closes are forward-filled across weekends and holidays from the
    most recent available print.
    """
    # Cashflows by date for the cumulative-contributions overlay.
    txns = list(transactions_repo.list_transactions(session, end=end))
    contribs_by_date: dict[date, Decimal] = {}
    for t in txns:
        if t.kind not in {
            TransactionKind.DEPOSIT.value,
            TransactionKind.WITHDRAWAL.value,
        }:
            continue
        amt = t.net_eur if t.net_eur is not None else (t.net_native or ZERO)
        contribs_by_date[t.date] = contribs_by_date.get(t.date, ZERO) + amt

    sorted_benchmark = sorted(benchmark_closes)
    bench_idx = 0
    last_bench: Decimal | None = None

    # Bulk-load the daily portfolio valuations once (single snapshot read +
    # single FX-series load) instead of reopening a cache session per day.
    values = dict(snapshots_service.series_in_currency(session, start, end, currency))

    points: list[EquityCurvePoint] = []
    cumulative = ZERO
    day = start
    while day <= end:
        cumulative += contribs_by_date.get(day, ZERO)
        value = values[day]
        while bench_idx < len(sorted_benchmark) and sorted_benchmark[bench_idx] <= day:
            last_bench = benchmark_closes[sorted_benchmark[bench_idx]]
            bench_idx += 1
        points.append(
            EquityCurvePoint(
                date=day,
                portfolio_value=value,
                cumulative_contributions=cumulative,
                benchmark_value=last_bench,
            )
        )
        day += timedelta(days=1)
    return points


def _attribution_for_window(
    session: Session,
    *,
    start: date,
    end: date,
) -> list[AttributionRow]:
    """Per-instrument P&L over ``[start, end]`` using snapshot deltas.

    Approximates start/end instrument values by the EUR mark on each
    boundary date. ``net_contribution`` is the sum of buy/sell cash
    legs in the window so the headline P&L doesn't double-count the
    user's own additions.
    """
    start_positions = {
        p.instrument.id: p for p in positions_service.compute_positions(session, as_of=start)
    }
    end_positions = positions_service.compute_positions(session, as_of=end)
    txns = list(transactions_repo.list_transactions(session, start=start, end=end))

    contribs: dict[int, Decimal] = {}
    dividends: dict[int, Decimal] = {}
    for t in txns:
        if t.instrument_id is None:
            continue
        net_eur = t.net_eur if t.net_eur is not None else (t.net_native or ZERO)
        if t.kind in {TransactionKind.BUY.value, TransactionKind.SELL.value}:
            contribs[t.instrument_id] = contribs.get(t.instrument_id, ZERO) + (-net_eur)
        elif t.kind == TransactionKind.DIVIDEND_CASH.value:
            dividends[t.instrument_id] = dividends.get(t.instrument_id, ZERO) + net_eur

    rows: list[InstrumentReturn] = []
    seen: set[int] = set()
    for ep in end_positions:
        instr_id = ep.instrument.id
        seen.add(instr_id)
        start_val = (
            start_positions[instr_id].current_value_eur if instr_id in start_positions else ZERO
        )
        rows.append(
            InstrumentReturn(
                instrument_id=instr_id,
                symbol=(
                    ep.effective.name
                    if ep.effective and ep.effective.name
                    else ep.instrument.symbol
                ),
                start_value=start_val,
                end_value=ep.current_value_eur,
                net_contribution=contribs.get(instr_id, ZERO),
                dividends_cash=dividends.get(instr_id, ZERO),
            )
        )
    # Instruments held at start but fully exited by end still attribute P&L.
    for instr_id, sp in start_positions.items():
        if instr_id in seen:
            continue
        rows.append(
            InstrumentReturn(
                instrument_id=instr_id,
                symbol=sp.instrument.symbol,
                start_value=sp.current_value_eur,
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
) -> AnalyticsBundle:
    """Compose every analytics figure into a single :class:`AnalyticsBundle`."""
    as_of = as_of or date.today()
    start = as_of - timedelta(days=lookback_days)

    benchmark_series = benchmark_service.get_series(session, start=start, end=as_of)
    curve = _build_curve(
        session,
        start=start,
        end=as_of,
        currency=currency,
        benchmark_closes=benchmark_series.closes,
    )

    portfolio_values = [p.portfolio_value for p in curve]
    daily_rets = _daily_returns(portfolio_values)
    bench_rets = benchmark_series.daily_returns()
    # Align lengths for beta/alpha (last N pairs).
    n = min(len(daily_rets), len(bench_rets))
    portfolio_tail = daily_rets[-n:] if n else []
    bench_tail = bench_rets[-n:] if n else []

    portfolio_metrics = metrics_service.compute_portfolio_metrics(session, as_of=as_of)
    rf_snapshot = risk_free_service.get_risk_free_rate(session)
    rf_rate = rf_snapshot.rate if rf_snapshot.rate is not None else None

    # CAGR/TWR/MDD over the curve window.
    start_value = portfolio_values[0] if portfolio_values else ZERO
    end_value = portfolio_values[-1] if portfolio_values else ZERO
    window_days = (as_of - start).days
    cagr_val = (
        cagr(start_value, end_value, window_days)
        if start_value > 0 and end_value > 0 and window_days > 0
        else None
    )

    twr_input = [DailyValuation(p.date, p.portfolio_value) for p in curve]
    # TWR uses the same deposit/withdrawal cashflows as the headline XIRR.
    twr_cashflows = [
        Cashflow(d, c)
        for d, c in (
            (
                pt.date,
                pt.cumulative_contributions
                - (curve[i - 1].cumulative_contributions if i else ZERO),
            )
            for i, pt in enumerate(curve)
        )
        if c != 0
    ]
    # Convert into TWR's sign convention (negative = contribution INTO portfolio).
    twr_cashflows = [Cashflow(c.date, -c.amount) for c in twr_cashflows]
    twr_val = twr(twr_input, twr_cashflows) if len(twr_input) >= 2 else None

    vol = annualized_volatility(daily_rets)
    sharpe = sharpe_ratio(daily_rets, rf_rate) if rf_rate is not None else None
    sortino = sortino_ratio(daily_rets, rf_rate) if rf_rate is not None else None
    mdd = max_drawdown(portfolio_values)
    calmar = calmar_ratio(daily_rets, portfolio_values)
    ulcer = ulcer_index(portfolio_values)
    var_95 = historical_var(daily_rets)
    cvar_95 = historical_cvar(daily_rets)
    skew_val = skewness(daily_rets)
    kurt_val = excess_kurtosis(daily_rets)
    beta_val = beta(portfolio_tail, bench_tail) if n >= 2 else None
    alpha_val = (
        alpha(portfolio_tail, bench_tail, rf_rate) if n >= 2 and rf_rate is not None else None
    )

    attribution = _attribution_for_window(session, start=start, end=as_of)

    return AnalyticsBundle(
        as_of=as_of,
        start=start,
        currency=currency,
        curve=curve,
        cagr=cagr_val,
        twr=twr_val,
        xirr=portfolio_metrics.xirr,
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
        attribution=attribution,
    )
