"""Query helpers for ``/deposits`` — summary KPIs + filtered table rows.

Only ``deposit`` / ``withdrawal`` / ``interest`` ledger rows count
(spec §8.2). All EUR-side numbers use ``net_eur`` when present and fall
back to ``net_native`` otherwise.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from investment_dashboard.models import Account, Transaction

_DEPOSIT_KINDS: tuple[str, ...] = ("deposit", "withdrawal", "interest")


@dataclass(frozen=True)
class DepositSummary:
    """Top-of-page KPI numbers (spec §8.2)."""

    total_contrib_native: Decimal
    total_contrib_eur: Decimal
    ytd_contrib_eur: Decimal
    mtd_contrib_eur: Decimal
    interest_ytd_eur: Decimal


@dataclass(frozen=True)
class DepositRecord:
    """Raw (unformatted) cash-flow row.

    The presentation-free counterpart of the dicts returned by
    :func:`list_deposit_rows`. Front-ends that format their own numbers
    (e.g. the JSON API / mobile app) consume these directly so the
    fetch/filter logic stays in one place.
    """

    id: int | None
    date: date
    account_label: str
    native_currency: str
    kind: str
    amount_native: Decimal
    amount_eur: Decimal
    description: str


def _amount_eur(t: Transaction) -> Decimal:
    if t.net_eur is not None:
        return t.net_eur
    return t.net_native or Decimal(0)


def _signed_contrib(t: Transaction) -> Decimal:
    """Return amount that counts as net contribution (deposits positive,
    withdrawals negative). Interest is *not* counted as a contribution
    even though it appears on this page.
    """
    amount = _amount_eur(t)
    if t.kind == "deposit":
        return amount
    if t.kind == "withdrawal":
        return -amount
    return Decimal(0)


def list_deposit_records(
    session: Session, *, account_id: int | None = None
) -> list[DepositRecord]:
    """Return raw cash-flow records for the table (newest first)."""
    stmt = (
        select(Transaction)
        .options(joinedload(Transaction.account))
        .where(Transaction.kind.in_(_DEPOSIT_KINDS))
        .order_by(Transaction.date.desc(), Transaction.id.desc())
    )
    if account_id is not None:
        stmt = stmt.where(Transaction.account_id == account_id)
    return [_to_record(t) for t in session.scalars(stmt).all()]


def list_deposit_rows(session: Session, *, account_id: int | None = None) -> list[dict[str, Any]]:
    """Return cash-flow rows for the table (newest first)."""
    return [_format_record(r) for r in list_deposit_records(session, account_id=account_id)]


def _to_record(t: Transaction) -> DepositRecord:
    account: Account | None = t.account  # type: ignore[assignment]
    return DepositRecord(
        id=t.id,
        date=t.date,
        account_label=account.account_label if account else "",
        native_currency=account.native_currency if account else "",
        kind=t.kind,
        amount_native=t.net_native or Decimal(0),
        amount_eur=_amount_eur(t),
        description=t.description or "",
    )


def _format_record(r: DepositRecord) -> dict[str, Any]:
    return {
        "id": r.id,
        "date": r.date.isoformat(),
        "account": r.account_label,
        "kind": r.kind,
        "amount_native": f"{r.amount_native:,.2f}",
        "currency": r.native_currency,
        "amount_eur": f"{r.amount_eur:,.2f}",
        "description": r.description,
    }


def compute_summary(session: Session, *, today: date | None = None) -> DepositSummary:
    """Aggregate the four KPI numbers shown at the top of the page."""
    today = today or date.today()
    year_start = date(today.year, 1, 1)
    month_start = date(today.year, today.month, 1)

    stmt = select(Transaction).where(Transaction.kind.in_(_DEPOSIT_KINDS))
    txns: Sequence[Transaction] = session.scalars(stmt).all()

    total_native = sum(
        (t.net_native or Decimal(0) for t in txns if t.kind == "deposit"),
        Decimal(0),
    ) - sum(
        (t.net_native or Decimal(0) for t in txns if t.kind == "withdrawal"),
        Decimal(0),
    )
    total_eur = sum((_signed_contrib(t) for t in txns), Decimal(0))
    ytd = sum(
        (_signed_contrib(t) for t in txns if t.date >= year_start),
        Decimal(0),
    )
    mtd = sum(
        (_signed_contrib(t) for t in txns if t.date >= month_start),
        Decimal(0),
    )
    interest_ytd = sum(
        (_amount_eur(t) for t in txns if t.kind == "interest" and t.date >= year_start),
        Decimal(0),
    )
    return DepositSummary(
        total_contrib_native=total_native,
        total_contrib_eur=total_eur,
        ytd_contrib_eur=ytd,
        mtd_contrib_eur=mtd,
        interest_ytd_eur=interest_ytd,
    )
