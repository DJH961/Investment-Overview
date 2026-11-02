"""Two-step broker import: stage + preview (no writes), then confirm.

``stage`` parses an upload without touching the ledger and keeps the **raw
bytes** plus the parse report in a process-local store (TTL + size/entry caps).
``confirm`` re-runs :func:`importer_service.import_csv` on those bytes, so what
is written always equals a fresh parse and the ``UNIQUE(account_id,
external_id)`` dedupe makes retries safe.

The store is in memory: run exactly one uvicorn worker (see the v6 plan).
Importers stay broker-agnostic; this module only dispatches on the account's
broker string to pick the parser, never on file contents beyond what
``importer_service`` already does.
"""

from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta

from sqlalchemy.orm import Session

from investment_dashboard.adapters.importer_types import ParsedTransactionRow, ParseReport
from investment_dashboard.adapters.vanguard.settlement import inject_settlement_legs
from investment_dashboard.errors import NotFoundError, ValidationError
from investment_dashboard.repositories import (
    accounts_repo,
    import_batches_repo,
    transactions_repo,
)
from investment_dashboard.services import importer_service
from investment_dashboard.services.importer_service import Broker, ImportResult

MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_STAGED = 20
TTL = timedelta(minutes=30)
ALLOWED_EXTENSIONS: tuple[str, ...] = (".csv", ".xlsx")


def max_upload_bytes() -> int:
    """Largest accepted file (setting ``import.max_upload_mb``; default 10 MB)."""
    from investment_dashboard.services import settings_service  # noqa: PLC0415

    mb = settings_service.get_or("import.max_upload_mb", None)
    return MAX_UPLOAD_BYTES if mb is None else int(mb) * 1024 * 1024


def staging_ttl() -> timedelta:
    """How long an unconfirmed preview is kept (``import.staging_ttl_minutes``)."""
    from investment_dashboard.services import settings_service  # noqa: PLC0415

    minutes = settings_service.get_or("import.staging_ttl_minutes", None)
    return TTL if minutes is None else timedelta(minutes=int(minutes))


class ImportStagingError(ValidationError):
    """The upload can't be staged (bad file, unknown broker/account) -> 422."""


class StagedImportNotFoundError(NotFoundError):
    """Unknown or expired import id -> 404."""


@dataclass(frozen=True)
class PreviewRow:
    index: int
    row: ParsedTransactionRow
    is_duplicate: bool


@dataclass(frozen=True)
class StagedImport:
    id: str
    broker: Broker
    account_id: int
    account_currency: str
    filename: str
    raw_bytes: bytes
    report: ParseReport
    rows: tuple[PreviewRow, ...]
    created_at: datetime
    expires_at: datetime

    @property
    def new_count(self) -> int:
        return sum(1 for r in self.rows if not r.is_duplicate)

    @property
    def duplicate_count(self) -> int:
        return sum(1 for r in self.rows if r.is_duplicate)


_lock = threading.Lock()
_store: dict[str, StagedImport] = {}


def _now() -> datetime:
    return datetime.now(UTC)


def _purge(now: datetime) -> None:
    for key in [k for k, v in _store.items() if v.expires_at <= now]:
        del _store[key]


def clear() -> None:
    """Drop everything (tests)."""
    with _lock:
        _store.clear()


def _resolve_broker(broker: str | None, account_broker: str) -> Broker:
    raw = (broker or account_broker or "").strip().lower()
    try:
        return Broker(raw)
    except ValueError as exc:
        raise ImportStagingError(
            f"Unsupported or missing broker {raw!r}; expected one of "
            f"{', '.join(b.value for b in Broker)}"
        ) from exc


def _resolve_account(session: Session, account_id: int | None, broker: str | None) -> int:
    if account_id is not None:
        return account_id
    if broker:
        matches = accounts_repo.find_by_broker(session, broker.strip().lower())
        if len(matches) == 1:
            return matches[0].id
    raise ImportStagingError("Pick an account for this import")


def stage(
    session: Session,
    *,
    filename: str,
    content: bytes,
    broker: str | None = None,
    account_id: int | None = None,
    now: datetime | None = None,
) -> StagedImport:
    """Parse ``content`` without writing and keep it for :func:`confirm`."""
    name = filename or "upload"
    if not name.lower().endswith(ALLOWED_EXTENSIONS):
        raise ImportStagingError("Only .csv and .xlsx files can be imported")
    if not content:
        raise ImportStagingError("The file is empty")
    limit = max_upload_bytes()
    if len(content) > limit:
        raise ImportStagingError(f"File is larger than {limit // (1024 * 1024)} MB")
    acct_id = _resolve_account(session, account_id, broker)
    account = accounts_repo.get_account(session, acct_id)
    if account is None:
        raise ImportStagingError(f"Unknown account_id={acct_id}")
    resolved = _resolve_broker(broker, account.broker)
    try:
        report = importer_service._parse(resolved, content)
        parsed: list[ParsedTransactionRow] = list(report.rows)
        # Same pre-insert step as import_csv, so the preview matches what is written.
        if resolved == Broker.VANGUARD and parsed:
            parsed = list(inject_settlement_legs(parsed))
    except Exception as exc:
        raise ImportStagingError(f"Could not read this file: {exc}") from exc
    existing = {
        t.external_id
        for t in transactions_repo.list_transactions(session, account_id=acct_id)
        if t.external_id
    }
    rows = tuple(
        PreviewRow(index=i, row=r, is_duplicate=r.external_id in existing)
        for i, r in enumerate(parsed, start=1)
    )
    moment = now or _now()
    staged = StagedImport(
        id=uuid.uuid4().hex,
        broker=resolved,
        account_id=acct_id,
        account_currency=account.native_currency,
        filename=name,
        raw_bytes=content,
        report=report,
        rows=rows,
        created_at=moment,
        expires_at=moment + staging_ttl(),
    )
    with _lock:
        _purge(moment)
        while len(_store) >= MAX_STAGED:
            oldest = min(_store.values(), key=lambda s: s.created_at)
            del _store[oldest.id]
        _store[staged.id] = staged
    return staged


def get(import_id: str, *, now: datetime | None = None) -> StagedImport:
    moment = now or _now()
    with _lock:
        _purge(moment)
        staged = _store.get(import_id)
    if staged is None:
        raise StagedImportNotFoundError("Import not found or expired; upload the file again")
    return staged


def discard(import_id: str) -> bool:
    with _lock:
        return _store.pop(import_id, None) is not None


def latest(*, now: datetime | None = None) -> StagedImport | None:
    """The most recently staged (still unexpired) import, if any."""
    moment = now or _now()
    with _lock:
        _purge(moment)
        if not _store:
            return None
        return max(_store.values(), key=lambda s: s.created_at)


def restage(session: Session, import_id: str, *, now: datetime | None = None) -> StagedImport:
    """Parse a staged upload again (e.g. after an action mapping changed).

    Returns a new staged import (new id); the old one is dropped.
    """
    staged = get(import_id, now=now)
    fresh = stage(
        session,
        filename=staged.filename,
        content=staged.raw_bytes,
        broker=staged.broker.value,
        account_id=staged.account_id,
        now=now,
    )
    discard(import_id)
    return fresh


def confirm(
    session: Session,
    import_id: str,
    *,
    now: datetime | None = None,
    actor: str | None = None,
) -> ImportResult:
    """Write the staged import (idempotent) as one import batch and drop it from the store.

    The batch row is kept only when the import inserted something (a re-upload of
    an already imported file leaves no empty batch behind).
    """
    staged = get(import_id, now=now)
    batch = import_batches_repo.create(
        session,
        created_at=(now or _now()).astimezone(UTC).replace(tzinfo=None),
        account_id=staged.account_id,
        broker=staged.broker.value,
        filename=staged.filename,
        actor=actor,
    )
    result = importer_service.import_csv(
        session,
        broker=staged.broker,
        account_id=staged.account_id,
        content=staged.raw_bytes,
        import_batch_id=batch.id,
    )
    if result.inserted:
        batch.row_count = result.inserted
        batch.duplicate_count = result.duplicates
        session.flush()
        result = replace(result, import_batch_id=batch.id)
    else:
        session.delete(batch)
        session.flush()
    discard(import_id)
    return result
