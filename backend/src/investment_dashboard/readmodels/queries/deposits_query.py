"""Query helpers for ``/deposits`` — summary KPIs + filtered table rows.

Only ``deposit`` / ``withdrawal`` ledger rows count
(spec §8.2). Every EUR/USD leg comes from the canonical
:mod:`investment_dashboard.services.cashflows` module.

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

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from investment_dashboard.models import Account, Transaction
from investment_dashboard.services import cashflows, fx_service

_DEPOSIT_KINDS: tuple[str, ...] = (
    "deposit",
    "withdrawal",
    "transfer_in",
    "transfer_out",
)

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
    eur_to_usd: dict[date, Decimal],
    eur_overrides: Mapping[int, Decimal] | None = None,
) -> tuple[Decimal | None, Decimal | None]:
    """``(eur, usd)`` value of ``t`` on its trade date (canonical, see
    :mod:`investment_dashboard.services.cashflows`).

    ``None`` for a leg that cannot be derived (no rate on file); aggregates skip
    it and the table shows a blank rather than a made-up number.
    """
    return (
        cashflows.txn_eur_amount(t, eur_to_usd=eur_to_usd, eur_overrides=eur_overrides),
        cashflows.txn_usd_amount(t, eur_to_usd=eur_to_usd),
    )


def _signed_contrib(amount: Decimal | None, kind: str) -> Decimal:
    """Net-contribution share of a signed leg (EUR or USD).

    The leg is already **signed** at write time (deposits/transfer_in
    positive, withdrawals/transfer_out negative), so the four external-flow
    kinds are summed verbatim. Interest is *not* a contribution even though it
    appears on this page. A leg that could not be derived (``None``) is skipped.
    """
    if amount is None:
        return ZERO
    if kind in cashflows.EXTERNAL_FLOW_KINDS:
        return amount
    return ZERO


def list_deposit_records(
    session: Session,
    *,
    account_id: int | None = None,
    eur_overrides: Mapping[int, Decimal] | None = None,
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
    txns = session.scalars(stmt).all()
    eur_to_usd = fx_service.get_rates(session, base="EUR", quote="USD")
    ov = eur_overrides if eur_overrides is not None else cashflows.eur_overrides_for(session)
    return [_to_record(t, eur_to_usd=eur_to_usd, eur_overrides=ov) for t in txns]


def list_deposit_rows(session: Session, *, account_id: int | None = None) -> list[dict[str, Any]]:
    """Return cash-flow rows for the table (newest first)."""
    return [_format_record(r) for r in list_deposit_records(session, account_id=account_id)]


def _to_record(
    t: Transaction,
    *,
    eur_to_usd: dict[date, Decimal],
    eur_overrides: Mapping[int, Decimal] | None = None,
) -> DepositRecord:
    account: Account | None = t.account  # type: ignore[assignment]
    native_ccy = account.native_currency if account else ""
    amount_eur, amount_usd = _amounts(t, eur_to_usd=eur_to_usd, eur_overrides=eur_overrides)
    return DepositRecord(
        id=t.id,
        date=t.date,
        account_label=account.account_label if account else "",
        native_currency=native_ccy,
        kind=t.kind,
        amount_native=t.net_native or ZERO,
        # The response schema keeps ``amount_eur`` non-null; an underivable EUR leg
        # is shown as 0.00 (only possible for non-EUR/USD rows without a frozen leg).
        amount_eur=amount_eur if amount_eur is not None else ZERO,
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


def compute_summary(
    session: Session,
    *,
    today: date | None = None,
    eur_overrides: Mapping[int, Decimal] | None = None,
) -> DepositSummary:
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
    eur_to_usd = fx_service.get_rates(session, base="EUR", quote="USD")
    ov = eur_overrides if eur_overrides is not None else cashflows.eur_overrides_for(session)

    total_native = sum(
        (
            t.net_native or ZERO
            for t in txns
            if t.kind in ("deposit", "transfer_in", "withdrawal", "transfer_out")
        ),
        ZERO,
    )

    # Per-trade-date EUR + USD legs for every row, computed once.
    by_txn: list[tuple[Transaction, Decimal | None, Decimal | None]] = [
        (t, *_amounts(t, eur_to_usd=eur_to_usd, eur_overrides=ov)) for t in txns
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

    total_usd = sum((_signed_contrib(usd, t.kind) for t, _, usd in by_txn), ZERO)
    ytd_usd = sum(
        (_signed_contrib(usd, t.kind) for t, _, usd in by_txn if t.date >= year_start),
        ZERO,
    )
    mtd_usd = sum(
        (_signed_contrib(usd, t.kind) for t, _, usd in by_txn if t.date >= month_start),
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
