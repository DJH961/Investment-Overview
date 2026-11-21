"""FX conversion repository: CRUD on ``fx_conversions`` plus the USD deposit query."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.orm import Session

from investment_dashboard.domain import kinds
from investment_dashboard.models import Account, Transaction
from investment_dashboard.models.fx_conversion import FxConversion, FxConversionPin

#: External-contribution kinds (canonical set lives in ``domain.kinds``).
CONTRIBUTION_KINDS = tuple(sorted(kinds.CONTRIBUTION_KINDS))


@dataclass(frozen=True)
class DepositRow:
    id: int
    date: date
    usd: Decimal


def list_all(session: Session) -> Sequence[FxConversion]:
    stmt = select(FxConversion).order_by(FxConversion.date, FxConversion.id)
    return session.scalars(stmt).all()


def get(session: Session, conversion_id: int) -> FxConversion | None:
    return session.get(FxConversion, conversion_id)


def add(
    session: Session,
    *,
    on: date,
    eur_sent: Decimal,
    usd_received: Decimal,
    fees_eur: Decimal | None,
    note: str | None,
    provider: str | None = None,
    from_ccy: str = "EUR",
    to_ccy: str = "USD",
) -> FxConversion:
    row = FxConversion(
        date=on,
        eur_sent=eur_sent,
        usd_received=usd_received,
        fees_eur=fees_eur,
        note=note,
        provider=provider,
        from_ccy=from_ccy,
        to_ccy=to_ccy,
    )
    session.add(row)
    session.flush()
    session.refresh(row)
    return row


def update(
    session: Session,
    row: FxConversion,
    *,
    on: date,
    eur_sent: Decimal,
    usd_received: Decimal,
    fees_eur: Decimal | None,
    note: str | None,
    provider: str | None = None,
    from_ccy: str = "EUR",
    to_ccy: str = "USD",
) -> FxConversion:
    row.provider = provider
    row.from_ccy = from_ccy
    row.to_ccy = to_ccy
    row.date = on
    row.eur_sent = eur_sent
    row.usd_received = usd_received
    row.fees_eur = fees_eur
    row.note = note
    session.flush()
    session.refresh(row)
    return row


def delete(session: Session, row: FxConversion) -> None:
    session.delete(row)
    session.flush()


def list_usd_contribution_deposits(session: Session) -> list[DepositRow]:
    """Positive deposit/transfer_in transactions on USD-native accounts."""
    stmt = (
        select(Transaction.id, Transaction.date, Transaction.net_native)
        .join(Account, Account.id == Transaction.account_id)
        .where(
            Account.native_currency == "USD",
            Transaction.kind.in_(CONTRIBUTION_KINDS),
            Transaction.net_native.is_not(None),
            Transaction.net_native > 0,
        )
        .order_by(Transaction.date, Transaction.id)
    )
    return [DepositRow(i, d, n) for i, d, n in session.execute(stmt).all() if n is not None]


def list_pins(session: Session) -> Sequence[FxConversionPin]:
    stmt = select(FxConversionPin).order_by(
        FxConversionPin.deposit_txn_id, FxConversionPin.conversion_id
    )
    return session.scalars(stmt).all()


def replace_pins(
    session: Session, deposit_txn_id: int, pins: Sequence[tuple[int, Decimal]]
) -> None:
    """Replace every pin of one deposit with (conversion_id, usd) pairs."""
    session.execute(
        sa_delete(FxConversionPin).where(FxConversionPin.deposit_txn_id == deposit_txn_id)
    )
    session.add_all(
        FxConversionPin(deposit_txn_id=deposit_txn_id, conversion_id=cid, usd=usd)
        for cid, usd in pins
    )
    session.flush()


def delete_pins(session: Session, deposit_txn_id: int) -> int:
    result = session.execute(
        sa_delete(FxConversionPin).where(FxConversionPin.deposit_txn_id == deposit_txn_id)
    )
    session.flush()
    return int(getattr(result, "rowcount", 0) or 0)


def get_transaction_date(session: Session, txn_id: int) -> date | None:
    return session.scalar(select(Transaction.date).where(Transaction.id == txn_id))
