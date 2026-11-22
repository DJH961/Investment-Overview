"""Smart import matching, service side: tolerances, classifying rows, applying updates.

``classify_rows`` sorts the rows of an import into **new**, **duplicate** (exact, as
before) and **update** (a near-match of an existing transaction, see
:mod:`domain.import_match`). ``apply_import_update`` is the one place an update
overwrites an existing transaction; the import wins, the row keeps its id (so
``fx_conversion_pins`` and other links survive).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import TYPE_CHECKING, Literal

from sqlalchemy.orm import Session

from investment_dashboard.activity_log import activity
from investment_dashboard.adapters.importer_types import ParsedTransactionRow
from investment_dashboard.domain.import_match import (
    ESTIMATED_TOLERANCE,
    PROFILE_ESTIMATED,
    PROFILE_NORMAL,
    MatchTolerance,
    TxnFigures,
    match_updates,
)
from investment_dashboard.repositories import transactions_repo
from investment_dashboard.services import transaction_edit_service, transaction_fx_service

if TYPE_CHECKING:
    from investment_dashboard.models import Transaction

#: Preview/confirm choice for a row that matches an existing transaction: import it
#: as a new row instead of updating (``skip`` is the ordinary row skip).
FIX_IMPORT_NEW = "import_new"

RowStatus = Literal["new", "duplicate", "update"]


@dataclass(frozen=True)
class ExistingFigures:
    """The figures of the existing transaction an import row would update."""

    id: int
    date: date
    quantity: Decimal | None
    price_native: Decimal | None
    net_native: Decimal | None
    #: The existing row is an estimate (from a recurring plan): the update confirms it.
    estimated: bool = False


@dataclass(frozen=True)
class RowMatch:
    status: RowStatus
    #: The near-matched transaction (``update``); ``None`` for new and duplicate rows.
    existing: ExistingFigures | None = None


def profile_for(existing: Transaction) -> str:
    """How ``existing`` is matched: ``estimated`` for a recurring-plan estimate, else ``normal``.

    Reads the ``is_estimate`` flag when the model has it (added with recurring plans).
    """
    return PROFILE_ESTIMATED if getattr(existing, "is_estimate", False) else PROFILE_NORMAL


def match_tolerances() -> tuple[MatchTolerance, MatchTolerance] | None:
    """``(normal, estimated)`` tolerances from Settings > Import rules; ``None`` when off."""
    from investment_dashboard.services import settings_service  # noqa: PLC0415

    if not settings_service.get_or("import.match_updates_enabled", True):
        return None

    def dec(key: str, fallback: Decimal) -> Decimal:
        return Decimal(str(settings_service.get_or(key, fallback)))

    base = MatchTolerance()
    est = ESTIMATED_TOLERANCE
    normal = MatchTolerance(
        relative=dec("import.match_relative_tolerance", base.relative),
        absolute_amount=dec("import.match_absolute_amount", base.absolute_amount),
        absolute_quantity=dec("import.match_absolute_quantity", base.absolute_quantity),
        business_days=int(
            settings_service.get_or("import.match_business_days", base.business_days)
        ),
    )
    estimated = MatchTolerance(
        relative=dec("import.match_estimated_relative_tolerance", est.relative),
        absolute_amount=dec("import.match_estimated_absolute_amount", est.absolute_amount),
        absolute_quantity=normal.absolute_quantity,
        business_days=int(
            settings_service.get_or("import.match_estimated_business_days", est.business_days)
        ),
        ignore_trade_quantity=True,
    )
    return normal, estimated


def classify_rows(
    session: Session, account_id: int, rows: Sequence[ParsedTransactionRow]
) -> list[RowMatch]:
    """Per row: ``duplicate`` (exact), ``update`` (near-match) or ``new``.

    Exact duplicates win and consume the existing transaction they equal; only the
    leftover existing transactions are offered to the remaining rows.
    """
    from investment_dashboard.services import importer_service  # noqa: PLC0415

    existing = list(transactions_repo.list_transactions(session, account_id=account_id))
    by_ext = {t.external_id: t for t in existing if t.external_id}
    keys = importer_service.existing_content_keys(session, account_id)
    dups = importer_service.mark_duplicates(rows, set(by_ext), keys)

    # Which existing transactions the exact duplicates account for.
    consumed: set[int] = set()
    by_content: dict[tuple[str, ...], list[Transaction]] = {}
    for t in existing:
        symbol = t.instrument.symbol if t.instrument is not None else None
        by_content.setdefault(
            importer_service.content_key(t.date, t.kind, symbol, t.quantity, t.net_native), []
        ).append(t)
    for row, dup in zip(rows, dups, strict=True):
        if not dup:
            continue
        hit = by_ext.get(row.external_id)
        if hit is None:
            key = importer_service.content_key(
                row.date, row.kind, row.symbol, row.quantity, row.net_native
            )
            hit = next((t for t in by_content.get(key, []) if t.id not in consumed), None)
        if hit is not None:
            consumed.add(hit.id)

    out = [RowMatch("duplicate") if d else RowMatch("new") for d in dups]
    tols = match_tolerances()
    if tols is None:
        return out
    candidates = [
        TxnFigures(
            key=str(t.id),
            account_id=t.account_id,
            symbol=t.instrument.symbol if t.instrument is not None else None,
            kind=t.kind,
            on=t.date,
            quantity=t.quantity,
            net=t.net_native,
            profile=profile_for(t),
        )
        for t in existing
        if t.id not in consumed
    ]
    incoming = [
        TxnFigures(
            key=str(i),
            account_id=account_id,
            symbol=r.symbol,
            kind=r.kind,
            on=r.date,
            quantity=r.quantity,
            net=r.net_native,
        )
        for i, (r, dup) in enumerate(zip(rows, dups, strict=True))
        if not dup
    ]
    by_id = {t.id: t for t in existing}
    for inc_key, ex_key in match_updates(candidates, incoming, tols[0], tols[1]).items():
        t = by_id[int(ex_key)]
        out[int(inc_key)] = RowMatch(
            "update",
            ExistingFigures(
                id=t.id,
                date=t.date,
                quantity=t.quantity,
                price_native=t.price_native,
                net_native=t.net_native,
                estimated=profile_for(t) == PROFILE_ESTIMATED,
            ),
        )
    return out


def apply_import_update(
    session: Session, existing: Transaction, incoming: ParsedTransactionRow
) -> None:
    """Overwrite ``existing`` with the import's figures (the import wins).

    The row keeps its id; account, instrument and kind stay (they matched). Date,
    quantity, price, fees, net, description, ``external_id`` and ``source`` come from
    ``incoming`` and the frozen FX legs are recomputed for the new date and amount.
    The row's import batch is left as it was: it was not inserted by this import,
    so undoing this import must not delete it.

    Callers refresh the caches once for all updates (see :func:`apply_updates`).
    """
    account = existing.account
    native = account.native_currency if account is not None else (incoming.native_currency or "USD")
    legs = transaction_fx_service.compute_legs(
        session, native_currency=native, net_native=incoming.net_native, on=incoming.date
    )
    transactions_repo.update_transaction(
        session,
        existing.id,
        date=incoming.date,
        settlement_date=incoming.settlement_date,
        quantity=incoming.quantity,
        price_native=incoming.price_native,
        gross_native=incoming.gross_native,
        fees_native=incoming.fees_native,
        net_native=incoming.net_native,
        fx_rate_to_eur=legs.fx_rate_to_eur,
        net_eur=legs.net_eur,
        net_usd=legs.net_usd,
        description=incoming.description or existing.description,
        external_id=incoming.external_id,
        source=incoming.source,
    )


@dataclass(frozen=True)
class AppliedUpdates:
    """What :func:`apply_updates` did."""

    #: Indexes (into the rows passed in) of the rows that updated an existing one.
    handled: frozenset[int]

    @property
    def count(self) -> int:
        return len(self.handled)


def apply_updates(
    session: Session,
    account_id: int,
    rows: Sequence[ParsedTransactionRow],
    matches: Sequence[RowMatch],
    resolutions: Mapping[str, str] | None = None,
) -> AppliedUpdates:
    """Apply every ``update`` row (except those the user chose to import as new).

    Refreshes caches once, the same way a manual edit does (cached valuations,
    snapshots, live ticks), and leaves one ``changes`` log line with the count.
    """
    force_new = {e for e, fix in (resolutions or {}).items() if fix == FIX_IMPORT_NEW}
    handled: set[int] = set()
    dates: set[date] = set()
    instrument_ids: list[int | None] = []
    for i, (row, match) in enumerate(zip(rows, matches, strict=True)):
        if match.status != "update" or match.existing is None or row.external_id in force_new:
            continue
        target = transactions_repo.get_transaction(session, match.existing.id)
        if target is None:
            continue
        dates.update({target.date, row.date})
        instrument_ids.append(target.instrument_id)
        apply_import_update(session, target, row)
        handled.add(i)
    if handled:
        transaction_edit_service.after_write(session, dates, instrument_ids)
        activity("changes").info(
            "import updated %d existing transaction(s): account_id=%s earliest=%s",
            len(handled),
            account_id,
            min(dates).isoformat(),
        )
    return AppliedUpdates(frozenset(handled))
