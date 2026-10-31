"""FX conversion repository: CRUD on ``fx_conversions`` plus the USD deposit query."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from investment_dashboard.models import Account, Transaction
from investment_dashboard.models.fx_conversion import FxConversion

#: External-contribution kinds (mirrors ``metrics_service._CONTRIBUTION_KINDS``).
CONTRIBUTION_KINDS = ("deposit", "transfer_in")


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
) -> FxConversion:
    row = FxConversion(
        date=on, eur_sent=eur_sent, usd_received=usd_received, fees_eur=fees_eur, note=note
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
) -> FxConversion:
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
