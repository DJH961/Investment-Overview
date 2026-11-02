"""Import history and undo.

Every confirmed import is one ``import_batches`` row (see ``import_staging.confirm``)
and its inserted transactions carry the batch id. Undo deletes exactly the rows
still attached to the batch:

1. typed confirmation (``UNDO``) — checked here, server side;
2. a sealed backup first (when backups are configured; a failed backup aborts);
3. delete the batch's transactions (rows edited by hand since the import were
   detached from the batch and are kept);
4. drop cached valuations from the earliest affected trade date and the
   intraday week curve, and tell open tabs to refresh;
5. mark the batch ``undone`` and log it in the ``imports`` activity log.

Imports made before batches existed have no batch and cannot be undone here.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy.orm import Session

from investment_dashboard.activity_log import activity
from investment_dashboard.errors import ConflictError, NotFoundError, ValidationError
from investment_dashboard.repositories import accounts_repo, import_batches_repo
from investment_dashboard.repositories.import_batches_repo import BATCH_ACTIVE

if TYPE_CHECKING:
    from investment_dashboard.models import ImportBatch

log = logging.getLogger(__name__)

#: Word the user must type to undo an import.
CONFIRM_WORD = "UNDO"
#: Rows listed in an undo preview (the counts always cover the whole batch).
PREVIEW_ROWS = 200


@dataclass(frozen=True)
class BatchView:
    id: int
    created_at: datetime
    account_id: int
    account_label: str | None
    broker: str
    filename: str
    row_count: int
    current_rows: int
    duplicate_count: int
    status: str
    actor: str | None
    undone_at: datetime | None
    undone_by: str | None
    undone_rows: int | None
    can_undo: bool


@dataclass(frozen=True)
class PreviewRow:
    id: int
    date: date
    kind: str
    symbol: str | None
    quantity: Decimal | None
    net_native: Decimal | None
    description: str | None


@dataclass(frozen=True)
class UndoPreview:
    batch: BatchView
    rows: list[PreviewRow]
    total: int
    #: Rows imported by the batch but edited/deleted by hand since (kept on undo).
    detached: int
    earliest_date: date | None
    latest_date: date | None
    confirm_word: str


@dataclass(frozen=True)
class UndoResult:
    batch: BatchView
    deleted: int
    backup: str | None
    invalidated_from: date | None


def _views(session: Session, batches: list[ImportBatch]) -> list[BatchView]:
    counts = import_batches_repo.current_row_counts(session, [b.id for b in batches])
    labels = {a.id: a.account_label for a in accounts_repo.list_accounts(session)}
    return [
        BatchView(
            id=b.id,
            created_at=b.created_at,
            account_id=b.account_id,
            account_label=labels.get(b.account_id),
            broker=b.broker,
            filename=b.filename,
            row_count=b.row_count,
            current_rows=counts.get(b.id, 0),
            duplicate_count=b.duplicate_count,
            status=b.status,
            actor=b.actor,
            undone_at=b.undone_at,
            undone_by=b.undone_by,
            undone_rows=b.undone_rows,
            can_undo=b.status == BATCH_ACTIVE and counts.get(b.id, 0) > 0,
        )
        for b in batches
    ]


def list_batches(session: Session, *, limit: int = 100) -> list[BatchView]:
    """Newest first."""
    return _views(session, list(import_batches_repo.list_recent(session, limit=limit)))


def _batch(session: Session, batch_id: int) -> ImportBatch:
    batch = import_batches_repo.get(session, batch_id)
    if batch is None:
        raise NotFoundError(f"import batch {batch_id} not found")
    return batch


def preview(session: Session, batch_id: int) -> UndoPreview:
    """What an undo of ``batch_id`` would delete (nothing is changed)."""
    batch = _batch(session, batch_id)
    view = _views(session, [batch])[0]
    txns = list(import_batches_repo.transactions_of(session, batch_id))
    dates = [t.date for t in txns]
    return UndoPreview(
        batch=view,
        rows=[
            PreviewRow(
                id=t.id,
                date=t.date,
                kind=t.kind,
                symbol=t.instrument.symbol if t.instrument is not None else None,
                quantity=t.quantity,
                net_native=t.net_native,
                description=t.description,
            )
            for t in txns[:PREVIEW_ROWS]
        ],
        total=len(txns),
        detached=max(batch.row_count - len(txns), 0),
        earliest_date=min(dates) if dates else None,
        latest_date=max(dates) if dates else None,
        confirm_word=CONFIRM_WORD,
    )


def _backup_first() -> str | None:
    from investment_dashboard.services import backup_service  # noqa: PLC0415

    if not backup_service.is_configured():
        log.warning("undo import: backups are not configured; continuing without one")
        return None
    try:
        return backup_service.create_snapshot().name
    except Exception as exc:
        log.warning("undo import: backup failed; nothing deleted", exc_info=True)
        raise ConflictError(
            f"the backup before the undo failed, nothing was deleted: {exc}"
        ) from exc


def undo(
    session: Session,
    batch_id: int,
    *,
    confirm: str | None,
    actor: str,
    now: datetime | None = None,
) -> UndoResult:
    """Delete the transactions of ``batch_id`` (see the module doc for the steps)."""
    from investment_dashboard.services import (  # noqa: PLC0415
        intraday_snapshots_service,
        refresh_status,
        snapshots_service,
    )

    if (confirm or "").strip() != CONFIRM_WORD:
        raise ValidationError(f"type {CONFIRM_WORD} to confirm")
    batch = _batch(session, batch_id)
    if batch.status != BATCH_ACTIVE:
        raise ConflictError("this import was already undone")
    backup = _backup_first()
    deleted, dates = import_batches_repo.delete_transactions_of(session, batch_id)
    if dates:
        snapshots_service.invalidate_for_trade_dates(session, dates)
        intraday_snapshots_service.clear_week_samples(session)
    moment = (now or datetime.now(UTC)).astimezone(UTC).replace(tzinfo=None)
    import_batches_repo.mark_undone(
        session, batch, at=moment, actor=actor, rows=deleted, backup=backup
    )
    activity("imports").info(
        "import batch %d (%s, %s) undone by %s: %d transaction(s) deleted, backup=%s",
        batch_id,
        batch.broker,
        batch.filename,
        actor,
        deleted,
        backup or "none",
    )
    refresh_status._publish({"type": "refresh", "reason": "import undone"})
    return UndoResult(
        batch=_views(session, [batch])[0],
        deleted=deleted,
        backup=backup,
        invalidated_from=min(dates) if dates else None,
    )
