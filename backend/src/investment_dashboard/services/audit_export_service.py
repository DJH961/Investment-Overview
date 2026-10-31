"""Developer audit export — every dashboard's data in one JSON document.

This backs the Settings → "Developer tools" → audit export option. It reuses
the mobile read-model snapshot (:func:`investment_dashboard.readmodels.build_snapshot`),
so the exported figures are byte-for-byte what the live API serves and what the
pages render — overview KPIs and positions, deposits, the raw ledger, the
monthly/yearly period tables, analytics and the calculator.

The intent is reconciliation: hand the JSON to an external reviewer (or a
spreadsheet) to find *why* the app's total value or growth rate diverges from
another source, without exposing a new always-on surface.
"""

from __future__ import annotations

import json
import secrets
from datetime import date
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.config import get_settings
from investment_dashboard.readmodels import build_snapshot


def build_audit_export(session: Session, *, as_of: date | None = None) -> dict[str, Any]:
    """Return the full audit-export document (the complete dashboard snapshot)."""
    return build_snapshot(session, as_of=as_of)


def build_audit_export_json(session: Session, *, as_of: date | None = None, indent: int = 2) -> str:
    """Serialize the audit export as human-readable, pretty-printed JSON text."""
    return json.dumps(build_audit_export(session, as_of=as_of), indent=indent)


def audit_export_filename(today: date | None = None) -> str:
    """Filename for a downloaded audit export, dated for easy archival."""
    return f"audit-export-{(today or date.today()).isoformat()}.json"


def dev_password_configured() -> bool:
    """Whether a developer password gate is configured."""
    return bool(get_settings().dev_password)


def verify_dev_password(presented: str | None) -> bool:
    """Constant-time check of a presented developer password.

    Returns ``False`` when no password is configured, so callers must decide
    explicitly how to treat an ungated panel rather than letting an empty
    string through.
    """
    configured = get_settings().dev_password
    if not configured or not presented:
        return False
    return secrets.compare_digest(presented, configured)
