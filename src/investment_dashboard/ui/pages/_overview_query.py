"""Query helpers for ``/overview`` — KPI quartet + position rows + treemap data."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.domain.currency import (
    dual_currency_amounts,
    lookup_rate_with_forward_fill,
)
from investment_dashboard.domain.money_market import is_money_market
from investment_dashboard.domain.returns import Cashflow, total_growth_pct_compounded, xirr
from investment_dashboard.models import TransactionKind
from investment_dashboard.repositories import transactions_repo
from investment_dashboard.services import fx_service, prices_service, snapshots_service
from investment_dashboard.services.metrics_service import (
    PortfolioMetrics,
    compute_portfolio_metrics,
)
from investment_dashboard.services.positions_service import (
    Position,
    compute_positions,
)
from investment_dashboard.ui.money_format import currency_symbol, fmt_shares

ZERO = Decimal(0)
_CENT = Decimal("0.01")

#: Time-range options for the Overview value-over-time chart. ``None`` means
#: "all time" (start at the first transaction). Labels match the user's
#: requested Day / Month / Year / All selections.
VALUE_RANGES: tuple[tuple[str, int | None], ...] = (
    ("Day", 1),
    ("Month", 30),
    ("Year", 365),
    ("All", None),
)
_DEFAULT_RANGE = "Year"


@dataclass(frozen=True)
class ValueSeriesPoint:
    """One point on the Overview portfolio-value line graph."""

    date: date
    value: Decimal


def resolve_range_days(label: str | None) -> tuple[str, int | None]:
    """Map a range query-param to ``(canonical_label, lookback_days|None)``."""
    if label is not None:
        wanted = label.strip().capitalize()
        for name, days in VALUE_RANGES:
            if name == wanted:
                return name, days
    for name, days in VALUE_RANGES:
        if name == _DEFAULT_RANGE:
            return name, days
    return VALUE_RANGES[0]


def _earliest_transaction_date(session: Session) -> date | None:
    txns = transactions_repo.list_transactions(session)
    return txns[0].date if txns else None


def build_value_series(
    session: Session,
    *,
    currency: str,
    range_label: str | None = None,
    as_of: date | None = None,
) -> list[ValueSeriesPoint]:
    """Daily portfolio-value series for the selected range, in ``currency``.

    Uses the read-through snapshot cache, so historical days are O(1) and —
    now that historical valuations price with the as-of close (v2.8 item 1) —
    the curve reflects how the portfolio actually moved rather than today's
    prices projected backwards. Returns ``[]`` when there is no history.
    """
    end = as_of or date.today()
    _, days = resolve_range_days(range_label)
    if days is None:
        start = _earliest_transaction_date(session)
        if start is None:
            return []
    else:
        start = end - timedelta(days=days)
    start = min(start, end)

    return [
        ValueSeriesPoint(date=day, value=value)
        for day, value in snapshots_service.series_in_currency(session, start, end, currency)
    ]


@dataclass(frozen=True)
class TreemapDatum:
    """One slice of the allocation treemap."""

    label: str
    value_eur: Decimal


@dataclass(frozen=True)
class InstrumentMetrics:
    """Per-instrument return figures mirroring the spreadsheet's ``Lots`` block.

    All ratios are fractions (``0.12`` = +12 %). The legacy ``xirr`` /
    ``total_growth_pct`` / ``ytd_growth_pct`` / ``capital_gain_native`` fields
    are retained for the JSON read-model / API. The v2.8.2 ``*_eur`` / ``*_usd``
    fields are the ones the Overview table renders: every money figure is the
    real per-currency value (cost basis converted at each buy's **trade-date**
    FX, current value at today's FX) rounded to the cent, and every return is
    computed independently per currency. ``None`` means "not computable" (no
    cost basis / no prior price) so the renderer shows an em dash.
    """

    instrument_id: int
    # Legacy native-currency figures (kept for readmodels / API back-compat).
    xirr: Decimal | None
    total_growth_pct: Decimal | None
    ytd_growth_pct: Decimal | None
    capital_gain_native: Decimal
    expense_ratio: Decimal | None
    # v2.8.2 per-currency figures (drive the Overview table).
    cost_basis_eur: Decimal = ZERO
    cost_basis_usd: Decimal = ZERO
    current_value_eur: Decimal = ZERO
    current_value_usd: Decimal | None = ZERO
    capital_gain_eur: Decimal = ZERO
    capital_gain_usd: Decimal | None = ZERO
    total_growth_eur: Decimal | None = None
    total_growth_usd: Decimal | None = None
    xirr_eur: Decimal | None = None
    xirr_usd: Decimal | None = None
    ytd_growth_eur: Decimal | None = None
    ytd_growth_usd: Decimal | None = None
    daily_growth_eur: Decimal | None = None
    daily_growth_usd: Decimal | None = None


def get_metrics(session: Session, *, as_of: date | None = None) -> PortfolioMetrics:
    return compute_portfolio_metrics(session, as_of=as_of)


def get_positions(session: Session, *, as_of: date | None = None) -> list[Position]:
    return compute_positions(session, as_of=as_of)


def _convert_native(
    value_native: Decimal,
    native_currency: str,
    on: date,
    eur_to_usd: dict[date, Decimal],
    fallback_rate: Decimal | None,
) -> tuple[Decimal, Decimal]:
    """Convert a positive native-currency value to ``(eur, usd)`` at trade-date FX.

    Thin wrapper over :func:`dual_currency_amounts` that coerces the missing
    legs to :data:`ZERO` so cost-basis accumulation never trips over a sparse
    FX history (the boot refresh backfills rates to the earliest trade date).
    """
    eur, usd = dual_currency_amounts(
        native_currency=native_currency,
        net_native=value_native,
        net_eur=None,
        on=on,
        eur_to_usd=eur_to_usd,
        fallback_rate=fallback_rate,
    )
    return (eur or ZERO), (usd or ZERO)


def compute_instrument_metrics(  # noqa: PLR0915
    session: Session,
    positions: list[Position],
    *,
    as_of: date | None = None,
) -> dict[int, InstrumentMetrics]:
    """Per-instrument returns in EUR **and** USD, keyed by instrument id.

    Every money figure is computed per currency: the cost basis (and cash
    dividends) are converted at each transaction's own trade-date FX rate,
    while the current value uses today's FX — so the capital gain is "what I
    could cash out today vs what it cost me back then". XIRR, total growth,
    YTD growth and single-day (daily) growth are each computed twice, once per
    wallet, mirroring the portfolio-level KPIs.
    """
    as_of = as_of or date.today()
    txns = list(transactions_repo.list_transactions(session, end=as_of))
    eur_to_usd = fx_service.get_rates(session, base="EUR", quote="USD")
    today_rate = lookup_rate_with_forward_fill(eur_to_usd, as_of)

    year_start = date(as_of.year, 1, 1)
    eur_flows: dict[int, list[Cashflow]] = {}
    usd_flows: dict[int, list[Cashflow]] = {}
    cost_eur: dict[int, Decimal] = {}
    cost_usd: dict[int, Decimal] = {}
    # Running share count per instrument, needed to release a proportional
    # slice of the cost basis on partial sales (average-cost method).
    shares_held: dict[int, Decimal] = {}
    div_eur: dict[int, Decimal] = {}
    div_usd: dict[int, Decimal] = {}
    ytd_invested_eur: dict[int, Decimal] = {}
    ytd_invested_usd: dict[int, Decimal] = {}
    # Cash-dividend legs that were immediately reinvested must not be counted
    # as income (already captured as cost basis + shares via the reinvest
    # leg), otherwise growth double-counts them.
    reinvest_keys: set[tuple[int | None, date]] = {
        (t.instrument_id, t.date) for t in txns if t.kind == TransactionKind.DIVIDEND_REINVEST.value
    }
    for t in txns:
        iid = t.instrument_id
        if iid is None:
            continue
        native = t.account.native_currency if t.account else "EUR"
        eur, usd = dual_currency_amounts(
            native_currency=native,
            net_native=t.net_native,
            net_eur=t.net_eur,
            net_usd=t.net_usd,
            on=t.date,
            eur_to_usd=eur_to_usd,
            fallback_rate=today_rate,
        )
        eur = eur or ZERO
        usd = usd or ZERO
        qty = t.quantity or ZERO
        kind = t.kind
        if kind == TransactionKind.BUY.value:
            # Buy legs are negative (cash out) ⇒ cost basis is the negation.
            cost_eur[iid] = cost_eur.get(iid, ZERO) - eur
            cost_usd[iid] = cost_usd.get(iid, ZERO) - usd
            shares_held[iid] = shares_held.get(iid, ZERO) + qty
        elif kind == TransactionKind.SELL.value:
            # Average-cost partial-sale handling: release the sold shares'
            # proportional slice of the cost basis in each currency.
            shares_before = shares_held.get(iid, ZERO)
            if shares_before > ZERO:
                sold = min(-qty, shares_before)
                frac = sold / shares_before
                cost_eur[iid] = cost_eur.get(iid, ZERO) * (1 - frac)
                cost_usd[iid] = cost_usd.get(iid, ZERO) * (1 - frac)
            shares_held[iid] = shares_before + qty
        elif kind == TransactionKind.DIVIDEND_REINVEST.value and t.price_native is not None:
            val_native = qty * t.price_native
            e, u = _convert_native(val_native, native, t.date, eur_to_usd, today_rate)
            cost_eur[iid] = cost_eur.get(iid, ZERO) + e
            cost_usd[iid] = cost_usd.get(iid, ZERO) + u
            shares_held[iid] = shares_held.get(iid, ZERO) + qty
        elif kind == TransactionKind.SPLIT.value:
            shares_held[iid] = shares_held.get(iid, ZERO) + qty
        elif kind == TransactionKind.DIVIDEND_CASH.value:
            if (iid, t.date) not in reinvest_keys:
                div_eur[iid] = div_eur.get(iid, ZERO) + eur
                div_usd[iid] = div_usd.get(iid, ZERO) + usd
        if kind in {
            TransactionKind.BUY.value,
            TransactionKind.SELL.value,
            TransactionKind.DIVIDEND_CASH.value,
        }:
            eur_flows.setdefault(iid, []).append(Cashflow(date=t.date, amount=eur))
            usd_flows.setdefault(iid, []).append(Cashflow(date=t.date, amount=usd))
        if t.date >= year_start and kind in {
            TransactionKind.BUY.value,
            TransactionKind.SELL.value,
        }:
            ytd_invested_eur[iid] = ytd_invested_eur.get(iid, ZERO) - eur
            ytd_invested_usd[iid] = ytd_invested_usd.get(iid, ZERO) - usd

    # Start-of-year value per instrument in EUR (best-effort, for YTD growth);
    # USD parallel uses the FX rate on the first of the year.
    fx_year_start = lookup_rate_with_forward_fill(eur_to_usd, year_start) or today_rate
    start_value_eur: dict[int, Decimal] = {
        p.instrument.id: p.current_value_eur for p in compute_positions(session, as_of=year_start)
    }

    out: dict[int, InstrumentMetrics] = {}
    for p in positions:
        iid = p.instrument.id
        native = p.account.native_currency
        c_eur = _round_cent(cost_eur.get(iid, ZERO))
        c_usd = _round_cent(cost_usd.get(iid, ZERO))
        cv_eur = p.current_value_eur
        # When the EUR→USD spot is unavailable we degrade the USD figures to
        # ``None`` (blank) rather than relabelling the EUR amount as USD —
        # otherwise XIRR(USD) / growth(USD) would be computed against a
        # terminal value that is euros pretending to be dollars.
        cv_usd = cv_eur * today_rate if today_rate not in (None, 0) else None
        d_eur = div_eur.get(iid, ZERO)
        d_usd = div_usd.get(iid, ZERO)
        gain_eur = _round_cent(cv_eur + d_eur - c_eur)
        gain_usd = _round_cent(cv_usd + d_usd - c_usd) if cv_usd is not None else None
        growth_eur = (gain_eur / c_eur) if c_eur != ZERO else None
        growth_usd = (gain_usd / c_usd) if (gain_usd is not None and c_usd != ZERO) else None
        xirr_eur = xirr(eur_flows.get(iid, []), as_of=as_of, terminal_value=cv_eur)
        xirr_usd = (
            xirr(usd_flows.get(iid, []), as_of=as_of, terminal_value=cv_usd)
            if cv_usd is not None
            else None
        )
        sv_eur = start_value_eur.get(iid, ZERO)
        sv_usd = sv_eur * fx_year_start if fx_year_start not in (None, 0) else None
        ytd_eur = _instrument_ytd_growth(
            start_value=sv_eur,
            current_value=cv_eur,
            net_invested=ytd_invested_eur.get(iid, ZERO),
        )
        ytd_usd = (
            _instrument_ytd_growth(
                start_value=sv_usd,
                current_value=cv_usd,
                net_invested=ytd_invested_usd.get(iid, ZERO),
            )
            if (sv_usd is not None and cv_usd is not None)
            else None
        )
        eff_name = p.effective.name if p.effective is not None else p.instrument.name
        eff_class = p.effective.asset_class if p.effective is not None else p.instrument.asset_class
        is_mm = is_money_market(p.instrument.symbol, asset_class=eff_class, name=eff_name)
        daily_eur, daily_usd = _instrument_daily_growth(
            session,
            instrument_id=iid,
            shares=p.shares,
            native_currency=native,
            as_of=as_of,
            eur_to_usd=eur_to_usd,
            today_rate=today_rate,
            is_money_market=is_mm,
        )
        ter = p.effective.expense_ratio if p.effective is not None else p.instrument.expense_ratio
        # Legacy native-currency figures (readmodels / API back-compat).
        cost_native = p.cost_basis_native
        gain_native = p.current_value_native + p.cumulative_dividends_cash_native - cost_native
        out[iid] = InstrumentMetrics(
            instrument_id=iid,
            xirr=xirr_eur,
            total_growth_pct=((gain_native / cost_native) if cost_native != ZERO else None),
            ytd_growth_pct=ytd_eur,
            capital_gain_native=gain_native,
            expense_ratio=ter,
            cost_basis_eur=c_eur,
            cost_basis_usd=c_usd,
            current_value_eur=_round_cent(cv_eur),
            current_value_usd=_round_cent(cv_usd) if cv_usd is not None else None,
            capital_gain_eur=gain_eur,
            capital_gain_usd=gain_usd,
            total_growth_eur=growth_eur,
            total_growth_usd=growth_usd,
            xirr_eur=xirr_eur,
            xirr_usd=xirr_usd,
            ytd_growth_eur=ytd_eur,
            ytd_growth_usd=ytd_usd,
            daily_growth_eur=daily_eur,
            daily_growth_usd=daily_usd,
        )
    return out


def _round_cent(value: Decimal) -> Decimal:
    """Round a money amount to the nearest cent (half-up)."""
    return value.quantize(_CENT, rounding=ROUND_HALF_UP)


def _instrument_daily_growth(
    session: Session,
    *,
    instrument_id: int,
    shares: Decimal,
    native_currency: str,
    as_of: date,
    eur_to_usd: dict[date, Decimal],
    today_rate: Decimal | None,
    is_money_market: bool = False,
) -> tuple[Decimal | None, Decimal | None]:
    """Single-day growth for one instrument, in EUR and USD.

    Values the holding on the two most recent print dates (forward-filled
    closes) and converts each with the FX rate of *that* day, so the USD and
    EUR figures differ only by the (small) intraday FX move — exactly the
    per-currency daily growth the KPI strip shows, but per instrument.

    Money-market / settlement funds hold a constant $1.00 NAV with no price
    feed, so they have no print dates to diff. Rather than render an em dash
    (which looked inconsistent next to their other, computed figures) their
    single-day growth is a flat ``0`` — the par value did not move.
    """
    if is_money_market:
        return ZERO, ZERO
    dates = prices_service.recent_price_dates(session, [instrument_id], on_or_before=as_of, limit=2)
    if len(dates) < 2:
        return None, None
    last_date, prev_date = dates[0], dates[1]
    close_last = prices_service.close_as_of(session, instrument_id, last_date)
    close_prev = prices_service.close_as_of(session, instrument_id, prev_date)
    if close_last is None or close_prev is None:
        return None, None
    e_last, u_last = _convert_native(
        shares * close_last, native_currency, last_date, eur_to_usd, today_rate
    )
    e_prev, u_prev = _convert_native(
        shares * close_prev, native_currency, prev_date, eur_to_usd, today_rate
    )
    growth_eur = (e_last - e_prev) / e_prev if e_prev > ZERO else None
    growth_usd = (u_last - u_prev) / u_prev if u_prev > ZERO else None
    return growth_eur, growth_usd


def _instrument_ytd_growth(
    *,
    start_value: Decimal,
    current_value: Decimal,
    net_invested: Decimal,
) -> Decimal | None:
    """Simple YTD growth net of this year's purchases, in native currency.

    ``(V_now - V_jan1 - net_invested_ytd) / V_jan1``. ``None`` when there
    was no start-of-year mark to grow from.
    """
    if start_value <= ZERO:
        return None
    return (current_value - start_value - net_invested) / start_value


@dataclass(frozen=True)
class MarketVerdict:
    """ "Did I beat the market?" comparison for the overview KPI strip.

    Mirrors the spreadsheet's ``Total!Z23`` verdict. Both sides are computed
    with the **same** method over the **same** horizon: an XIRR over the
    portfolio's external contribution cashflows, expressed as the compounded
    total growth ``(1 + XIRR) ^ years − 1`` it implies over the time invested.
    ``portfolio_return`` is the portfolio's own XIRR-implied growth; the
    ``benchmark_return`` is the growth those identical contributions would have
    earned in a buy-and-hold of the benchmark index. ``beating`` compares the
    two annualised XIRRs (equivalently, the two compounded returns over the same
    horizon) and is ``None`` when either side can't be computed (no benchmark
    history / no transactions).
    """

    benchmark_symbol: str
    portfolio_return: Decimal | None
    benchmark_return: Decimal | None
    beating: bool | None


def compute_market_verdict(
    session: Session,
    *,
    portfolio_xirr: Decimal | None,
    years: Decimal | None,
    as_of: date | None = None,
) -> MarketVerdict:
    """Compare the portfolio XIRR to the same contributions invested in the
    benchmark index, on an apples-to-apples XIRR basis.

    ``portfolio_xirr`` / ``years`` come from the portfolio metrics (EUR basis).
    The benchmark XIRR is simulated by routing the portfolio's external
    contribution cashflows into the index (see
    :func:`benchmark_service.simulate_benchmark_xirr`). Both XIRRs are converted
    to the compounded total-growth family the overview headlines so the verdict
    and the headline never quote two different "growth" numbers.
    """
    # Local import keeps the (heavier) benchmark/adapters import lazy and
    # avoids any chance of an import cycle at module load.
    from investment_dashboard.services import benchmark_service  # noqa: PLC0415

    as_of = as_of or date.today()
    symbol = benchmark_service.get_symbol(session)

    benchmark_xirr = benchmark_service.simulate_benchmark_xirr(session, as_of=as_of)

    portfolio_return: Decimal | None = None
    benchmark_return: Decimal | None = None
    if years is not None and years > ZERO:
        portfolio_return = total_growth_pct_compounded(portfolio_xirr, years)
        benchmark_return = total_growth_pct_compounded(benchmark_xirr, years)

    beating: bool | None = None
    if portfolio_xirr is not None and benchmark_xirr is not None:
        beating = portfolio_xirr >= benchmark_xirr
    return MarketVerdict(symbol, portfolio_return, benchmark_return, beating)


def _today_dual(
    value_native: Decimal, native: str, fx_rate: Decimal | None
) -> tuple[Decimal | None, Decimal | None]:
    """Convert a native amount to ``(eur, usd)`` using today's spot ``fx_rate``.

    Only used as a degraded fallback in :func:`position_rows` when no enriched
    per-instrument metrics are supplied; the live page always passes metrics
    (trade-date FX). ``fx_rate`` is EUR→USD.
    """
    if native == "EUR":
        eur = value_native
        usd = value_native * fx_rate if fx_rate not in (None, 0) else None
    elif native == "USD":
        usd = value_native
        eur = value_native / fx_rate if fx_rate not in (None, 0) else None
    else:  # pragma: no cover - defensive: unsupported native currency
        eur = usd = None
    return eur, usd


def position_rows(
    positions: list[Position],
    *,
    display_currency: str = "EUR",
    fx_rate: Decimal | None = None,
    metrics: dict[int, InstrumentMetrics] | None = None,
    price_anomaly_ids: set[int] | None = None,
) -> list[dict[str, Any]]:
    """Shape positions for the AG-Grid table on the overview page.

    Every money / return value is carried per currency as a numeric companion
    (``*_eur_num`` / ``*_usd_num`` for money, ``*_eur_signed`` / ``*_usd_signed``
    for ratios) so the page can render **one currency at a time** (the display
    toggle) while still sorting by the underlying value. When ``metrics`` (from
    :func:`compute_instrument_metrics`) is supplied the figures are the real
    per-currency numbers — cost basis at trade-date FX, capital gain vs today's
    FX, plus per-currency XIRR, total growth, YTD growth and single-day growth.
    Without metrics it falls back to a today's-spot conversion of the native
    cost basis / value, with the return columns left blank.

    ``price_anomaly_ids`` are instrument ids whose cached price history holds a
    non-positive close (a corrupt feed value); their rows carry
    ``price_data_warning`` so the page can flag that the instrument's historical
    valuations are unreliable.
    """
    rows: list[dict[str, Any]] = []
    metrics = metrics or {}
    anomalies = price_anomaly_ids or set()
    for p in positions:
        native = p.account.native_currency
        im = metrics.get(p.instrument.id)
        if im is not None:
            cb_eur, cb_usd = im.cost_basis_eur, im.cost_basis_usd
            v_eur, v_usd = im.current_value_eur, im.current_value_usd
            g_eur, g_usd = im.capital_gain_eur, im.capital_gain_usd
            tg_eur, tg_usd = im.total_growth_eur, im.total_growth_usd
            xirr_eur, xirr_usd = im.xirr_eur, im.xirr_usd
            ytd_eur, ytd_usd = im.ytd_growth_eur, im.ytd_growth_usd
            daily_eur, daily_usd = im.daily_growth_eur, im.daily_growth_usd
            ter = im.expense_ratio
        else:
            cb_eur, cb_usd = _today_dual(p.cost_basis_native, native, fx_rate)
            v_eur = p.current_value_eur
            v_usd = p.current_value_eur * fx_rate if fx_rate not in (None, 0) else None
            g_eur = (v_eur - cb_eur) if (v_eur is not None and cb_eur is not None) else None
            g_usd = (v_usd - cb_usd) if (v_usd is not None and cb_usd is not None) else None
            tg_eur = (g_eur / cb_eur) if (g_eur is not None and cb_eur) else None
            tg_usd = (g_usd / cb_usd) if (g_usd is not None and cb_usd) else None
            xirr_eur = xirr_usd = ytd_eur = ytd_usd = daily_eur = daily_usd = None
            ter = None
        eff = p.effective
        rows.append(
            {
                "symbol": p.instrument.symbol,
                "value_warning": p.value_warning,
                "price_data_warning": p.instrument.id in anomalies,
                "name": (eff.name if eff is not None else p.instrument.name) or "",
                "category": p.category or "",
                "shares": fmt_shares(p.shares),
                "avg_price": (
                    f"{currency_symbol(native)}{(p.cost_basis_native / p.shares):,.2f}"
                    if p.shares
                    else ""
                ),
                "current_price": (
                    f"{currency_symbol(native)}{p.current_price_native:,.2f}"
                    if p.current_price_native is not None
                    else ""
                ),
                "expense_ratio": _fmt_pct(ter),
                # Per-currency numeric companions (one currency rendered at a
                # time via the display toggle; both kept so the toggle is
                # instant and each column sorts by its own value).
                "cost_basis_eur_num": _num(cb_eur),
                "cost_basis_usd_num": _num(cb_usd),
                "value_eur_num": _num(v_eur),
                "value_usd_num": _num(v_usd),
                "capital_gain_eur_num": _num(g_eur),
                "capital_gain_usd_num": _num(g_usd),
                "total_growth_eur_signed": _signed(tg_eur),
                "total_growth_usd_signed": _signed(tg_usd),
                "xirr_eur_signed": _signed(xirr_eur),
                "xirr_usd_signed": _signed(xirr_usd),
                "ytd_eur_signed": _signed(ytd_eur),
                "ytd_usd_signed": _signed(ytd_usd),
                "daily_eur_signed": _signed(daily_eur),
                "daily_usd_signed": _signed(daily_usd),
                "display_currency": display_currency,
            }
        )
    return rows


def _fmt_pct(value: Decimal | None) -> str:
    if value is None:
        return "—"
    return f"{value * Decimal(100):,.2f} %"


def _signed(value: Decimal | None) -> float:
    """Raw float for AG-Grid ``cellClassRules`` sign colouring (0 when None)."""
    return float(value) if value is not None else 0.0


def _num(value: Decimal | None) -> float | None:
    """Raw float for a sortable numeric AG-Grid column (``None`` stays empty)."""
    return float(value) if value is not None else None


def allocation_treemap(positions: list[Position]) -> list[TreemapDatum]:
    """Aggregate positions by user-tier ``category`` (fallback effective ``asset_class``)."""
    bucket: dict[str, Decimal] = {}
    for p in positions:
        eff = p.effective
        fallback_class = eff.asset_class if eff is not None else p.instrument.asset_class
        key = p.category or fallback_class or "Uncategorized"
        bucket[key] = bucket.get(key, ZERO) + p.current_value_eur
    items = [TreemapDatum(label=k, value_eur=v) for k, v in bucket.items() if v > ZERO]
    items.sort(key=lambda d: d.value_eur, reverse=True)
    return items
