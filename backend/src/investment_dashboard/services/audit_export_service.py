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
from datetime import date
from typing import Any

from sqlalchemy.orm import Session

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
