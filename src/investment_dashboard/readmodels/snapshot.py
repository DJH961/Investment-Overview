"""Full-snapshot assembler — every section in one JSON document.

The snapshot is the contract the mobile app consumes. It is delivered two
ways, both built from this single function:

* **live** — served by the FastAPI app (:mod:`investment_dashboard.api`)
  over the LAN/VPN; and
* **file** — written to a consumer-cloud-synced folder by
  ``inv-dashboard-export-snapshot`` (:mod:`investment_dashboard.tools.export_snapshot`),
  so the phone reads a fresh copy offline via its cloud auto-sync app.

Bump :data:`SCHEMA_VERSION` whenever the JSON shape changes in a way a
client must adapt to.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard import __version__
from investment_dashboard.readmodels import (
    analytics,
    calculator,
    deposits,
    overview,
    periods,
    transactions,
)
from investment_dashboard.readmodels._context import ReadModelContext, build_context
from investment_dashboard.readmodels._serialize import dec, now_utc_iso

#: Snapshot JSON schema version. Increment on breaking shape changes.
SCHEMA_VERSION = 1


def build_meta(context: ReadModelContext) -> dict[str, Any]:
    """Top-level metadata block describing the snapshot and its currency."""
    return {
        "schema_version": SCHEMA_VERSION,
        "app_version": __version__,
        "generated_at": now_utc_iso(),
        "as_of": context.as_of.isoformat(),
        # FX pivot / conversion reference only — NOT the user's primary currency.
        # USD is the native booked currency for almost every transaction.
        "base_currency": "EUR",
        "display_currency": context.display_currency,
        "fx_rate_eur_to_display": dec(context.fx_rate_eur_to_display),
        "fx_rate_eur_usd": dec(context.fx_rate_eur_usd),
    }


def build_snapshot(session: Session, *, as_of: date | None = None) -> dict[str, Any]:
    """Assemble the complete, JSON-serializable portfolio snapshot."""
    context = build_context(session, as_of=as_of)
    return {
        "meta": build_meta(context),
        "overview": overview.build(session, context=context),
        "deposits": deposits.build(session, context=context),
        "transactions": transactions.build(session, context=context),
        "monthly": periods.build_monthly(session, context=context),
        "yearly": periods.build_yearly(session, context=context),
        "analytics": analytics.build(session, context=context),
        "calculator": calculator.build(session, context=context),
    }
