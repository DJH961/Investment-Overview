"""Positions service — derive current holdings from the transaction ledger.

Maintains no state of its own; every call rolls up :class:`Transaction`
rows on the fly. v1.1 will introduce a ``snapshots`` cache (spec §4.1).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.models import (
    Account,
    Instrument,
    Transaction,
    TransactionKind,
)
from investment_dashboard.repositories import (
    accounts_repo,
    instrument_overrides_repo,
    instruments_repo,
    transactions_repo,
)
from investment_dashboard.domain.money_market import MONEY_MARKET_NAV, is_money_market
from investment_dashboard.services import fx_service, prices_service
from investment_dashboard.services.instrument_enrichment_service import (
    EffectiveInstrument,
    effective_instrument,
)

ZERO = Decimal(0)


@dataclass(frozen=True)
class Position:
    """Snapshot of one (account, instrument) holding as of a date."""

    account: Account
    instrument: Instrument
    shares: Decimal
    cost_basis_native: Decimal
    current_price_native: Decimal | None
    current_value_native: Decimal
    current_value_eur: Decimal
    cumulative_dividends_cash_native: Decimal
    #: User-tier annotations composed from the config-tier
    #: ``instrument_overrides`` table. Default to "no category" / "active".
    category: str | None = None
    instrument_active: bool = True
    #: Override-merged view of the instrument. Read paths should prefer
    #: ``effective.name`` / ``effective.asset_class`` /
    #: ``effective.expense_ratio`` over the ledger row, so phase-(b)
    #: user corrections show up consistently in tables, treemaps, and
    #: analytics. ``None`` only on the pre-v2.2 in-memory paths that
    #: build a ``Position`` directly without an effective view.
    effective: EffectiveInstrument | None = None


def compute_positions(session: Session, *, as_of: date | None = None) -> list[Position]:  # noqa: PLR0912
    """Return one :class:`Position` per non-zero (account, instrument) pair.

    Cash-account holdings (Savings) appear with ``shares = 1`` and
    ``current_value = current_price`` (the price column stores the daily
    balance, per spec §4.1 ``price_history``).
    """
    as_of = as_of or date.today()
    is_historical = as_of < date.today()
    txns = transactions_repo.list_transactions(session, end=as_of)

    # Cash dividends that were immediately reinvested arrive as a pair of
    # ledger rows (DIVIDEND_CASH + DIVIDEND_REINVEST, same instrument & date).
    # The reinvested shares already raise both the share count and the cost
    # basis, so counting the cash leg as income too would double-count it in
    # the capital gain (spec §6.1, returns.capital_gain). Track which
    # (account, instrument, date) keys carry a reinvestment so the matching
    # cash leg can be skipped.
    reinvest_keys: set[tuple[int, int | None, date]] = {
        (t.account_id, t.instrument_id, t.date)
        for t in txns
        if t.kind == TransactionKind.DIVIDEND_REINVEST.value
    }

    # Aggregate by (account_id, instrument_id).
    holdings: dict[tuple[int, int | None], dict[str, Decimal]] = {}
    for t in txns:
        key = (t.account_id, t.instrument_id)
        agg = holdings.setdefault(
            key,
            {"shares": ZERO, "cost_basis": ZERO, "dividends_cash": ZERO},
        )
        kind = t.kind
        qty = t.quantity or ZERO
        net = t.net_native or ZERO
        if kind == TransactionKind.BUY.value:
            agg["shares"] += qty
            agg["cost_basis"] += -net  # buy net is negative ⇒ cost positive
        elif kind == TransactionKind.SELL.value:
            # Average-cost method: a partial sale releases a proportional
            # slice of the cost basis, otherwise the remaining shares keep
            # the *full* original basis and growth is massively deflated
            # (spec §6.5). ``qty`` is already negative for sells.
            shares_before = agg["shares"]
            if shares_before > ZERO:
                avg_cost = agg["cost_basis"] / shares_before
                # qty negative ⇒ this subtracts the sold shares' basis.
                agg["cost_basis"] += avg_cost * qty
                if agg["cost_basis"] < ZERO:
                    agg["cost_basis"] = ZERO
            agg["shares"] += qty
        elif kind == TransactionKind.DIVIDEND_REINVEST.value:
            agg["shares"] += qty
            # Reinvested dividends raise the cost basis by the reinvestment
            # value (spec §6.1).
            if t.price_native is not None:
                agg["cost_basis"] += qty * t.price_native
        elif kind == TransactionKind.DIVIDEND_CASH.value:
            # Skip the cash leg of a reinvested dividend (already captured by
            # the paired DIVIDEND_REINVEST as new shares + cost basis).
            if (t.account_id, t.instrument_id, t.date) not in reinvest_keys:
                agg["dividends_cash"] += net
        elif kind == TransactionKind.SPLIT.value:
            agg["shares"] += qty

    accounts_by_id = {a.id: a for a in accounts_repo.list_accounts(session)}
    instruments_by_id = {i.id: i for i in instruments_repo.list_instruments(session)}
    overrides = instrument_overrides_repo.get_override_map(session, instruments_by_id.keys())

    fx_rate_today = fx_service.get_rate_eur_to_quote(session, as_of) or Decimal(1)

    results: list[Position] = []
    for (account_id, instrument_id), agg in holdings.items():
        if instrument_id is None:
            continue  # cash-only transaction; rolled up by cash service later
        if agg["shares"] == ZERO and agg["cost_basis"] == ZERO:
            continue
        account = accounts_by_id[account_id]
        instr = instruments_by_id[instrument_id]
        eff = effective_instrument(instr, overrides.get(instr.id))
        # Money-market / settlement funds (VMFXX, SPAXX …) hold uninvested
        # cash at a constant $1.00 NAV and have no tradeable price feed. Price
        # them at par so their value reflects the cash balance instead of
        # collapsing to zero (which understated closing values and inflated
        # their growth %).
        if is_money_market(instr.symbol, asset_class=eff.asset_class, name=eff.name):
            current_price: Decimal | None = MONEY_MARKET_NAV
        # Historical valuations must use the close that was in effect on
        # ``as_of`` (forward-filled), not today's price — otherwise YTD/MTD
        # start values and the equity curve are all priced at today's close.
        # For "today" we keep ``latest_close`` so intraday refreshes show.
        elif is_historical:
            current_price = prices_service.close_as_of(session, instr.id, as_of)
        else:
            current_price = prices_service.latest_close(session, instr.id)
        current_value_native = agg["shares"] * current_price if current_price is not None else ZERO
        # Currency conversion to EUR.
        if account.native_currency == "EUR":
            current_value_eur = current_value_native
        elif fx_rate_today != 0:
            current_value_eur = current_value_native / fx_rate_today
        else:
            current_value_eur = ZERO
        results.append(
            Position(
                account=account,
                instrument=instr,
                shares=agg["shares"],
                cost_basis_native=agg["cost_basis"],
                current_price_native=current_price,
                current_value_native=current_value_native,
                current_value_eur=current_value_eur,
                cumulative_dividends_cash_native=agg["dividends_cash"],
                category=(overrides[instr.id].category if instr.id in overrides else None),
                instrument_active=(overrides[instr.id].active if instr.id in overrides else True),
                effective=eff,
            )
        )
    results.sort(key=lambda p: (p.account.broker, p.instrument.symbol))
    return results


def compute_cash_balance(
    session: Session,
    account_id: int,
    *,
    as_of: date | None = None,
) -> Decimal:
    """Sum every cash-leg transaction in ``account_id`` up to ``as_of``.

    Buys reduce cash (``net_native < 0``), deposits/dividends/interest/
    sells increase it. This is the "cash core" balance — used for the
    Direct savings account, and for showing uninvested cash on the
    brokerage accounts.
    """
    as_of = as_of or date.today()
    txns = transactions_repo.list_transactions(session, account_id=account_id, end=as_of)
    total = ZERO
    for t in txns:
        net = t.net_native or ZERO
        total += net
    return total


def total_portfolio_value(session: Session, *, as_of: date | None = None) -> Decimal:
    """Sum of all positions' EUR value + Savings cash balance in EUR."""
    as_of = as_of or date.today()
    total_eur = sum(
        (p.current_value_eur for p in compute_positions(session, as_of=as_of)), start=ZERO
    )

    fx_rate = fx_service.get_rate_eur_to_quote(session, as_of) or Decimal(1)
    for account in accounts_repo.list_accounts(session):
        if account.account_type not in {"savings", "cash"}:
            continue
        balance_native = compute_cash_balance(session, account.id, as_of=as_of)
        if account.native_currency == "EUR":
            total_eur += balance_native
        elif fx_rate != 0:
            total_eur += balance_native / fx_rate
    return total_eur


def _ignored_account_for_typing(_: Transaction) -> None:  # pragma: no cover
    """Touch :class:`Transaction` so the import isn't pruned by linters."""
