"""Manual transaction create / edit / delete (extracted from the NiceGUI page).

Orchestrates the write path for hand-entered ledger rows: reconcile the
quantity / price / total the user typed, apply the kind's sign, freeze the EUR
and USD legs at the trade-date rate, insert or update the row, and keep the
paired money-market settlement leg (``:vmfxx`` external-id convention) in
lock-step. Pure maths lives in :mod:`manual_entry`; this module adds the DB
orchestration. No UI imports.

Imported rows are editable too (as in v5): the settlement leg is found through
the pre-edit identity, so an imported cash move and its sweep stay paired.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.domain.money_market import (
    MANUAL_SETTLEMENT_DESCRIPTION_PREFIX,
    settlement_external_id_for,
)
from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionKind, TransactionSource
from investment_dashboard.repositories import accounts_repo, instruments_repo, transactions_repo
from investment_dashboard.services import (
    intraday_snapshots_service,
    manual_entry,
    snapshots_service,
    transaction_fx_service,
)

NO_MONEY_MARKET_WARNING = "No money-market fund on this account yet - logged the cash move only."


class TransactionEditError(ValueError):
    """The submitted transaction is invalid (maps to HTTP 422)."""


class TransactionNotFoundError(LookupError):
    """No transaction (or account) with the given id."""


@dataclass(frozen=True)
class TransactionInput:
    """What the user typed: positive magnitudes, the server applies signs."""

    account_id: int
    date: date
    kind: str
    symbol: str | None = None
    quantity: Decimal | None = None
    price: Decimal | None = None
    total: Decimal | None = None
    fees: Decimal | None = None
    description: str | None = None
    route_money_market: bool = False


@dataclass
class TransactionEditResult:
    transaction: Transaction
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class _Prepared:
    fields: dict[str, object]
    net_native: Decimal | None
    native_ccy: str
    warnings: list[str]


def _prepare(session: Session, data: TransactionInput) -> _Prepared:
    try:
        kind = TransactionKind(data.kind).value
    except ValueError as exc:
        raise TransactionEditError(f"Unknown transaction kind {data.kind!r}") from exc
    account = accounts_repo.get_account(session, data.account_id)
    if account is None:
        raise TransactionEditError(f"Unknown account_id={data.account_id}")
    symbol = (data.symbol or "").strip().upper()
    fee_mag = data.fees
    quantity: Decimal | None = None
    price_native: Decimal | None = None
    gross_native: Decimal | None = None
    if kind in manual_entry.TRADE_KINDS:
        if not symbol:
            raise TransactionEditError("A symbol is required for buys, sells and reinvestments")
        figs = manual_entry.reconcile_trade(data.quantity, data.price, data.total)
        if figs.error:
            raise TransactionEditError(figs.error)
        if figs.quantity is None or figs.price is None or figs.total is None:
            raise TransactionEditError("Enter at least two of quantity, price and total")
        gross = figs.total
        fee = abs(fee_mag) if fee_mag is not None else Decimal(0)
        # A buy/reinvest costs gross + fees; a sale nets gross - fees.
        net_mag = gross - fee if kind == TransactionKind.SELL.value else gross + fee
        net_native = manual_entry.signed_net(kind, net_mag)
        quantity = manual_entry.signed_quantity(kind, figs.quantity)
        price_native = abs(figs.price)
        gross_native = gross
    else:
        if manual_entry.net_sign(kind) != 0 and data.total is None:
            raise TransactionEditError("An amount (total) is required for this kind")
        # Cash-only kind: the "total" is the cash amount.
        net_native = manual_entry.signed_net(kind, data.total)

    native_ccy = account.native_currency
    instrument_id: int | None = None
    if symbol:
        instrument_id = instruments_repo.get_or_create(session, symbol=symbol).id
    legs = transaction_fx_service.compute_legs(
        session, native_currency=native_ccy, net_native=net_native, on=data.date
    )
    warnings: list[str] = []
    if not legs.complete:
        warnings.append(
            f"FX rate missing for {data.date.isoformat()}: the EUR/USD legs are incomplete "
            "and will be backfilled once rates are available."
        )
    fields: dict[str, object] = {
        "account_id": data.account_id,
        "date": data.date,
        "kind": kind,
        "instrument_id": instrument_id,
        "quantity": quantity,
        "price_native": price_native,
        "gross_native": gross_native,
        "fees_native": abs(fee_mag) if fee_mag is not None else None,
        "net_native": net_native,
        "fx_rate_to_eur": legs.fx_rate_to_eur,
        "net_eur": legs.net_eur,
        "net_usd": legs.net_usd,
        "description": (data.description or "").strip() or None,
    }
    return _Prepared(fields, net_native, native_ccy, warnings)


def _after_write(session: Session, affected: set[date]) -> None:
    snapshots_service.invalidate_for_trade_dates(session, affected)
    intraday_snapshots_service.clear_week_samples(session)


def create(session: Session, data: TransactionInput) -> TransactionEditResult:
    """Insert a manual transaction (and optionally its money-market leg)."""
    prep = _prepare(session, data)
    txn = Transaction(source=TransactionSource.MANUAL, **prep.fields)
    inserted = transactions_repo.insert_transaction(session, txn)
    if inserted is None:  # pragma: no cover - manual rows carry no external_id
        raise TransactionEditError("Duplicate transaction")
    warnings = list(prep.warnings)
    if data.route_money_market and manual_entry.money_market_leg(data.kind, prep.net_native):
        wrote = maybe_money_market_leg(
            session,
            parent=inserted,
            kind=data.kind,
            net_native=prep.net_native,
            native_ccy=prep.native_ccy,
            txn_date=data.date,
        )
        if not wrote:
            warnings.append(NO_MONEY_MARKET_WARNING)
    _after_write(session, {data.date})
    return TransactionEditResult(inserted, warnings)


def update(session: Session, txn_id: int, data: TransactionInput) -> TransactionEditResult:
    """Replace the editable fields of ``txn_id`` and re-sync its settlement leg."""
    existing = transactions_repo.get_transaction(session, txn_id)
    if existing is None:
        raise TransactionNotFoundError(f"Transaction {txn_id} not found")
    old_account_id = existing.account_id
    old_external_id = existing.external_id
    old_date = existing.date
    old_net_native = existing.net_native
    prep = _prepare(session, data)
    updated = transactions_repo.update_transaction(session, txn_id, **prep.fields)
    if updated is None:  # pragma: no cover - checked above
        raise TransactionNotFoundError(f"Transaction {txn_id} not found")
    # Keep the paired (often hidden) settlement leg in lock-step with the cash it
    # mirrors, so an edit can't silently diverge the money-market balance.
    resync_settlement_leg(
        session,
        parent=updated,
        old_account_id=old_account_id,
        old_external_id=old_external_id,
        old_date=old_date,
        old_net_native=old_net_native,
        native_ccy=prep.native_ccy,
    )
    _after_write(session, {data.date, old_date})
    return TransactionEditResult(updated, list(prep.warnings))


def delete(session: Session, txn_id: int) -> bool:
    """Delete ``txn_id`` and its paired settlement leg. ``False`` if not found."""
    parent = transactions_repo.get_transaction(session, txn_id)
    if parent is None:
        return False
    parent_date = parent.date
    leg = find_existing_settlement_leg(
        session,
        account_id=parent.account_id,
        external_id=parent.external_id,
        on=parent.date,
        net_native=parent.net_native,
    )
    if leg is not None and leg.id != parent.id:
        session.delete(leg)
        session.flush()
    transactions_repo.delete_transaction(session, txn_id)
    _after_write(session, {parent_date})
    return True


def maybe_money_market_leg(
    session: Session,
    *,
    parent: Transaction,
    kind: str,
    net_native: Decimal | None,
    native_ccy: str,
    txn_date: date,
) -> bool:
    """Create the paired money-market settlement leg for a cash move.

    Returns ``True`` when a leg was written. The leg is linked to ``parent`` via
    the ``:vmfxx`` external-id convention so a later edit/delete of the parent
    can find it (and so the ledger hides it by default, like importer sweeps).
    """
    leg = manual_entry.money_market_leg(kind, net_native)
    if leg is None:
        return False
    mm_instrument = transactions_repo.find_account_money_market_instrument(
        session, parent.account_id
    )
    if mm_instrument is None:
        return False
    # Give the parent a stable external_id (if it has none) so the leg can be
    # linked to it; manual rows otherwise carry no external_id.
    if parent.external_id is None:
        parent.external_id = f"manual:{parent.id}"
        session.flush()
    leg_legs = transaction_fx_service.compute_legs(
        session, native_currency=native_ccy, net_native=leg.net_native, on=txn_date
    )
    mm_txn = Transaction(
        account_id=parent.account_id,
        date=txn_date,
        kind=leg.kind,
        instrument_id=mm_instrument.id,
        quantity=leg.quantity,
        price_native=leg.price,
        net_native=leg.net_native,
        fx_rate_to_eur=leg_legs.fx_rate_to_eur,
        net_eur=leg_legs.net_eur,
        net_usd=leg_legs.net_usd,
        description=f"{MANUAL_SETTLEMENT_DESCRIPTION_PREFIX} · {mm_instrument.symbol}",
        external_id=settlement_external_id_for(parent.external_id),
        source=TransactionSource.MANUAL,
    )
    return transactions_repo.insert_transaction(session, mm_txn) is not None


def find_existing_settlement_leg(
    session: Session,
    *,
    account_id: int,
    external_id: str | None,
    on: date,
    net_native: Decimal | None,
) -> Transaction | None:
    """Locate the settlement leg paired to a parent, new or legacy.

    First tries the ``:vmfxx`` external-id link (imported rows and post-v3.2.0
    manual rows); falls back to matching a legacy manual auto-leg by its
    description marker, account, date and opposite ``net_native``.
    """
    leg = transactions_repo.find_settlement_leg(
        session, account_id=account_id, parent_external_id=external_id
    )
    if leg is not None:
        return leg
    if net_native is None:
        return None
    return transactions_repo.find_legacy_settlement_leg(
        session, account_id=account_id, on=on, parent_net_native=net_native
    )


def resync_settlement_leg(
    session: Session,
    *,
    parent: Transaction,
    old_account_id: int,
    old_external_id: str | None,
    old_date: date,
    old_net_native: Decimal | None,
    native_ccy: str,
) -> None:
    """Re-derive the parent's settlement leg after an edit, or drop it.

    Found via the *pre-edit* identity. If the edited parent no longer moves
    cash the leg is deleted; otherwise its date, account, kind, quantity and
    frozen FX legs are recomputed so the settlement balance never drifts.
    """
    leg = find_existing_settlement_leg(
        session,
        account_id=old_account_id,
        external_id=old_external_id,
        on=old_date,
        net_native=old_net_native,
    )
    if leg is None or leg.id == parent.id:
        return
    values = manual_entry.settlement_leg_values(parent.net_native)
    if values is None:
        session.delete(leg)
        session.flush()
        return
    leg_legs = transaction_fx_service.compute_legs(
        session, native_currency=native_ccy, net_native=values.net_native, on=parent.date
    )
    leg.account_id = parent.account_id
    leg.date = parent.date
    leg.kind = values.kind
    leg.quantity = values.quantity
    leg.price_native = values.price
    leg.net_native = values.net_native
    leg.fx_rate_to_eur = leg_legs.fx_rate_to_eur
    leg.net_eur = leg_legs.net_eur
    leg.net_usd = leg_legs.net_usd
    session.flush()
