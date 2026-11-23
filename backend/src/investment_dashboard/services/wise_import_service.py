"""Wise statement import: stage + preview (no writes), then confirm (7.3).

The conversion twin of :mod:`import_staging`: a Wise statement yields EUR to USD
*conversions*, so it has its own small staging store (raw bytes, TTL, entry cap) and
writes through :mod:`fx_conversion_service` with ``provider="wise"`` and the Wise id
as ``external_id``, which makes an exact re-import all duplicates. The owner can tick
off any row in the preview (``skip``) and set the dollars kept outside investing
(``kept_usd``). Run exactly one uvicorn worker (the store is in memory).

Log lines carry counts only, never names, account numbers or descriptions.
"""

from __future__ import annotations

import threading
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.activity_log import activity
from investment_dashboard.adapters.tabular.reader import UnreadableFileError
from investment_dashboard.adapters.wise.parser import (
    FIELDS,
    WiseRow,
    WiseStatement,
    parse_statement,
)
from investment_dashboard.errors import NotFoundError, ValidationError
from investment_dashboard.repositories import fx_conversion_repository as repo
from investment_dashboard.services import fx_conversion_service, import_staging, settings_service

MAX_STAGED = 20
SETTING_IGNORE_OTHER = "import.ignore_non_usd_conversions"
FIELD_LABELS: dict[str, tuple[str, bool]] = {k: (v[0], v[2]) for k, v in FIELDS.items()}


class WiseImportError(ValidationError):
    """The upload can't be staged or confirmed -> 422."""


class WiseImportNotFoundError(NotFoundError):
    """Unknown or expired import id -> 404."""


@dataclass(frozen=True)
class RowChoice:
    """What the owner decided for one preview row."""

    skip: bool = False
    kept_usd: Decimal = Decimal(0)


@dataclass(frozen=True)
class StagedWise:
    id: str
    filename: str
    raw_bytes: bytes
    statement: WiseStatement
    #: external ids already in the ledger (their rows are duplicates).
    existing: frozenset[str]
    created_at: datetime
    expires_at: datetime
    #: field -> column index chosen by hand (empty = the preset).
    mapping: Mapping[str, int | None] = field(default_factory=dict)

    def is_duplicate(self, row: WiseRow) -> bool:
        return row.status == "conversion" and row.external_id in self.existing

    @property
    def new_count(self) -> int:
        return sum(
            1 for r in self.statement.rows if r.status == "conversion" and not self.is_duplicate(r)
        )

    @property
    def duplicate_count(self) -> int:
        return sum(1 for r in self.statement.rows if self.is_duplicate(r))

    @property
    def skipped_count(self) -> int:
        """Rows left out automatically (not conversions, ignored pairs, unsupported)."""
        return sum(1 for r in self.statement.rows if r.status != "conversion")


@dataclass(frozen=True)
class WiseConfirmResult:
    imported: int
    skipped: int
    duplicates: int


_lock = threading.Lock()
_store: dict[str, StagedWise] = {}


def _now() -> datetime:
    return datetime.now(UTC)


def clear() -> None:
    """Drop everything (tests)."""
    with _lock:
        _store.clear()


def _purge(now: datetime) -> None:
    for key in [k for k, v in _store.items() if v.expires_at <= now]:
        del _store[key]


def stage(
    session: Session,
    *,
    filename: str,
    content: bytes,
    mapping: Mapping[str, int | None] | None = None,
    now: datetime | None = None,
) -> StagedWise:
    name = filename or "upload"
    if not name.lower().endswith(import_staging.ALLOWED_EXTENSIONS):
        raise WiseImportError("Only CSV, TSV, text and Excel (.xlsx) files can be imported")
    if not content:
        raise WiseImportError("The file is empty")
    limit = import_staging.max_upload_bytes()
    if len(content) > limit:
        raise WiseImportError(f"File is larger than {limit // (1024 * 1024)} MB")
    ignore_other = bool(settings_service.get_or(SETTING_IGNORE_OTHER, True))
    try:
        statement = parse_statement(content, mapping=mapping, ignore_other_pairs=ignore_other)
    except UnreadableFileError as exc:
        raise WiseImportError(str(exc)) from exc
    except Exception as exc:
        raise WiseImportError(f"Could not read this file: {exc}") from exc
    ids = [r.external_id for r in statement.rows if r.status == "conversion"]
    existing = frozenset(repo.get_by_external_ids(session, ids))
    moment = now or _now()
    staged = StagedWise(
        id=uuid.uuid4().hex,
        filename=name,
        raw_bytes=content,
        statement=statement,
        existing=existing,
        created_at=moment,
        expires_at=moment + import_staging.staging_ttl(),
        mapping=dict(mapping or {}),
    )
    with _lock:
        _purge(moment)
        while len(_store) >= MAX_STAGED:
            oldest = min(_store.values(), key=lambda s: s.created_at)
            del _store[oldest.id]
        _store[staged.id] = staged
    return staged


def get(import_id: str, *, now: datetime | None = None) -> StagedWise:
    moment = now or _now()
    with _lock:
        _purge(moment)
        staged = _store.get(import_id)
    if staged is None:
        raise WiseImportNotFoundError("Import not found or expired; upload the file again")
    return staged


def discard(import_id: str) -> bool:
    with _lock:
        return _store.pop(import_id, None) is not None


def relayout(session: Session, import_id: str, mapping: Mapping[str, int | None]) -> StagedWise:
    """Parse the staged upload again with columns chosen by hand (new ``import_id``)."""
    old = get(import_id)
    merged = {**old.mapping, **mapping}
    discard(import_id)
    return stage(session, filename=old.filename, content=old.raw_bytes, mapping=merged)


def confirm(
    session: Session, import_id: str, choices: Mapping[int, RowChoice] | None = None
) -> WiseConfirmResult:
    """Write the ticked conversions. ``choices`` is keyed by the row's source line."""
    staged = get(import_id)
    picks = dict(choices or {})
    # Re-check duplicates now: another import may have written some since the preview.
    ids = [r.external_id for r in staged.statement.rows if r.status == "conversion"]
    existing = set(repo.get_by_external_ids(session, ids))
    imported = skipped = duplicates = 0
    plan: list[tuple[WiseRow, RowChoice]] = []
    for row in staged.statement.rows:
        if row.status != "conversion" or row.amounts is None or row.on is None:
            skipped += 1
            continue
        if row.external_id in existing:
            duplicates += 1
            continue
        choice = picks.get(row.line, RowChoice())
        if choice.skip:
            skipped += 1
            continue
        if choice.kept_usd < 0 or choice.kept_usd > row.amounts.usd_received:
            raise WiseImportError("Kept dollars must be between 0 and the dollars received")
        plan.append((row, choice))
    for row, choice in plan:
        if row.amounts is None or row.on is None:  # narrowed above
            continue
        try:
            fx_conversion_service.create_conversion(
                session,
                on=row.on,
                eur_sent=row.amounts.eur_sent,
                usd_received=row.amounts.usd_received,
                fees_eur=row.amounts.fees_eur,
                note=None,
                provider="wise",
                kept_usd=choice.kept_usd,
                external_id=row.external_id,
            )
        except ValueError as exc:
            raise WiseImportError(str(exc)) from exc
        imported += 1
    discard(import_id)
    activity("imports").info(
        "wise statement import confirmed: imported=%d skipped=%d duplicates=%d kind=wise_statement",
        imported,
        skipped,
        duplicates,
    )
    return WiseConfirmResult(imported=imported, skipped=skipped, duplicates=duplicates)


def choices_from(rows: Sequence[tuple[int, bool, Decimal]]) -> dict[int, RowChoice]:
    return {line: RowChoice(skip=skip, kept_usd=kept) for line, skip, kept in rows}
