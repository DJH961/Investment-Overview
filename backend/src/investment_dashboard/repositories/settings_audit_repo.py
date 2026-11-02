"""Settings change history (``app_config_audit``, config tier)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from investment_dashboard.models import AppConfigAudit

#: Rows kept; older ones are pruned on write.
KEEP_ROWS = 1000


@dataclass(frozen=True)
class AuditRow:
    id: int
    key: str
    old_value: str | None
    new_value: str | None
    changed_at: datetime
    actor: str
    action: str
    request_id: str | None


def _row(r: AppConfigAudit) -> AuditRow:
    return AuditRow(
        id=r.id,
        key=r.key,
        old_value=r.old_value,
        new_value=r.new_value,
        changed_at=r.changed_at,
        actor=r.actor,
        action=r.action,
        request_id=r.request_id,
    )


def add(
    session: Session,
    *,
    key: str,
    old_value: str | None,
    new_value: str | None,
    changed_at: datetime,
    actor: str,
    action: str,
    request_id: str | None = None,
) -> int:
    row = AppConfigAudit(
        key=key,
        old_value=old_value,
        new_value=new_value,
        changed_at=changed_at,
        actor=actor[:64],
        action=action,
        request_id=request_id[:64] if request_id else None,
    )
    session.add(row)
    session.flush()
    return row.id


def prune(session: Session, keep: int = KEEP_ROWS) -> int:
    """Delete all but the newest ``keep`` rows. Returns rows removed."""
    cutoff = session.scalar(
        select(AppConfigAudit.id).order_by(AppConfigAudit.id.desc()).offset(keep).limit(1)
    )
    if cutoff is None:
        return 0
    result = session.execute(delete(AppConfigAudit).where(AppConfigAudit.id <= cutoff))
    return int(result.rowcount or 0)


def history(session: Session, *, key: str | None = None, limit: int = 100) -> list[AuditRow]:
    stmt = select(AppConfigAudit).order_by(AppConfigAudit.id.desc()).limit(limit)
    if key is not None:
        stmt = stmt.where(AppConfigAudit.key == key)
    return [_row(r) for r in session.scalars(stmt)]


def get(session: Session, audit_id: int) -> AuditRow | None:
    row = session.get(AppConfigAudit, audit_id)
    return None if row is None else _row(row)


def last_changed(session: Session, keys: list[str]) -> dict[str, datetime]:
    """Newest ``changed_at`` per key (for the "modified at" badge)."""
    if not keys:
        return {}
    out: dict[str, datetime] = {}
    rows = session.execute(
        select(AppConfigAudit.key, AppConfigAudit.changed_at)
        .where(AppConfigAudit.key.in_(keys))
        .order_by(AppConfigAudit.id)
    )
    for key, changed_at in rows:
        out[key] = changed_at
    return out
