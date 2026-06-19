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

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.domain import dividends
from investment_dashboard.domain.currency import (
    dual_currency_amounts,
    lookup_rate_with_forward_fill,
)
from investment_dashboard.domain.money_market import is_money_market
from investment_dashboard.domain.returns import (
    Cashflow,
    capital_gain,
    total_growth_pct,
    total_growth_pct_compounded,
    xirr,
    years_between,
)
from investment_dashboard.models import Transaction, TransactionKind
from investment_dashboard.repositories import (
    accounts_repo,
    transactions_repo,
)
from investment_dashboard.services import fx_service, positions_service, prices_service

ZERO = Decimal(0)


# Kinds that move *external* cash (the user's bank ↔ portfolio).
# ``transfer_in`` / ``transfer_out`` model inter-account or in-kind moves: a
# transfer between two *tracked* accounts records both legs, so counting
# ``transfer_in`` as a contribution and ``transfer_out`` as a withdrawal nets
# to zero at the portfolio level, while a move that crosses the tracked
# boundary (only one leg exists) is correctly treated as an external flow.
_CONTRIBUTION_KINDS = {
    TransactionKind.DEPOSIT.value,
    TransactionKind.TRANSFER_IN.value,
}
_WITHDRAWAL_KINDS = {
    TransactionKind.WITHDRAWAL.value,
    TransactionKind.TRANSFER_OUT.value,
}
_RETAINED_CASH_ACCOUNT_TYPES = {"savings", "cash"}
# Kinds that receive cash not represented in the current portfolio value.
_DISTRIBUTION_KINDS = {
    TransactionKind.DIVIDEND_CASH.value,
    TransactionKind.INTEREST.value,
}


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
    #: Trailing dividend yield = cash dividends received ÷ current closing
    #: balance (spreadsheet ``Total`` block's ``Dividends / Closing Balance``).
    #: ``None`` when the portfolio has no value yet.
    dividend_yield_pct: Decimal | None = None
    #: The date ``daily_growth_pct`` refers to (the "last daily growth day"),
    #: so the UI can label *when* the move is from. ``None`` when unavailable.
    daily_growth_as_of: date | None = None


def _txn_eur_amount(t: Transaction) -> Decimal:
    """EUR-converted cash leg of one transaction.

    Uses the cached ``net_eur`` if present; otherwise falls back to
    ``net_native`` (assumes EUR account). Returning ``Decimal(0)`` for a
    ``None`` net leaves XIRR unaffected.
    """
    if t.net_eur is not None:
        return t.net_eur
    if t.net_native is not None:
        return t.net_native
    return ZERO


def _txn_usd_amount(
    t: Transaction,
    *,
    eur_to_usd: dict[date, Decimal],
) -> Decimal:
    """USD-converted cash leg of one transaction (per trade-date FX).

    Prefers the **frozen** ``net_usd`` leg persisted at import / manual entry
    (v2.9), which for USD-native accounts is the booked amount verbatim. Only
    when that column is ``NULL`` (a row predating the backfill, or written
    during an FX-history gap) do we fall back to live derivation: USD-native
    rows read ``net_native`` directly, every other currency converts the EUR
    amount at the EUR→USD rate **on the transaction's date** (forward-filled).
    When no rate is available the figure is excluded from the USD series
    (``Decimal(0)``) rather than poisoned with a wrong-magnitude value.
    """
    if t.net_usd is not None:
        return t.net_usd
    native_ccy = (t.account.native_currency if t.account else "EUR").upper()
    if native_ccy == "USD" and t.net_native is not None:
        return t.net_native
    eur_amt = _txn_eur_amount(t)
    if eur_amt == ZERO:
        return ZERO
    rate = lookup_rate_with_forward_fill(eur_to_usd, t.date)
    if rate is None or rate == 0:
        return ZERO
    return eur_amt * rate


def build_instrument_cashflows(
    session: Session,
    *,
    as_of: date | None = None,
) -> tuple[dict[int, list[Cashflow]], dict[int, list[Cashflow]]]:
    """Per-instrument EUR and USD cashflow streams for holding-level XIRR."""
    as_of = as_of or date.today()
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
        eur_flows.setdefault(iid, []).append(Cashflow(date=t.date, amount=eur or ZERO))
        usd_flows.setdefault(iid, []).append(Cashflow(date=t.date, amount=usd or ZERO))
    return eur_flows, usd_flows


def build_portfolio_cashflows(
    transactions: Sequence[Transaction],
    *,
    retained_cash_account_ids: set[int] | frozenset[int] = frozenset(),
    amount_fn: Callable[[Transaction], Decimal] | None = None,
) -> list[Cashflow]:
    """Translate ledger rows into the signed cashflow stream XIRR needs.

    Sign convention (matches :mod:`investment_dashboard.domain.returns`):
        * ``deposit`` ⇒ negative (money in from outside).
        * ``withdrawal`` ⇒ positive (money out).
        * ``dividend_cash`` / ``interest`` ⇒ positive when the cash is not
          retained in an account included in terminal portfolio value.
        * ``buy`` / ``sell`` / ``dividend_reinvest`` are *internal*
          rebalances — the cash never leaves the portfolio, so they do
          **not** enter the portfolio-level XIRR. Their P&L appears
          implicitly via the terminal mark-to-market.

    ``amount_fn`` selects which currency to read each transaction in;
    defaults to :func:`_txn_eur_amount` to preserve pre-v2.5 callers.
    Pass a USD-aware function (using FX history) to build the USD
    parallel series.
    """
    fn = amount_fn or _txn_eur_amount
    flows: list[Cashflow] = []
    for t in transactions:
        kind = t.kind
        amount = fn(t)
        if kind in _CONTRIBUTION_KINDS:
            # Deposit: amount > 0 ⇒ cashflow is negative.
            flows.append(Cashflow(date=t.date, amount=-amount))
        elif kind in _WITHDRAWAL_KINDS:
            # Withdrawal: amount < 0 (cash out of account) ⇒ flow positive.
            flows.append(Cashflow(date=t.date, amount=-amount))
        elif kind in _DISTRIBUTION_KINDS and t.account_id not in retained_cash_account_ids:
            flows.append(Cashflow(date=t.date, amount=amount))
    return flows


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
    retained |= {
        t.account_id
        for t in transactions
        if t.account_id is not None
        and t.instrument is not None
        and is_money_market(t.instrument.symbol, name=t.instrument.name)
    }
    return retained


def compute_portfolio_metrics(  # noqa: PLR0915
    session: Session,
    *,
    as_of: date | None = None,
) -> PortfolioMetrics:
    as_of = as_of or date.today()
    txns = list(transactions_repo.list_transactions(session, end=as_of))

    eur_to_usd: dict[date, Decimal] = fx_service.get_rates(session, base="EUR", quote="USD")

    def _usd_amount(t: Transaction) -> Decimal:
        return _txn_usd_amount(t, eur_to_usd=eur_to_usd)

    contributions_eur = sum(
        (_txn_eur_amount(t) for t in txns if t.kind in _CONTRIBUTION_KINDS),
        start=ZERO,
    )
    withdrawals_eur = sum(
        (_txn_eur_amount(t) for t in txns if t.kind in _WITHDRAWAL_KINDS),
        start=ZERO,
    )
    net_contributions_eur = contributions_eur + withdrawals_eur  # withdrawals are negative

    # Dividend *income* (spec §6.1): every distribution counted once — the
    # reinvested value plus un-reinvested cash — matching the spreadsheet's
    # Dividends column (incl. VMFXX settlement-fund interest, which has no
    # separate cash leg). Realized cash is the subset that actually left the
    # portfolio; reinvested distributions are already in ``total_value`` so
    # only realized cash may be added back to reconstruct capital gain.
    reinvest_keys = dividends.reinvest_keys(list(txns))

    def _dividends(*, include_reinvested: bool) -> tuple[Decimal, Decimal]:
        eur_total = ZERO
        usd_total = ZERO
        for t in txns:
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

    contributions_usd = sum(
        (_usd_amount(t) for t in txns if t.kind in _CONTRIBUTION_KINDS),
        start=ZERO,
    )
    withdrawals_usd = sum(
        (_usd_amount(t) for t in txns if t.kind in _WITHDRAWAL_KINDS),
        start=ZERO,
    )
    net_contributions_usd = contributions_usd + withdrawals_usd

    total_value_eur = positions_service.total_portfolio_value(session, as_of=as_of)
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

    cashflows_eur = build_portfolio_cashflows(
        txns,
        retained_cash_account_ids=retained_cash_account_ids,
    )
    cashflows_usd = build_portfolio_cashflows(
        txns,
        retained_cash_account_ids=retained_cash_account_ids,
        amount_fn=_usd_amount,
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
    ytd_cashflows_eur = build_portfolio_cashflows(
        ytd_txns,
        retained_cash_account_ids=retained_cash_account_ids,
    )
    ytd_cashflows_usd = build_portfolio_cashflows(
        ytd_txns,
        retained_cash_account_ids=retained_cash_account_ids,
        amount_fn=_usd_amount,
    )
    # Best-effort Jan-1 valuation: requires price + FX history for that
    # date. For brand-new portfolios with no Jan-1 history we fall back
    # to the earliest available snapshot in the YTD window (and
    # ultimately to ``Decimal(0)``), so the page renders instead of
    # raising. This mirrors spec §6.4's "ytd_start_value best-effort"
    # note (v1.2 closure of the v1.0 caveat).
    ytd_start_value_eur = positions_service.total_portfolio_value(session, as_of=year_start)
    if ytd_start_value_eur <= ZERO:
        ytd_start_value_eur = _best_effort_ytd_start_value(session, year_start, as_of)
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

    ytd_contributions_eur = sum(
        (_txn_eur_amount(t) for t in ytd_txns if t.kind in _CONTRIBUTION_KINDS),
        start=ZERO,
    )
    ytd_withdrawals_eur = sum(
        (_txn_eur_amount(t) for t in ytd_txns if t.kind in _WITHDRAWAL_KINDS),
        start=ZERO,
    )
    ytd_net_contrib_eur = ytd_contributions_eur + ytd_withdrawals_eur

    ytd_contributions_usd = sum(
        (_usd_amount(t) for t in ytd_txns if t.kind in _CONTRIBUTION_KINDS),
        start=ZERO,
    )
    ytd_withdrawals_usd = sum(
        (_usd_amount(t) for t in ytd_txns if t.kind in _WITHDRAWAL_KINDS),
        start=ZERO,
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
        session, txns, as_of, total_value_eur, total_value_usd, eur_to_usd=eur_to_usd
    )

    # Daily growth on the most recent completed trading day (dual currency).
    daily_growth_eur, daily_growth_usd, daily_as_of = _compute_daily_growth(
        session, as_of=as_of, eur_to_usd=eur_to_usd
    )

    # Fund-fee figures from the live positions (value-weighted TER + €/yr cost).
    weighted_expense_ratio, annual_expense_cost_eur = _compute_expense_figures(
        positions_service.compute_positions(session, as_of=as_of)
    )

    # Trailing dividend yield = total dividend income ÷ current closing balance
    # (matches the spreadsheet's Dividends ÷ Closing Balance).
    dividend_yield_pct = dividends_income_eur / total_value_eur if total_value_eur > 0 else None

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
        daily_growth_pct=daily_growth_eur,
        daily_growth_pct_usd=daily_growth_usd,
        daily_growth_as_of=daily_as_of,
        dividend_yield_pct=dividend_yield_pct,
    )


def _value_in_both(
    session: Session,
    on: date,
    *,
    eur_to_usd: dict[date, Decimal],
) -> tuple[Decimal, Decimal]:
    """Portfolio value on ``on`` in (EUR, USD), USD via that date's FX."""
    eur = positions_service.total_portfolio_value(session, as_of=on)
    fx = lookup_rate_with_forward_fill(eur_to_usd, on) or ZERO
    usd = eur * fx if fx != 0 else eur
    return eur, usd


def _compute_daily_growth(
    session: Session,
    *,
    as_of: date,
    eur_to_usd: dict[date, Decimal],
) -> tuple[Decimal | None, Decimal | None, date | None]:
    """Single-day growth on the most recent completed trading day.

    The "last daily growth day" is the latest date (``<= as_of``) on which
    *any* currently-held instrument has a price print — so on a Sunday it is
    Friday's data, and before the US close (e.g. 10am CET) it is yesterday's.
    The portfolio is valued on that date and on the prior print date with
    forward-filled prices, which transparently accommodates the fact that some
    holdings are ETFs (daily close) and some are mutual funds (lagged NAV):
    each date is a consistent mark of the whole book.

    Returns ``(growth_eur, growth_usd, as_of_date)``; all ``None`` when there
    aren't two priced dates yet.
    """
    held_ids = [p.instrument.id for p in positions_service.compute_positions(session, as_of=as_of)]
    dates = prices_service.recent_price_dates(session, held_ids, on_or_before=as_of, limit=2)
    if len(dates) < 2:
        return None, None, None
    last_date, prev_date = dates[0], dates[1]
    last_eur, last_usd = _value_in_both(session, last_date, eur_to_usd=eur_to_usd)
    prev_eur, prev_usd = _value_in_both(session, prev_date, eur_to_usd=eur_to_usd)
    growth_eur = (last_eur - prev_eur) / prev_eur if prev_eur > ZERO else None
    growth_usd = (last_usd - prev_usd) / prev_usd if prev_usd > ZERO else None
    return growth_eur, growth_usd, last_date


def _compute_mtd_growth(
    session: Session,
    txns: list[Transaction],
    as_of: date,
    total_value_eur: Decimal,
    total_value_usd: Decimal | None,
    *,
    eur_to_usd: dict[date, Decimal],
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
    month_start_value_eur = positions_service.total_portfolio_value(session, as_of=month_start)
    if month_start_value_eur <= ZERO:
        return None, None
    fx_month_start = lookup_rate_with_forward_fill(eur_to_usd, month_start) or ZERO
    month_start_value_usd: Decimal | None = (
        month_start_value_eur * fx_month_start if fx_month_start != 0 else None
    )

    mtd_txns = [t for t in txns if t.date >= month_start]
    mtd_contrib_eur = sum(
        (_txn_eur_amount(t) for t in mtd_txns if t.kind in _CONTRIBUTION_KINDS),
        start=ZERO,
    )
    mtd_withdraw_eur = sum(
        (_txn_eur_amount(t) for t in mtd_txns if t.kind in _WITHDRAWAL_KINDS),
        start=ZERO,
    )
    mtd_net_eur = mtd_contrib_eur + mtd_withdraw_eur
    mtd_contrib_usd = sum(
        (
            _txn_usd_amount(t, eur_to_usd=eur_to_usd)
            for t in mtd_txns
            if t.kind in _CONTRIBUTION_KINDS
        ),
        start=ZERO,
    )
    mtd_withdraw_usd = sum(
        (
            _txn_usd_amount(t, eur_to_usd=eur_to_usd)
            for t in mtd_txns
            if t.kind in _WITHDRAWAL_KINDS
        ),
        start=ZERO,
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
) -> Decimal:
    """Fallback when Jan-1 has no price/FX tick (new portfolio / sparse history).

    Walks forward day-by-day (up to 31 days) and returns the first
    non-zero ``total_portfolio_value``. Bounded so we don't fan out a
    full year of position roll-ups on the unhappy path.
    """
    from datetime import timedelta as _td  # noqa: PLC0415

    horizon = min(as_of, year_start + _td(days=31))
    cursor = year_start
    while cursor <= horizon:
        value = positions_service.total_portfolio_value(session, as_of=cursor)
        if value > ZERO:
            return value
        cursor += _td(days=1)
    return ZERO
