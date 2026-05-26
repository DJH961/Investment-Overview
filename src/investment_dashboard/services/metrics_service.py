"""Metrics service — compose cashflows from the ledger and call domain math.

The domain layer is pure; this layer assembles its inputs from the DB.
Returned metrics use :class:`decimal.Decimal` throughout.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.domain.returns import (
    Cashflow,
    capital_gain,
    total_growth_pct,
    xirr,
)
from investment_dashboard.models import Transaction, TransactionKind
from investment_dashboard.repositories import accounts_repo, transactions_repo
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
    """High-level KPIs for ``/overview``."""

    as_of: date
    total_value_eur: Decimal
    total_contributions_eur: Decimal
    total_dividends_cash_eur: Decimal
    capital_gain_eur: Decimal
    total_growth_pct: Decimal | None
    xirr: Decimal | None
    ytd_xirr: Decimal | None
    ytd_growth_pct: Decimal | None


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


def build_portfolio_cashflows(
    transactions: Sequence[Transaction],
    *,
    retained_cash_account_ids: set[int] | frozenset[int] = frozenset(),
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
    """
    flows: list[Cashflow] = []
    for t in transactions:
        kind = t.kind
        net_eur = _txn_eur_amount(t)
        if kind in _CONTRIBUTION_KINDS:
            # Deposit: net_native > 0 ⇒ cashflow is negative.
            flows.append(Cashflow(date=t.date, amount=-net_eur))
        elif kind in _WITHDRAWAL_KINDS:
            # Withdrawal: net_native < 0 (cash out of account) ⇒ flow positive.
            flows.append(Cashflow(date=t.date, amount=-net_eur))
        elif kind in _DISTRIBUTION_KINDS and t.account_id not in retained_cash_account_ids:
            flows.append(Cashflow(date=t.date, amount=net_eur))
    return flows


def compute_portfolio_metrics(
    session: Session,
    *,
    as_of: date | None = None,
) -> PortfolioMetrics:
    as_of = as_of or date.today()
    txns = list(transactions_repo.list_transactions(session, end=as_of))

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

    total_value_eur = positions_service.total_portfolio_value(session, as_of=as_of)
    retained_cash_account_ids = {
        account.id
        for account in accounts_repo.list_accounts(session)
        if account.account_type in _RETAINED_CASH_ACCOUNT_TYPES
    }

    cap_gain = capital_gain(
        contributions=net_contributions_eur,
        current_value=total_value_eur,
        cumulative_dividends_cash=dividends_cash_eur,
    )
    growth = total_growth_pct(net_contributions_eur, total_value_eur + dividends_cash_eur)

    cashflows = build_portfolio_cashflows(
        txns,
        retained_cash_account_ids=retained_cash_account_ids,
    )
    portfolio_xirr = xirr(cashflows, as_of=as_of, terminal_value=total_value_eur)

    # YTD: value at start of year + cashflows from Jan 1 onward.
    year_start = date(as_of.year, 1, 1)
    ytd_txns = [t for t in txns if t.date >= year_start]
    ytd_cashflows = build_portfolio_cashflows(
        ytd_txns,
        retained_cash_account_ids=retained_cash_account_ids,
    )
    # Best-effort Jan-1 valuation: requires price + FX history for that
    # date. For brand-new portfolios with no Jan-1 history we fall back
    # to the earliest available snapshot in the YTD window (and
    # ultimately to ``Decimal(0)``), so the page renders instead of
    # raising. This mirrors spec §6.4's "ytd_start_value best-effort"
    # note (v1.2 closure of the v1.0 caveat).
    ytd_start_value = positions_service.total_portfolio_value(session, as_of=year_start)
    if ytd_start_value <= ZERO:
        ytd_start_value = _best_effort_ytd_start_value(session, year_start, as_of)
    # Treat the start-of-year value as a synthetic "contribution" (negative).
    ytd_cashflows.insert(0, Cashflow(date=year_start, amount=-ytd_start_value))
    ytd_x = xirr(ytd_cashflows, as_of=as_of, terminal_value=total_value_eur)

    ytd_contributions = sum(
        (_txn_eur_amount(t) for t in ytd_txns if t.kind in _CONTRIBUTION_KINDS),
        start=ZERO,
    )
    ytd_withdrawals = sum(
        (_txn_eur_amount(t) for t in ytd_txns if t.kind in _WITHDRAWAL_KINDS),
        start=ZERO,
    )
    ytd_net_contrib = ytd_contributions + ytd_withdrawals
    if ytd_start_value + ytd_net_contrib > 0:
        ytd_growth = (total_value_eur - ytd_start_value - ytd_net_contrib) / (
            ytd_start_value + ytd_net_contrib
        )
    else:
        ytd_growth = None

    return PortfolioMetrics(
        as_of=as_of,
        total_value_eur=total_value_eur,
        total_contributions_eur=net_contributions_eur,
        total_dividends_cash_eur=dividends_cash_eur,
        capital_gain_eur=cap_gain,
        total_growth_pct=growth,
        xirr=portfolio_xirr,
        ytd_xirr=ytd_x,
        ytd_growth_pct=ytd_growth,
    )


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
