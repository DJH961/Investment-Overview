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

from investment_dashboard.domain.currency import lookup_rate_with_forward_fill
from investment_dashboard.domain.returns import (
    Cashflow,
    capital_gain,
    total_growth_pct,
    total_growth_pct_compounded,
    xirr,
    years_between,
)
from investment_dashboard.models import Transaction, TransactionKind
from investment_dashboard.repositories import accounts_repo, fx_repo, transactions_repo
from investment_dashboard.services import positions_service

ZERO = Decimal(0)


# Kinds that move *external* cash (the user's bank ↔ portfolio).
_CONTRIBUTION_KINDS = {TransactionKind.DEPOSIT.value}
_WITHDRAWAL_KINDS = {TransactionKind.WITHDRAWAL.value}
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
    # USD parallels (v2.5)
    total_value_usd: Decimal
    total_contributions_usd: Decimal
    total_dividends_cash_usd: Decimal
    capital_gain_usd: Decimal
    xirr_usd: Decimal | None
    ytd_xirr_usd: Decimal | None
    ytd_growth_pct_usd: Decimal | None
    total_growth_compounded_usd: Decimal | None
    #: Month-to-date portfolio growth (mirrors the spreadsheet's MTD block
    #: on ``Deposits``/``Total``). ``None`` when the start-of-month value
    #: can't be established (brand-new portfolio / no price history).
    mtd_growth_pct: Decimal | None = None
    #: Value-weighted average expense ratio across held positions
    #: (spreadsheet ``Total!E15`` = ``SUMPRODUCT(expense, weight)``).
    #: ``None`` when there are no valued positions.
    weighted_expense_ratio: Decimal | None = None
    #: Estimated annual fund-fee cost in EUR at the current marks
    #: (spreadsheet ``Total!E17`` = ``Σ price·expense·shares``).
    annual_expense_cost_eur: Decimal = Decimal(0)


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

    USD-native accounts short-circuit FX entirely. For every other
    currency we convert the EUR amount with the EUR→USD rate **on the
    transaction's date** (forward-filled), so a USD wallet's series
    reflects the FX it actually saw, not today's spot scaled across
    history. When no rate is available the figure is excluded from the
    USD series (``Decimal(0)``) rather than poisoned with a wrong-
    magnitude EUR-as-USD value.
    """
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


def compute_portfolio_metrics(  # noqa: PLR0915
    session: Session,
    *,
    as_of: date | None = None,
) -> PortfolioMetrics:
    as_of = as_of or date.today()
    txns = list(transactions_repo.list_transactions(session, end=as_of))

    eur_to_usd: dict[date, Decimal] = fx_repo.get_rates(session, base="EUR", quote="USD")

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
    dividends_cash_eur = sum(
        (_txn_eur_amount(t) for t in txns if t.kind == TransactionKind.DIVIDEND_CASH.value),
        start=ZERO,
    )

    contributions_usd = sum(
        (_usd_amount(t) for t in txns if t.kind in _CONTRIBUTION_KINDS),
        start=ZERO,
    )
    withdrawals_usd = sum(
        (_usd_amount(t) for t in txns if t.kind in _WITHDRAWAL_KINDS),
        start=ZERO,
    )
    net_contributions_usd = contributions_usd + withdrawals_usd
    dividends_cash_usd = sum(
        (_usd_amount(t) for t in txns if t.kind == TransactionKind.DIVIDEND_CASH.value),
        start=ZERO,
    )

    total_value_eur = positions_service.total_portfolio_value(session, as_of=as_of)
    # Today's spot for the terminal mark-to-market USD value. We use spot
    # for the *terminal* alone because positions_service already values
    # everything in EUR using today's FX; per-trade-date USD is applied to
    # the historical cashflow stream below.
    fx_today = lookup_rate_with_forward_fill(eur_to_usd, as_of) or ZERO
    total_value_usd = total_value_eur * fx_today if fx_today != 0 else total_value_eur

    retained_cash_account_ids = {
        account.id
        for account in accounts_repo.list_accounts(session)
        if account.account_type in _RETAINED_CASH_ACCOUNT_TYPES
    }

    cap_gain_eur = capital_gain(
        contributions=net_contributions_eur,
        current_value=total_value_eur,
        cumulative_dividends_cash=dividends_cash_eur,
    )
    cap_gain_usd = capital_gain(
        contributions=net_contributions_usd,
        current_value=total_value_usd,
        cumulative_dividends_cash=dividends_cash_usd,
    )
    growth_pct_legacy = total_growth_pct(
        net_contributions_eur, total_value_eur + dividends_cash_eur
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
    portfolio_xirr_usd = xirr(cashflows_usd, as_of=as_of, terminal_value=total_value_usd)

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
    ytd_start_value_usd = (
        ytd_start_value_eur * fx_year_start if fx_year_start != 0 else ytd_start_value_eur
    )
    # Treat the start-of-year value as a synthetic "contribution" (negative).
    ytd_cashflows_eur.insert(0, Cashflow(date=year_start, amount=-ytd_start_value_eur))
    ytd_cashflows_usd.insert(0, Cashflow(date=year_start, amount=-ytd_start_value_usd))
    ytd_xirr_eur = xirr(ytd_cashflows_eur, as_of=as_of, terminal_value=total_value_eur)
    ytd_xirr_usd = xirr(ytd_cashflows_usd, as_of=as_of, terminal_value=total_value_usd)

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
    if ytd_start_value_usd + ytd_net_contrib_usd > 0:
        ytd_growth_usd = (total_value_usd - ytd_start_value_usd - ytd_net_contrib_usd) / (
            ytd_start_value_usd + ytd_net_contrib_usd
        )
    else:
        ytd_growth_usd = None

    # MTD: same shape as YTD but bounded to the first of the current month.
    mtd_growth = _compute_mtd_growth(session, txns, as_of, total_value_eur)

    # Fund-fee figures from the live positions (value-weighted TER + €/yr cost).
    weighted_expense_ratio, annual_expense_cost_eur = _compute_expense_figures(
        positions_service.compute_positions(session, as_of=as_of)
    )

    return PortfolioMetrics(
        as_of=as_of,
        first_cashflow_date=first_cashflow_date,
        total_value_eur=total_value_eur,
        total_contributions_eur=net_contributions_eur,
        total_dividends_cash_eur=dividends_cash_eur,
        capital_gain_eur=cap_gain_eur,
        total_growth_pct=growth_pct_legacy,
        xirr=portfolio_xirr_eur,
        ytd_xirr=ytd_xirr_eur,
        ytd_growth_pct=ytd_growth_eur,
        total_growth_compounded_eur=total_growth_eur,
        total_value_usd=total_value_usd,
        total_contributions_usd=net_contributions_usd,
        total_dividends_cash_usd=dividends_cash_usd,
        capital_gain_usd=cap_gain_usd,
        xirr_usd=portfolio_xirr_usd,
        ytd_xirr_usd=ytd_xirr_usd,
        ytd_growth_pct_usd=ytd_growth_usd,
        total_growth_compounded_usd=total_growth_usd,
        mtd_growth_pct=mtd_growth,
        weighted_expense_ratio=weighted_expense_ratio,
        annual_expense_cost_eur=annual_expense_cost_eur,
    )


def _compute_mtd_growth(
    session: Session,
    txns: list[Transaction],
    as_of: date,
    total_value_eur: Decimal,
) -> Decimal | None:
    """Month-to-date simple growth, net of this month's external cashflows.

    ``(V_today - V_month_start - net_contributions_mtd) /
    (V_month_start + net_contributions_mtd)``. Returns ``None`` when the
    denominator is non-positive (e.g. a brand-new portfolio with no
    start-of-month value).
    """
    month_start = date(as_of.year, as_of.month, 1)
    month_start_value = positions_service.total_portfolio_value(session, as_of=month_start)
    if month_start_value <= ZERO:
        return None
    mtd_txns = [t for t in txns if t.date >= month_start]
    mtd_contrib = sum(
        (_txn_eur_amount(t) for t in mtd_txns if t.kind in _CONTRIBUTION_KINDS),
        start=ZERO,
    )
    mtd_withdraw = sum(
        (_txn_eur_amount(t) for t in mtd_txns if t.kind in _WITHDRAWAL_KINDS),
        start=ZERO,
    )
    mtd_net = mtd_contrib + mtd_withdraw
    denom = month_start_value + mtd_net
    if denom <= ZERO:
        return None
    return (total_value_eur - month_start_value - mtd_net) / denom


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
