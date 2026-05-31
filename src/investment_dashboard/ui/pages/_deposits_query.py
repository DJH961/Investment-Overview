"""Query helpers for ``/deposits`` — summary KPIs + filtered table rows.

Only ``deposit`` / ``withdrawal`` ledger rows count
(spec §8.2). EUR-side numbers use ``net_eur`` when present and fall
back to ``net_native`` otherwise.

v2.4 made every column **FX-aware per trade date**: the USD totals on
the KPI cards and the per-row "Amount (USD)" column are computed by
walking each transaction and converting *that day's* EUR amount with
the EUR→USD rate that was in force *on that day*. This matters
because v2.3 multiplied the EUR total by today's spot, which silently
"double-converted" any deposit that was originally booked in USD
(USD → EUR at trade-date FX → USD at today's spot), so the page
displayed a number that didn't match the actual cash the user moved.
USD-native deposits short-circuit the FX lookup entirely and use
``net_native`` so we never round-trip them through EUR.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from investment_dashboard.domain.currency import (
    dual_currency_amounts,
    lookup_rate_with_forward_fill,
)
from investment_dashboard.models import Account, Transaction
from investment_dashboard.repositories import fx_repo

_DEPOSIT_KINDS: tuple[str, ...] = ("deposit", "withdrawal")

ZERO = Decimal(0)


@dataclass(frozen=True)
class DepositSummary:
    """Top-of-page KPI numbers (spec §8.2).

    ``*_eur`` fields are the ledger's EUR amounts (trade-date FX
    locked in by the importer). ``*_usd`` fields are the same metric
    re-aggregated by converting each transaction's EUR amount with the
    EUR→USD rate **on that transaction's date** (USD-native deposits
    use ``net_native`` directly so we never round-trip them through
    EUR). ``total_contrib_native`` remains a single Decimal for
    backwards compatibility but is only meaningful when the user has
    a single-currency portfolio; mixed-currency users should consult
    the EUR or USD totals.
    """

    total_contrib_native: Decimal
    total_contrib_eur: Decimal
    ytd_contrib_eur: Decimal
    mtd_contrib_eur: Decimal
    total_contrib_usd: Decimal
    ytd_contrib_usd: Decimal
    mtd_contrib_usd: Decimal


@dataclass(frozen=True)
class DepositRecord:
    """Raw (unformatted) cash-flow row.

    The presentation-free counterpart of the dicts returned by
    :func:`list_deposit_rows`. Front-ends that format their own numbers
    (e.g. the JSON API / mobile app) consume these directly so the
    fetch/filter logic stays in one place.

    ``amount_usd`` is the actual USD value of the cashflow on its own
    date — :data:`None` only when neither the account was USD-native
    nor a EUR→USD rate is on file (or has been forward-fillable) for
    that date.
    """

    id: int | None
    date: date
    account_label: str
    native_currency: str
    kind: str
    amount_native: Decimal
    amount_eur: Decimal
    amount_usd: Decimal | None
    description: str


def _amounts(
    t: Transaction,
    *,
    native_currency: str,
    eur_to_usd: dict[date, Decimal],
    fallback_rate: Decimal | None = None,
) -> tuple[Decimal, Decimal | None]:
    """``(eur, usd)`` value of ``t`` on its trade date.

    Both legs come from the EUR→USD rate in force on the transaction's date
    (forward-filled), so a USD-native deposit shows the EUR it was actually
    worth that day instead of mirroring the USD figure at parity. The EUR leg
    falls back to :data:`ZERO` (rather than :data:`None`) so the contribution
    aggregates stay summable even when FX history can't price a row.
    """
    eur, usd = dual_currency_amounts(
        native_currency=native_currency,
        net_native=t.net_native,
        net_eur=t.net_eur,
        net_usd=t.net_usd,
        on=t.date,
        eur_to_usd=eur_to_usd,
        fallback_rate=fallback_rate,
    )
    return (eur if eur is not None else ZERO), usd


def _amount_eur(
    t: Transaction,
    *,
    native_currency: str,
    eur_to_usd: dict[date, Decimal],
) -> Decimal:
    return _amounts(t, native_currency=native_currency, eur_to_usd=eur_to_usd)[0]


def _amount_usd(
    t: Transaction,
    *,
    native_currency: str,
    eur_to_usd: dict[date, Decimal],
) -> Decimal | None:
    """USD value of ``t`` on its trade date (see :func:`_amounts`)."""
    return _amounts(t, native_currency=native_currency, eur_to_usd=eur_to_usd)[1]


def _signed_contrib(amount_eur: Decimal, kind: str) -> Decimal:
    """Return the EUR amount that counts as net contribution (deposits
    positive, withdrawals negative). Interest is *not* counted as a
    contribution even though it appears on this page.
    """
    if kind == "deposit":
        return amount_eur
    if kind == "withdrawal":
        return -amount_eur
    return ZERO


def _signed_contrib_usd(amount_usd: Decimal | None, kind: str) -> Decimal:
    """USD-side signed contribution, mirroring :func:`_signed_contrib`.

    Returns :data:`ZERO` rather than skipping the row when ``amount_usd``
    is :data:`None`; the caller would have no way to distinguish "no
    FX rate available" from "true zero contribution" otherwise. This
    is conservative — the KPI undercounts contributions only when FX
    history is sparse, which the boot refresh now backfills to the
    earliest transaction date.
    """
    if amount_usd is None:
        return ZERO
    if kind == "deposit":
        return amount_usd
    if kind == "withdrawal":
        return -amount_usd
    return ZERO


def list_deposit_records(session: Session, *, account_id: int | None = None) -> list[DepositRecord]:
    """Return raw cash-flow records for the table (newest first)."""
    stmt = (
        select(Transaction)
        .options(joinedload(Transaction.account))
        .where(Transaction.kind.in_(_DEPOSIT_KINDS))
        .order_by(Transaction.date.desc(), Transaction.id.desc())
    )
    if account_id is not None:
        stmt = stmt.where(Transaction.account_id == account_id)
    txns = session.scalars(stmt).all()
    eur_to_usd = fx_repo.get_rates(session, base="EUR", quote="USD")
    fallback_rate = lookup_rate_with_forward_fill(eur_to_usd, date.today())
    return [_to_record(t, eur_to_usd=eur_to_usd, fallback_rate=fallback_rate) for t in txns]


def list_deposit_rows(session: Session, *, account_id: int | None = None) -> list[dict[str, Any]]:
    """Return cash-flow rows for the table (newest first)."""
    return [_format_record(r) for r in list_deposit_records(session, account_id=account_id)]


def _to_record(
    t: Transaction,
    *,
    eur_to_usd: dict[date, Decimal],
    fallback_rate: Decimal | None = None,
) -> DepositRecord:
    account: Account | None = t.account  # type: ignore[assignment]
    native_ccy = account.native_currency if account else ""
    amount_eur, amount_usd = _amounts(
        t,
        native_currency=native_ccy,
        eur_to_usd=eur_to_usd,
        fallback_rate=fallback_rate,
    )
    return DepositRecord(
        id=t.id,
        date=t.date,
        account_label=account.account_label if account else "",
        native_currency=native_ccy,
        kind=t.kind,
        amount_native=t.net_native or ZERO,
        amount_eur=amount_eur,
        amount_usd=amount_usd,
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
        "amount_eur": f"€{r.amount_eur:,.2f}",
        "amount_usd": (f"${r.amount_usd:,.2f}" if r.amount_usd is not None else ""),
        # AG-Grid tooltip field — preserves the native amount as the
        # third currency without burning a column (v2.5).
        "amount_native_tt": f"{r.amount_native:,.2f} {r.native_currency}",
        "description": r.description,
    }


def compute_summary(session: Session, *, today: date | None = None) -> DepositSummary:
    """Aggregate the KPI numbers shown at the top of the page.

    Both the EUR and USD aggregates are summed from per-row legs converted at
    each transaction's trade-date FX rate (see :func:`_amounts`) — never
    ``EUR_total × today_spot`` and never USD/EUR mirrored at parity, which is
    what made the cards drift as USD/EUR moved.
    """
    today = today or date.today()
    year_start = date(today.year, 1, 1)
    month_start = date(today.year, today.month, 1)

    stmt = (
        select(Transaction)
        .options(joinedload(Transaction.account))
        .where(Transaction.kind.in_(_DEPOSIT_KINDS))
    )
    txns: Sequence[Transaction] = session.scalars(stmt).all()
    eur_to_usd = fx_repo.get_rates(session, base="EUR", quote="USD")
    fallback_rate = lookup_rate_with_forward_fill(eur_to_usd, today)

    total_native = sum(
        (t.net_native or ZERO for t in txns if t.kind == "deposit"),
        ZERO,
    ) - sum(
        (t.net_native or ZERO for t in txns if t.kind == "withdrawal"),
        ZERO,
    )

    # Per-trade-date EUR + USD legs for every row, computed once.
    by_txn: list[tuple[Transaction, Decimal, Decimal | None]] = [
        (
            t,
            *_amounts(
                t,
                native_currency=(t.account.native_currency if t.account else ""),
                eur_to_usd=eur_to_usd,
                fallback_rate=fallback_rate,
            ),
        )
        for t in txns
    ]

    total_eur = sum((_signed_contrib(eur, t.kind) for t, eur, _ in by_txn), ZERO)
    ytd_eur = sum(
        (_signed_contrib(eur, t.kind) for t, eur, _ in by_txn if t.date >= year_start),
        ZERO,
    )
    mtd_eur = sum(
        (_signed_contrib(eur, t.kind) for t, eur, _ in by_txn if t.date >= month_start),
        ZERO,
    )

    total_usd = sum((_signed_contrib_usd(usd, t.kind) for t, _, usd in by_txn), ZERO)
    ytd_usd = sum(
        (_signed_contrib_usd(usd, t.kind) for t, _, usd in by_txn if t.date >= year_start),
        ZERO,
    )
    mtd_usd = sum(
        (_signed_contrib_usd(usd, t.kind) for t, _, usd in by_txn if t.date >= month_start),
        ZERO,
    )

    return DepositSummary(
        total_contrib_native=total_native,
        total_contrib_eur=total_eur,
        ytd_contrib_eur=ytd_eur,
        mtd_contrib_eur=mtd_eur,
        total_contrib_usd=total_usd,
        ytd_contrib_usd=ytd_usd,
        mtd_contrib_usd=mtd_usd,
    )
