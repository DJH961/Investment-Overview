"""Metrics service — compose cashflows from the ledger and call domain math.

The domain layer is pure; this layer assembles its inputs from the DB.
Returned metrics use :class:`decimal.Decimal` throughout.

v2.5 added EUR + USD parallel figures across the board. Total Growth
(``(1 + XIRR) ^ years − 1``) is the canonical headline metric — see
:func:`investment_dashboard.domain.returns.total_growth_pct_compounded`.
Both ``*_eur`` and ``*_usd`` are computed from the same ledger walked
twice with the appropriate per-trade-date FX, so the displayed pair
reflects the real EUR-wallet vs USD-wallet experience rather than a
single-currency series rescaled by today's spot.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from sqlalchemy.orm import Session

from investment_dashboard.domain import dividends
from investment_dashboard.domain.currency import (
    dual_currency_amounts,
    lookup_rate_with_forward_fill,
)
from investment_dashboard.domain.instruments import is_money_market_effective
from investment_dashboard.domain.kinds import TransactionKind
from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.domain.returns import (
    Cashflow,
    capital_gain,
    total_growth_pct,
    total_growth_pct_compounded,
    xirr,
    years_between,
)
from investment_dashboard.repositories import (
    accounts_repo,
    instrument_overrides_repo,
    transactions_repo,
)
from investment_dashboard.services import (
    cashflows,
    fx_service,
    intraday_snapshots_service,
    positions_service,
    snapshots_service,
)
from investment_dashboard.services.instrument_enrichment_service import effective_instrument

if TYPE_CHECKING:
    from investment_dashboard.domain.late_data import DaySplit
    from investment_dashboard.models import Transaction

ZERO = Decimal(0)


def _one_year_before(as_of: date) -> date:
    """The date exactly one year before ``as_of`` (start of a trailing window).

    Falls back to 1 March for a 29 February valuation date, which has no direct
    counterpart in a non-leap prior year.
    """
    try:
        return as_of.replace(year=as_of.year - 1)
    except ValueError:  # 29 Feb → no 29 Feb a year earlier
        return date(as_of.year - 1, 3, 1)


# Kind sets live in ``services.cashflows`` (the canonical cash-leg module).
_CONTRIBUTION_KINDS = cashflows.CONTRIBUTION_KINDS
_WITHDRAWAL_KINDS = cashflows.WITHDRAWAL_KINDS
EXTERNAL_FLOW_KINDS = cashflows.EXTERNAL_FLOW_KINDS
_RETAINED_CASH_ACCOUNT_TYPES = {"savings", "cash"}
_DISTRIBUTION_KINDS = cashflows.DISTRIBUTION_KINDS


@dataclass(frozen=True)
class PortfolioMetrics:
    """High-level KPIs for ``/overview`` — dual-currency since v2.5.

    Every monetary field has an ``*_eur`` and ``*_usd`` counterpart;
    every return field has an ``*_eur`` / ``*_usd`` pair. The two are
    computed from the same ledger walked twice with per-trade-date FX,
    so they reflect the real EUR-wallet / USD-wallet experience.

    ``total_growth_pct`` (legacy "simple" growth = `(V−C)/C`) is kept
    for backwards compatibility but the UI now headlines
    ``total_growth_compounded_*`` ((1 + XIRR) ^ years − 1).
    """

    as_of: date
    #: First date with any contribution / withdrawal cashflow, used as the
    #: time origin for ``total_growth_compounded_*``. ``None`` for an
    #: empty ledger.
    first_cashflow_date: date | None
    # EUR-denominated figures (legacy + canonical storage)
    total_value_eur: Decimal
    total_contributions_eur: Decimal
    total_dividends_cash_eur: Decimal
    capital_gain_eur: Decimal
    total_growth_pct: Decimal | None
    xirr: Decimal | None
    ytd_xirr: Decimal | None
    ytd_growth_pct: Decimal | None
    #: (1 + XIRR_eur) ^ years − 1 — headline metric on every page.
    total_growth_compounded_eur: Decimal | None
    # USD parallels (v2.5). ``total_value_usd`` / ``capital_gain_usd`` are
    # ``None`` when the EUR→USD spot is unavailable (no FX history at all) —
    # we report "unavailable" rather than relabelling the EUR figure as USD.
    total_value_usd: Decimal | None
    total_contributions_usd: Decimal
    total_dividends_cash_usd: Decimal
    capital_gain_usd: Decimal | None
    xirr_usd: Decimal | None
    ytd_xirr_usd: Decimal | None
    ytd_growth_pct_usd: Decimal | None
    total_growth_compounded_usd: Decimal | None
    #: Month-to-date portfolio growth (mirrors the spreadsheet's MTD block
    #: on ``Deposits``/``Total``). ``None`` when the start-of-month value
    #: can't be established (brand-new portfolio / no price history).
    mtd_growth_pct: Decimal | None = None
    #: USD parallel of ``mtd_growth_pct`` (start-of-month value + this
    #: month's external flows valued at per-trade-date FX). ``None`` under
    #: the same conditions as the EUR figure.
    mtd_growth_pct_usd: Decimal | None = None
    #: Value-weighted average expense ratio across held positions
    #: (spreadsheet ``Total!E15`` = ``SUMPRODUCT(expense, weight)``).
    #: ``None`` when there are no valued positions.
    weighted_expense_ratio: Decimal | None = None
    #: Estimated annual fund-fee cost in EUR at the current marks
    #: (spreadsheet ``Total!E17`` = ``Σ price·expense·shares``).
    annual_expense_cost_eur: Decimal = Decimal(0)
    #: Single-day portfolio growth on the most recent *completed* trading
    #: day — i.e. the latest date any held instrument repriced (skips
    #: weekends/holidays; tolerates the mutual-fund NAV lag vs ETFs).
    #: ``None`` until there are at least two priced dates.
    daily_growth_pct: Decimal | None = None
    daily_growth_pct_usd: Decimal | None = None
    #: Signed single-day *money* move (the change in total value between the last
    #: two priced days) per currency. Lets the Overview "Today" square show the
    #: headline daily gain/loss as an absolute figure in the display currency.
    #: ``None`` until there are two priced days (and ``*_usd`` also needs FX).
    daily_growth_money_eur: Decimal | None = None
    daily_growth_money_usd: Decimal | None = None
    #: Trailing-twelve-month cash-dividend income per currency (every
    #: distribution dated in the 12 months up to the valuation date, reinvested
    #: or paid out). Surfaced next to the per-year dividend yield. A rolling
    #: window (not calendar year-to-date) so it stays a full year of income even
    #: in early January. ``0`` when none received in the trailing year.
    dividends_ttm_eur: Decimal = Decimal(0)
    dividends_ttm_usd: Decimal = Decimal(0)
    #: Trailing dividend yield = cash dividends received ÷ current closing
    #: balance (spreadsheet ``Total`` block's ``Dividends / Closing Balance``).
    #: ``None`` when the portfolio has no value yet.
    dividend_yield_pct: Decimal | None = None
    #: Per-year dividend *yield* = trailing-twelve-month cash dividends ÷ current
    #: closing balance. Unlike ``dividend_yield_pct`` (a lifetime cumulative
    #: return) this is a per-year rate, so the UI can show an actual "yield"
    #: next to the lifetime "return". A rolling 12-month window rather than
    #: calendar year-to-date, so it is a meaningful annual rate even on 2 Jan.
    #: ``None`` when the portfolio has no value.
    dividend_yield_ttm_pct: Decimal | None = None
    #: The date ``daily_growth_pct`` refers to (the "last daily growth day"),
    #: so the UI can label *when* the move is from. ``None`` when unavailable.
    daily_growth_as_of: date | None = None
    #: The prior priced day the daily move is measured *against*. Lets the UI
    #: caption the FX change between the two marks. ``None`` when unavailable.
    daily_growth_prev_as_of: date | None = None
    #: EUR→USD mark (USD per 1 EUR) on ``daily_growth_as_of`` — live-overlaid
    #: for today by :func:`fx_service.get_rates`, so the caption can show the
    #: live rate when the market is open or Frankfurter is behind. ``None`` when
    #: there is no FX history.
    daily_growth_fx_eur_usd: Decimal | None = None
    #: EUR→USD mark on ``daily_growth_prev_as_of`` (the comparison rate).
    daily_growth_fx_eur_usd_prev: Decimal | None = None


def build_instrument_cashflows(
    session: Session,
    *,
    as_of: date | None = None,
) -> tuple[dict[int, list[Cashflow]], dict[int, list[Cashflow]]]:
    """Per-instrument EUR and USD cashflow streams for holding-level XIRR."""
    as_of = as_of or exchange_today()
    txns = list(transactions_repo.list_transactions(session, end=as_of))
    eur_to_usd = fx_service.get_rates(session, base="EUR", quote="USD")
    today_rate = lookup_rate_with_forward_fill(eur_to_usd, as_of)
    eur_flows: dict[int, list[Cashflow]] = {}
    usd_flows: dict[int, list[Cashflow]] = {}
    for t in txns:
        iid = t.instrument_id
        if iid is None:
            continue
        kind = t.kind
        if kind not in {
            TransactionKind.BUY.value,
            TransactionKind.SELL.value,
            TransactionKind.DIVIDEND_CASH.value,
        }:
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
        # A leg that cannot be derived is omitted, never faked as 0.
        if eur is not None:
            eur_flows.setdefault(iid, []).append(Cashflow(date=t.date, amount=eur))
        if usd is not None:
            usd_flows.setdefault(iid, []).append(Cashflow(date=t.date, amount=usd))
    return eur_flows, usd_flows


def build_retained_cash_account_ids(
    session: Session,
    transactions: Sequence[Transaction],
) -> set[int]:
    """Accounts whose distributions are already retained in terminal value."""
    retained = {
        account.id
        for account in accounts_repo.list_accounts(session)
        if account.account_type in _RETAINED_CASH_ACCOUNT_TYPES
    }
    overrides = instrument_overrides_repo.get_override_map(
        session, {t.instrument.id for t in transactions if t.instrument is not None}
    )
    retained |= {
        t.account_id
        for t in transactions
        if t.account_id is not None
        and t.instrument is not None
        and is_money_market_effective(
            t.instrument, effective_instrument(t.instrument, overrides.get(t.instrument.id))
        )
    }
    return retained


# Canonical stream builders (re-exported for existing callers).
build_portfolio_cashflows = cashflows.build_portfolio_cashflows
build_portfolio_cashflows_dual = cashflows.build_portfolio_cashflows_dual


class _ValuationCache:
    """In-request memo of ``compute_positions`` / ``total_portfolio_value`` (B1).

    ``compute_portfolio_metrics`` values the portfolio on the same handful of
    dates repeatedly (today, year-start, month-start, the two daily-growth print
    dates) and recomputes the *same* ``as_of`` roll-up several times (terminal
    value, daily-growth holdings, expense figures). Each roll-up re-walks the
    whole ledger with nested price/FX lookups, so memoising by date collapses
    those duplicate passes without changing any number.
    """

    def __init__(self, session: Session) -> None:
        self._session = session
        self._positions: dict[date, list[positions_service.Position]] = {}
        self._values: dict[date, Decimal] = {}

    def positions(self, on: date) -> list[positions_service.Position]:
        cached = self._positions.get(on)
        if cached is None:
            cached = positions_service.compute_positions(self._session, as_of=on)
            self._positions[on] = cached
        return cached

    def total_value(self, on: date) -> Decimal:
        cached = self._values.get(on)
        if cached is None:
            cached = positions_service.total_portfolio_value(
                self._session, as_of=on, positions=self.positions(on)
            )
            self._values[on] = cached
        return cached


def compute_portfolio_metrics(  # noqa: PLR0915
    session: Session,
    *,
    as_of: date | None = None,
    eur_overrides: Mapping[int, Decimal] | None = None,
    now: datetime | None = None,
) -> PortfolioMetrics:
    as_of = as_of or exchange_today()
    txns = list(transactions_repo.list_transactions(session, end=as_of))
    # FX-pool effective EUR cost of USD deposits (empty without conversions).
    ov = eur_overrides if eur_overrides is not None else cashflows.eur_overrides_for(session)

    # Memoise per-date portfolio roll-ups for this request (B1): the terminal
    # value, daily-growth holdings and expense figures all want ``as_of`` and
    # several helpers re-value year-start / month-start dates.
    cache = _ValuationCache(session)

    eur_to_usd: dict[date, Decimal] = fx_service.get_rates(session, base="EUR", quote="USD")

    contributions_eur = cashflows.sum_amounts(
        txns, _CONTRIBUTION_KINDS, "EUR", eur_to_usd=eur_to_usd, eur_overrides=ov
    )
    withdrawals_eur = cashflows.sum_amounts(
        txns, _WITHDRAWAL_KINDS, "EUR", eur_to_usd=eur_to_usd, eur_overrides=ov
    )
    net_contributions_eur = contributions_eur + withdrawals_eur  # withdrawals are negative

    # Dividend *income* (spec §6.1): every distribution counted once — the
    # reinvested value plus un-reinvested cash — matching the spreadsheet's
    # Dividends column (incl. VMFXX settlement-fund interest, which has no
    # separate cash leg). Realized cash is the subset that actually left the
    # portfolio; reinvested distributions are already in ``total_value`` so
    # only realized cash may be added back to reconstruct capital gain.
    reinvest_keys = dividends.reinvest_keys(list(txns))

    def _dividends(
        *, include_reinvested: bool, since: date | None = None
    ) -> tuple[Decimal, Decimal]:
        eur_total = ZERO
        usd_total = ZERO
        for t in txns:
            if since is not None and t.date < since:
                continue
            div_eur, div_usd = dividends.income_dual(
                t, reinvest_keys, eur_to_usd=eur_to_usd, include_reinvested=include_reinvested
            )
            if div_eur is not None:
                eur_total += div_eur
            if div_usd is not None:
                usd_total += div_usd
        return eur_total, usd_total

    dividends_income_eur, dividends_income_usd = _dividends(include_reinvested=True)
    dividends_realized_eur, dividends_realized_usd = _dividends(include_reinvested=False)
    # Trailing-twelve-month dividend income (every distribution dated in the 12
    # months up to ``as_of``), shown alongside the per-year yield on the
    # Overview KPI footnote. A rolling window rather than calendar year-to-date,
    # so it stays a full year of income even in early January (a YTD figure
    # would read ~0 on 2 Jan and make the "yield" meaningless).
    dividends_ttm_eur, dividends_ttm_usd = _dividends(
        include_reinvested=True, since=_one_year_before(as_of)
    )

    contributions_usd = cashflows.sum_amounts(
        txns, _CONTRIBUTION_KINDS, "USD", eur_to_usd=eur_to_usd
    )
    withdrawals_usd = cashflows.sum_amounts(txns, _WITHDRAWAL_KINDS, "USD", eur_to_usd=eur_to_usd)
    net_contributions_usd = contributions_usd + withdrawals_usd

    total_value_eur = cache.total_value(as_of)
    # Today's spot for the terminal mark-to-market USD value. We use spot
    # for the *terminal* alone because positions_service already values
    # everything in EUR using today's FX; per-trade-date USD is applied to
    # the historical cashflow stream below.
    fx_today = lookup_rate_with_forward_fill(eur_to_usd, as_of) or ZERO
    # Degrade the terminal USD mark to ``None`` (blank) when there is no
    # EUR→USD spot, rather than relabelling the EUR value as USD.
    # The USD *wallet* cashflows are still real (per-trade-date legs); only
    # the terminal mark-to-market is unknown.
    total_value_usd: Decimal | None = total_value_eur * fx_today if fx_today != 0 else None

    # Distributions swept into an in-portfolio money-market / settlement fund
    # (VMFXX, SPAXX, …) are already captured by the terminal mark-to-market of
    # that fund's holding, so counting them again as XIRR outflows would
    # double-count the cash and inflate the return. Treat any account that
    # holds such a fund as cash-retaining.
    retained_cash_account_ids = build_retained_cash_account_ids(session, txns)

    cap_gain_eur = capital_gain(
        contributions=net_contributions_eur,
        current_value=total_value_eur,
        cumulative_dividends_cash=dividends_realized_eur,
    )
    cap_gain_usd = (
        capital_gain(
            contributions=net_contributions_usd,
            current_value=total_value_usd,
            cumulative_dividends_cash=dividends_realized_usd,
        )
        if total_value_usd is not None
        else None
    )
    growth_pct_legacy = total_growth_pct(
        net_contributions_eur, total_value_eur + dividends_realized_eur
    )

    cashflows_eur, cashflows_usd = build_portfolio_cashflows_dual(
        txns,
        retained_cash_account_ids=retained_cash_account_ids,
        eur_to_usd=eur_to_usd,
        eur_overrides=ov,
    )
    portfolio_xirr_eur = xirr(cashflows_eur, as_of=as_of, terminal_value=total_value_eur)
    portfolio_xirr_usd = (
        xirr(cashflows_usd, as_of=as_of, terminal_value=total_value_usd)
        if total_value_usd is not None
        else None
    )

    # Time origin for compounded Total Growth: the earliest contribution
    # / withdrawal date in the ledger. We deliberately ignore dividend-
    # cash-only rows since they don't establish "how long you've been
    # invested" — they're returns *on* invested money.
    first_cashflow_date: date | None = None
    for t in sorted(txns, key=lambda r: r.date):
        if t.kind in _CONTRIBUTION_KINDS or t.kind in _WITHDRAWAL_KINDS:
            first_cashflow_date = t.date
            break

    years_lifetime = (
        years_between(first_cashflow_date, as_of) if first_cashflow_date else Decimal(0)
    )
    total_growth_eur = total_growth_pct_compounded(portfolio_xirr_eur, years_lifetime)
    total_growth_usd = total_growth_pct_compounded(portfolio_xirr_usd, years_lifetime)

    # YTD: value at start of year + cashflows from Jan 1 onward.
    year_start = date(as_of.year, 1, 1)
    ytd_txns = [t for t in txns if t.date >= year_start]
    ytd_cashflows_eur, ytd_cashflows_usd = build_portfolio_cashflows_dual(
        ytd_txns,
        retained_cash_account_ids=retained_cash_account_ids,
        eur_to_usd=eur_to_usd,
        eur_overrides=ov,
    )
    # Best-effort Jan-1 valuation: requires price + FX history for that
    # date. For brand-new portfolios with no Jan-1 history we fall back
    # to the earliest available snapshot in the YTD window (and
    # ultimately to ``Decimal(0)``), so the page renders instead of
    # raising. This mirrors spec §6.4's "ytd_start_value best-effort"
    # note (v1.2 closure of the v1.0 caveat).
    ytd_start_value_eur = cache.total_value(year_start)
    if ytd_start_value_eur <= ZERO:
        ytd_start_value_eur = _best_effort_ytd_start_value(session, year_start, as_of, cache=cache)
    fx_year_start = lookup_rate_with_forward_fill(eur_to_usd, year_start) or fx_today
    # ``None`` (not EUR-as-USD) when there is no EUR→USD spot to convert with.
    ytd_start_value_usd: Decimal | None = (
        ytd_start_value_eur * fx_year_start if fx_year_start != 0 else None
    )
    # Treat the start-of-year value as a synthetic "contribution" (negative).
    ytd_cashflows_eur.insert(0, Cashflow(date=year_start, amount=-ytd_start_value_eur))
    ytd_xirr_eur = xirr(ytd_cashflows_eur, as_of=as_of, terminal_value=total_value_eur)
    if total_value_usd is not None and ytd_start_value_usd is not None:
        ytd_cashflows_usd.insert(0, Cashflow(date=year_start, amount=-ytd_start_value_usd))
        ytd_xirr_usd = xirr(ytd_cashflows_usd, as_of=as_of, terminal_value=total_value_usd)
    else:
        ytd_xirr_usd = None

    ytd_contributions_eur = cashflows.sum_amounts(
        ytd_txns, _CONTRIBUTION_KINDS, "EUR", eur_to_usd=eur_to_usd, eur_overrides=ov
    )
    ytd_withdrawals_eur = cashflows.sum_amounts(
        ytd_txns, _WITHDRAWAL_KINDS, "EUR", eur_to_usd=eur_to_usd, eur_overrides=ov
    )
    ytd_net_contrib_eur = ytd_contributions_eur + ytd_withdrawals_eur

    ytd_contributions_usd = cashflows.sum_amounts(
        ytd_txns, _CONTRIBUTION_KINDS, "USD", eur_to_usd=eur_to_usd
    )
    ytd_withdrawals_usd = cashflows.sum_amounts(
        ytd_txns, _WITHDRAWAL_KINDS, "USD", eur_to_usd=eur_to_usd
    )
    ytd_net_contrib_usd = ytd_contributions_usd + ytd_withdrawals_usd

    if ytd_start_value_eur + ytd_net_contrib_eur > 0:
        ytd_growth_eur = (total_value_eur - ytd_start_value_eur - ytd_net_contrib_eur) / (
            ytd_start_value_eur + ytd_net_contrib_eur
        )
    else:
        ytd_growth_eur = None
    if (
        total_value_usd is not None
        and ytd_start_value_usd is not None
        and ytd_start_value_usd + ytd_net_contrib_usd > 0
    ):
        ytd_growth_usd = (total_value_usd - ytd_start_value_usd - ytd_net_contrib_usd) / (
            ytd_start_value_usd + ytd_net_contrib_usd
        )
    else:
        ytd_growth_usd = None

    # MTD: same shape as YTD but bounded to the first of the current month.
    mtd_growth, mtd_growth_usd = _compute_mtd_growth(
        session,
        txns,
        as_of,
        total_value_eur,
        total_value_usd,
        eur_to_usd=eur_to_usd,
        ov=ov,
        cache=cache,
    )

    # Daily growth on the most recent completed trading day (dual currency).
    daily = _compute_daily_growth(session, as_of=as_of, eur_to_usd=eur_to_usd, cache=cache, now=now)

    # Fund-fee figures from the live positions (value-weighted TER + €/yr cost).
    weighted_expense_ratio, annual_expense_cost_eur = _compute_expense_figures(
        cache.positions(as_of)
    )

    # Trailing dividend yield = total dividend income ÷ current closing balance
    # (matches the spreadsheet's Dividends ÷ Closing Balance).
    dividend_yield_pct = dividends_income_eur / total_value_eur if total_value_eur > 0 else None
    # Per-year dividend yield = trailing-twelve-month cash dividends ÷ current
    # closing balance (a true annual-rate "yield", distinct from the lifetime
    # cumulative dividend return above). A rolling 12-month window rather than
    # calendar year-to-date keeps it meaningful all year round.
    dividend_yield_ttm_pct = dividends_ttm_eur / total_value_eur if total_value_eur > 0 else None

    return PortfolioMetrics(
        as_of=as_of,
        first_cashflow_date=first_cashflow_date,
        total_value_eur=total_value_eur,
        total_contributions_eur=net_contributions_eur,
        total_dividends_cash_eur=dividends_income_eur,
        capital_gain_eur=cap_gain_eur,
        total_growth_pct=growth_pct_legacy,
        xirr=portfolio_xirr_eur,
        ytd_xirr=ytd_xirr_eur,
        ytd_growth_pct=ytd_growth_eur,
        total_growth_compounded_eur=total_growth_eur,
        total_value_usd=total_value_usd,
        total_contributions_usd=net_contributions_usd,
        total_dividends_cash_usd=dividends_income_usd,
        capital_gain_usd=cap_gain_usd,
        xirr_usd=portfolio_xirr_usd,
        ytd_xirr_usd=ytd_xirr_usd,
        ytd_growth_pct_usd=ytd_growth_usd,
        total_growth_compounded_usd=total_growth_usd,
        mtd_growth_pct=mtd_growth,
        mtd_growth_pct_usd=mtd_growth_usd,
        weighted_expense_ratio=weighted_expense_ratio,
        annual_expense_cost_eur=annual_expense_cost_eur,
        daily_growth_pct=daily.growth_eur,
        daily_growth_pct_usd=daily.growth_usd,
        daily_growth_money_eur=daily.move_eur,
        daily_growth_money_usd=daily.move_usd,
        daily_growth_as_of=daily.last_date,
        daily_growth_prev_as_of=daily.prev_date,
        daily_growth_fx_eur_usd=daily.fx_last,
        daily_growth_fx_eur_usd_prev=daily.fx_prev,
        dividend_yield_pct=dividend_yield_pct,
        dividend_yield_ttm_pct=dividend_yield_ttm_pct,
        dividends_ttm_eur=dividends_ttm_eur,
        dividends_ttm_usd=dividends_ttm_usd,
    )


#: How much further (in days) the FX marks behind the two daily-growth dates may
#: reach back than the price dates themselves before the EUR/USD gap is treated
#: as a stale-data artefact rather than a genuine one-day currency move. A few
#: days of slack absorbs the normal weekend / holiday forward-fill (Frankfurter
#: publishes business days only) without letting a real gap in FX history leak
#: weeks of drift into a single day's growth.
_DAILY_GROWTH_FX_TOLERANCE_DAYS = 4


def _fx_mark_date(rates_by_date: dict[date, Decimal], target: date) -> date | None:
    """Date of the FX mark :func:`lookup_rate_with_forward_fill` would use.

    Returns ``target`` itself when a rate is stored on that day, otherwise the
    most recent prior date carrying a rate (the value forward-fill inherits), or
    ``None`` when no rate on or before ``target`` exists. Lets the daily-growth
    guard tell how far back the rate behind a date was actually sourced.
    """
    if target in rates_by_date:
        return target
    prior = [d for d in rates_by_date if d <= target]
    return max(prior) if prior else None


def _value_in_both(
    session: Session,
    on: date,
    *,
    fx: Decimal | None,
    cache: _ValuationCache | None = None,
) -> tuple[Decimal, Decimal | None]:
    """Portfolio value on ``on`` in (EUR, USD), USD via the caller-resolved ``fx``.

    ``fx`` is the EUR/USD anchor the caller has already resolved for ``on`` (see
    :func:`_compute_daily_growth`'s :func:`intraday_snapshots_service.daily_growth_leg_fx`
    call) — this function only applies it, so the growth/move legs stay in lock-step
    with whichever anchor the caller chose. When there is no EUR→USD rate to convert
    with, the USD leg degrades to ``None`` (blank/unavailable) rather than
    relabelling the EUR figure as USD — mirroring every other valuation site (lines
    349/432/600, ``_overview_query``, ``_period_query``). Returning the EUR value in
    the USD slot silently reported the wrong daily-growth (USD) number.
    """
    eur = (
        cache.total_value(on)
        if cache is not None
        else positions_service.total_portfolio_value(session, as_of=on)
    )
    usd: Decimal | None = eur * fx if fx is not None and fx > ZERO else None
    return eur, usd


@dataclass(frozen=True)
class _DailyGrowth:
    """Single-day growth plus the FX context needed to caption it.

    ``growth_eur`` / ``growth_usd`` are the dual-currency one-day moves;
    ``last_date`` / ``prev_date`` the two trading days they span; ``fx_last`` /
    ``fx_prev`` the EUR→USD marks on each (USD per 1 EUR, live-overlaid for
    today). All optional so a not-yet-priced portfolio degrades cleanly.
    """

    growth_eur: Decimal | None
    growth_usd: Decimal | None
    last_date: date | None
    prev_date: date | None
    fx_last: Decimal | None
    fx_prev: Decimal | None
    #: Signed money move (last value − prior value) per currency, ``None`` when
    #: the corresponding growth leg is not computable.
    move_eur: Decimal | None = None
    move_usd: Decimal | None = None


def _compute_daily_growth(
    session: Session,
    *,
    as_of: date,
    eur_to_usd: dict[date, Decimal],
    cache: _ValuationCache | None = None,
    now: datetime | None = None,
) -> _DailyGrowth:
    """Single-day growth on the last completed market session (global baseline).

    The "today's move" baseline is **one global market-close session**, not the
    freshest print among the held instruments: ``last_date`` is the most recent
    trading session on or before ``as_of`` and ``prev_date`` the session before
    it (both holiday-aware, the *same* calendar the Overview "1 Day" chart marks
    via :func:`_overview_query.previous_session_close_value`). The portfolio is
    valued on those two market dates with forward-filled prices, so the headline
    move and the graph endpoints reconcile by construction.

    This unifies the price step across the whole book: a holding whose freshest
    print *predates* the baseline session forward-fills the same stale price into
    *both* marks, contributing nothing — so a massively outdated fund (or one that
    only has the last close and nothing newer) reads 0% today rather than leaking
    an older session's move into the headline.

    💱 Each leg's EUR→USD anchor is resolved by
    :func:`intraday_snapshots_service.daily_growth_leg_fx` (ported from the web
    companion's ``graphAnchorFx``), **not** a bare forward-filled ECB/Frankfurter
    lookup: ``prev_date`` always uses its own settled session close (the
    completeness-gated intraday sample, else that date's ECB rate), and
    ``last_date`` uses the *live* rate only while ``last_date`` is today's
    session and the US market is open right now — once that session has shut,
    it freezes to its own settled close too, so the growth figure stops
    drifting with the after-hours EUR/USD tick the instant the bell rings. This
    governs the growth/move legs only; any holding/portfolio *current value*
    elsewhere keeps re-marking at the live spot.

    Returns a :class:`_DailyGrowth` whose growth legs are ``None`` when there
    aren't two priced dates yet; the EUR→USD marks on each date are carried
    alongside so the UI can caption *which* FX rate (and its change) drove the
    move.
    """
    positions = (
        cache.positions(as_of)
        if cache is not None
        else positions_service.compute_positions(session, as_of=as_of)
    )
    held_ids = [p.instrument.id for p in positions]
    if not held_ids:
        return _DailyGrowth(None, None, None, None, None, None)
    now = now or datetime.now(UTC)
    # One global baseline: the most recent market session on/before ``as_of`` and
    # the session before it (holiday-aware), matching the 1 Day chart's anchor.
    last_date = intraday_snapshots_service.previous_trading_session(as_of + timedelta(days=1))
    prev_date = intraday_snapshots_service.previous_trading_session(last_date)

    def _leg_fx(on: date) -> Decimal | None:
        live = lookup_rate_with_forward_fill(eur_to_usd, on)
        return intraday_snapshots_service.daily_growth_leg_fx(session, on, now=now, live_rate=live)

    fx_last = _leg_fx(last_date)
    fx_prev = _leg_fx(prev_date)
    last_eur, last_usd = _value_in_both(session, last_date, fx=fx_last, cache=cache)
    prev_eur, prev_usd = _value_in_both(session, prev_date, fx=fx_prev, cache=cache)
    growth_eur = (last_eur - prev_eur) / prev_eur if prev_eur > ZERO else None
    # USD growth is only meaningful when both marks could be valued in USD;
    # a missing EUR→USD rate on either date degrades the USD leg to ``None``
    # rather than producing a spurious number from a relabelled EUR value.
    if last_usd is not None and prev_usd is not None and prev_usd > ZERO:
        growth_usd = (last_usd - prev_usd) / prev_usd
    else:
        growth_usd = None
    # Not enough priced history yet (no settled prior mark to grow from): report a
    # blank Today square rather than dating an em-dash. Distinct from a genuinely
    # *outdated* book, which forward-fills the same price into both marks and so
    # yields a computable 0% (prev value > 0) — that case keeps its dates.
    if growth_eur is None and growth_usd is None:
        return _DailyGrowth(None, None, None, None, None, None)
    # Guard against a *fabricated* one-day currency swing. The EUR leg differs
    # from the USD leg only by the EUR→USD change between the two dates' FX
    # marks. FX rates are forward-filled (Frankfurter publishes business days
    # only), so when the rate history has a gap the mark backing ``prev_date``
    # can be sourced from weeks or months earlier than ``last_date``'s — and the
    # EUR daily-growth then inherits all of that drift as if it were a single
    # day's move, reading far larger than any realistic intraday FX change. When
    # the FX marks span materially more calendar time than the price dates do,
    # the difference is a stale-data artefact rather than a genuine same-day
    # move, so fall back to the FX-neutral (USD) move for the EUR leg too.
    if growth_eur is not None and growth_usd is not None:
        src_prev = _fx_mark_date(eur_to_usd, prev_date)
        src_last = _fx_mark_date(eur_to_usd, last_date)
        if src_prev is not None and src_last is not None:
            fx_span_days = (src_last - src_prev).days
            price_span_days = (last_date - prev_date).days
            if fx_span_days > price_span_days + _DAILY_GROWTH_FX_TOLERANCE_DAYS:
                growth_eur = growth_usd
    # Absolute money move (display-currency headline figure for the Today square),
    # carried only when the matching growth leg is computable so the sign and
    # magnitude always agree with the percentage shown beside it.
    move_eur = last_eur - prev_eur if growth_eur is not None else None
    move_usd = (
        last_usd - prev_usd
        if (growth_usd is not None and last_usd is not None and prev_usd is not None)
        else None
    )
    fx_live = lookup_rate_with_forward_fill(eur_to_usd, as_of) or fx_last
    return _DailyGrowth(
        growth_eur, growth_usd, last_date, prev_date, fx_live, fx_prev, move_eur, move_usd
    )


def with_last_session_daily_growth(
    session: Session,
    metrics: PortfolioMetrics,
    *,
    session_date: date,
    now: datetime | None = None,
) -> PortfolioMetrics:
    """Re-base the day move onto ``session_date`` when the baseline day has not traded yet.

    :func:`compute_portfolio_metrics` anchors "today's move" on the latest
    trading *day* on or before ``as_of``. Before the open on a trading day that
    day has no prices yet, so every holding forward-fills yesterday's close into
    both marks and the move reads 0 % (only FX moves the EUR leg). The v5 web
    app showed the last session's result instead ("Last session · Tue"); this
    does the same: ``session_date`` is the most recent session that has started
    (:func:`intraday_snapshots_service.last_session_date`), and the day move,
    its dates and FX marks are recomputed for it vs the session before.

    FX-aware like the original: each mark is valued at its own date's rate
    (never a converted return). Returns ``metrics`` unchanged when the baseline
    already is that session (or earlier), or when no move can be computed.
    """
    if metrics.daily_growth_as_of is None or metrics.daily_growth_as_of <= session_date:
        return metrics
    eur_to_usd = fx_service.get_rates(session, base="EUR", quote="USD")
    daily = _compute_daily_growth(session, as_of=session_date, eur_to_usd=eur_to_usd, now=now)
    if daily.last_date is None:
        return metrics
    return replace(
        metrics,
        daily_growth_pct=daily.growth_eur,
        daily_growth_pct_usd=daily.growth_usd,
        daily_growth_money_eur=daily.move_eur,
        daily_growth_money_usd=daily.move_usd,
        daily_growth_as_of=daily.last_date,
        daily_growth_prev_as_of=daily.prev_date,
        daily_growth_fx_eur_usd=metrics.daily_growth_fx_eur_usd or daily.fx_last,
        daily_growth_fx_eur_usd_prev=daily.fx_prev,
    )


@dataclass(frozen=True)
class LastSessionSplit:
    """The hero day move outside the session: last session's move + overnight currency.

    ``move_*`` is the official closes/NAVs of ``session_date`` vs ``prev_date``,
    each book valued at its own session's 16:00 EUR/USD rate. ``overnight_*`` is
    the same holdings at the same official prices revalued from that close rate to
    the rate now: the only thing that moves overnight is the currency. Per
    currency, ``move + overnight == value_now - prev_close_value`` exactly. A fund
    whose NAV for the session has not posted counts at its previous NAV (official
    prices only, never an estimate).
    """

    session_date: date
    prev_date: date
    fx_close: Decimal
    fx_prev_close: Decimal
    fx_now: Decimal
    move_eur: Decimal
    move_usd: Decimal
    pct_eur: Decimal | None
    pct_usd: Decimal | None
    overnight_eur: Decimal
    overnight_usd: Decimal
    value_now_eur: Decimal
    value_now_usd: Decimal
    #: The same split on the *estimated* book, set only while a fund's NAV for the
    #: session is still pending and its ETF twin estimates it (``estimated_funds``):
    #: the fund counts at ``prev_nav x twin_now / twin_prev_close`` instead of its
    #: previous NAV, valued at the close rate (move) / the rate now (value). Per
    #: currency ``move_est + overnight_est == value_now_est - prev_close_value``.
    estimated_funds: tuple[str, ...] = ()
    move_est_eur: Decimal | None = None
    move_est_usd: Decimal | None = None
    pct_est_eur: Decimal | None = None
    pct_est_usd: Decimal | None = None
    overnight_est_eur: Decimal | None = None
    overnight_est_usd: Decimal | None = None
    value_now_est_eur: Decimal | None = None
    value_now_est_usd: Decimal | None = None


def _estimated_split(
    session: Session,
    *,
    now: datetime,
    eur: DaySplit,
    usd: DaySplit,
    prev: tuple[Decimal, Decimal],
    value_now: tuple[Decimal, Decimal],
    fx_close: Decimal,
    fx_now: Decimal,
) -> dict[str, Any]:
    """The ``*_est`` fields of :class:`LastSessionSplit` (empty without an estimate)."""
    estimates = intraday_snapshots_service.twin_estimates(session, now)
    if not estimates:
        return {}
    at_close = intraday_snapshots_service.estimate_adjustment(estimates.values(), fx_close)
    at_now = intraday_snapshots_service.estimate_adjustment(estimates.values(), fx_now)
    (close_eur, close_usd), (now_eur, now_usd) = at_close, at_now
    if close_eur is None or close_usd is None or now_eur is None or now_usd is None:
        return {}
    (prev_eur, prev_usd), (value_eur, value_usd) = prev, value_now
    move_eur, move_usd = eur.move + close_eur, usd.move + close_usd
    return {
        "estimated_funds": tuple(sorted(e.symbol for e in estimates.values())),
        "move_est_eur": move_eur,
        "move_est_usd": move_usd,
        "pct_est_eur": move_eur / prev_eur if prev_eur > 0 else None,
        "pct_est_usd": move_usd / prev_usd if prev_usd > 0 else None,
        # overnight on the estimated book: its change in value since the close rate.
        "overnight_est_eur": eur.overnight + (now_eur - close_eur),
        "overnight_est_usd": usd.overnight + (now_usd - close_usd),
        "value_now_est_eur": value_eur + now_eur,
        "value_now_est_usd": value_usd + now_usd,
    }


def _book_holdings(session: Session, on: date) -> list[Any]:
    """The whole book on ``on`` (official closes, forward-filled) as native holdings."""
    from investment_dashboard.domain.late_data import Holding  # noqa: PLC0415

    holdings = [
        Holding(p.account.native_currency, p.current_value_native, p.current_value_eur)
        for p in positions_service.compute_positions(session, as_of=on)
        if p.current_value_native
    ]
    for account in accounts_repo.list_accounts(session):
        if account.account_type not in {"savings", "cash"}:
            continue
        balance = positions_service.compute_cash_balance(session, account.id, as_of=on)
        if not balance:
            continue
        ccy = account.native_currency.upper()
        fallback = ZERO
        if ccy not in {"EUR", "USD"}:
            rate = fx_service.get_rate_eur_to_quote(session, on, quote=ccy)
            fallback = balance / rate if rate else ZERO
        holdings.append(Holding(ccy, balance, fallback))
    return holdings


def last_session_split(
    session: Session,
    *,
    now: datetime,
    fx_now: Decimal | None,
) -> LastSessionSplit | None:
    """Split the hero day move into the last session + overnight currency (market shut).

    ``None`` while the US market is open (the live move is one figure then) or
    when a rate is missing. FX-aware: each mark is valued at its own rate, never a
    converted return.
    """
    from investment_dashboard.domain.late_data import (  # noqa: PLC0415
        split_day_change,
        value_at_rate,
    )
    from investment_dashboard.domain.market_hours import is_us_market_open  # noqa: PLC0415

    if is_us_market_open(now) or fx_now is None or fx_now <= 0:
        return None
    session_date = intraday_snapshots_service.last_session_date(now)
    prev_date = intraday_snapshots_service.previous_trading_session(session_date)
    fx_close = intraday_snapshots_service.session_close_rate(session, session_date)
    fx_prev = intraday_snapshots_service.session_close_rate(session, prev_date)
    if not fx_close or not fx_prev or fx_close <= 0 or fx_prev <= 0:
        return None
    last_book = _book_holdings(session, session_date)
    prev_eur, prev_usd = value_at_rate(_book_holdings(session, prev_date), fx_prev)
    last_eur, last_usd = value_at_rate(last_book, fx_close)
    now_eur, now_usd = value_at_rate(last_book, fx_now)
    if prev_eur <= 0:
        return None
    eur = split_day_change(prev_eur, last_eur, now_eur)
    usd = split_day_change(prev_usd, last_usd, now_usd)
    return LastSessionSplit(
        **_estimated_split(
            session,
            now=now,
            eur=eur,
            usd=usd,
            prev=(prev_eur, prev_usd),
            value_now=(now_eur, now_usd),
            fx_close=fx_close,
            fx_now=fx_now,
        ),
        session_date=session_date,
        prev_date=prev_date,
        fx_close=fx_close,
        fx_prev_close=fx_prev,
        fx_now=fx_now,
        move_eur=eur.move,
        move_usd=usd.move,
        pct_eur=eur.pct,
        pct_usd=usd.pct,
        overnight_eur=eur.overnight,
        overnight_usd=usd.overnight,
        value_now_eur=now_eur,
        value_now_usd=now_usd,
    )


def with_last_session_split(metrics: PortfolioMetrics, split: LastSessionSplit) -> PortfolioMetrics:
    """``metrics`` with the hero day move set to the split's last-session move."""
    return replace(
        metrics,
        daily_growth_pct=split.pct_eur,
        daily_growth_pct_usd=split.pct_usd,
        daily_growth_money_eur=split.move_eur,
        daily_growth_money_usd=split.move_usd,
        daily_growth_as_of=split.session_date,
        daily_growth_prev_as_of=split.prev_date,
    )


def _compute_mtd_growth(
    session: Session,
    txns: list[Transaction],
    as_of: date,
    total_value_eur: Decimal,
    total_value_usd: Decimal | None,
    *,
    eur_to_usd: dict[date, Decimal],
    ov: Mapping[int, Decimal] | None = None,
    cache: _ValuationCache | None = None,
) -> tuple[Decimal | None, Decimal | None]:
    """Month-to-date simple growth in EUR and USD, net of this month's flows.

    ``(V_today - V_month_start - net_contributions_mtd) /
    (V_month_start + net_contributions_mtd)`` computed independently for
    each currency. The USD leg values the start-of-month portfolio with
    the FX rate in effect on the first of the month and this month's
    contributions at their per-trade-date rate, mirroring the dual-wallet
    treatment used for XIRR/YTD. Returns ``(None, None)`` for a currency
    whose denominator is non-positive (e.g. a brand-new portfolio) or, for
    USD, when no EUR→USD spot is available to value the terminal mark.
    """
    month_start = date(as_of.year, as_of.month, 1)
    month_start_value_eur = (
        cache.total_value(month_start)
        if cache is not None
        else positions_service.total_portfolio_value(session, as_of=month_start)
    )
    if month_start_value_eur <= ZERO:
        return None, None
    fx_month_start = lookup_rate_with_forward_fill(eur_to_usd, month_start) or ZERO
    month_start_value_usd: Decimal | None = (
        month_start_value_eur * fx_month_start if fx_month_start != 0 else None
    )

    mtd_txns = [t for t in txns if t.date >= month_start]
    mtd_contrib_eur = cashflows.sum_amounts(
        mtd_txns, _CONTRIBUTION_KINDS, "EUR", eur_to_usd=eur_to_usd, eur_overrides=ov
    )
    mtd_withdraw_eur = cashflows.sum_amounts(
        mtd_txns, _WITHDRAWAL_KINDS, "EUR", eur_to_usd=eur_to_usd, eur_overrides=ov
    )
    mtd_net_eur = mtd_contrib_eur + mtd_withdraw_eur
    mtd_contrib_usd = cashflows.sum_amounts(
        mtd_txns, _CONTRIBUTION_KINDS, "USD", eur_to_usd=eur_to_usd
    )
    mtd_withdraw_usd = cashflows.sum_amounts(
        mtd_txns, _WITHDRAWAL_KINDS, "USD", eur_to_usd=eur_to_usd
    )
    mtd_net_usd = mtd_contrib_usd + mtd_withdraw_usd

    def _growth(value_now: Decimal, value_start: Decimal, net: Decimal) -> Decimal | None:
        denom = value_start + net
        if denom <= ZERO:
            return None
        return (value_now - value_start - net) / denom

    usd_growth = (
        _growth(total_value_usd, month_start_value_usd, mtd_net_usd)
        if (total_value_usd is not None and month_start_value_usd is not None)
        else None
    )
    return (
        _growth(total_value_eur, month_start_value_eur, mtd_net_eur),
        usd_growth,
    )


def _compute_expense_figures(
    positions: list[positions_service.Position],
) -> tuple[Decimal | None, Decimal]:
    """Value-weighted expense ratio + annual €-cost across held positions.

    Mirrors the spreadsheet's ``Total!E15`` (``SUMPRODUCT(expense, weight)``)
    and ``Total!E17`` (annual fee cost in €). Positions with an unknown TER
    contribute ``0`` to the cost numerator (treated as fee-free), matching
    the spreadsheet's blank-expense handling. Returns ``(None, 0)`` when no
    position carries a positive EUR value.
    """
    total_value = ZERO
    weighted_cost = ZERO
    for p in positions:
        value_eur = p.current_value_eur
        if value_eur <= ZERO:
            continue
        total_value += value_eur
        ter = p.effective.expense_ratio if p.effective is not None else p.instrument.expense_ratio
        if ter is not None:
            weighted_cost += value_eur * ter
    if total_value <= ZERO:
        return None, ZERO
    return weighted_cost / total_value, weighted_cost


def _best_effort_ytd_start_value(
    session: Session,
    year_start: date,
    as_of: date,
    *,
    cache: _ValuationCache | None = None,
) -> Decimal:
    """Fallback when Jan-1 has no price/FX tick (new portfolio / sparse history).

    Prefers a stored daily snapshot (B3): persisted snapshots already hold the
    EUR total-portfolio value for a date, so the earliest positive snapshot in
    the bounded window is the Jan-1-start proxy without re-rolling the ledger.
    When no snapshots cover the window we fall back to the original bounded
    day-by-day live valuation so brand-new portfolios (which have no snapshots
    yet) keep rendering.
    """
    from datetime import timedelta as _td  # noqa: PLC0415

    horizon = min(as_of, year_start + _td(days=31))

    stored = snapshots_service.stored_snapshots_in_range(session, year_start, horizon)
    for day in sorted(stored):
        if stored[day] > ZERO:
            return stored[day]

    cursor = year_start
    while cursor <= horizon:
        value = (
            cache.total_value(cursor)
            if cache is not None
            else positions_service.total_portfolio_value(session, as_of=cursor)
        )
        if value > ZERO:
            return value
        cursor += _td(days=1)
    return ZERO
