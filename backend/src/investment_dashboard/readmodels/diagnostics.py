"""Diagnostics read-model -- data-health checks plus process-local status.

Flattens :mod:`investment_dashboard.services.diagnostics_service` (DB probes) and
the in-memory status modules (``provider_status``, ``fetch_report``,
``runtime_status``, ``refresh_status``). The in-memory parts are process-local:
after a server restart the provider/problem lists are empty until the next
refresh cycle records new events.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.services import (
    diagnostics_service,
    fetch_report,
    fx_conversion_service,
    provider_status,
    refresh_status,
    runtime_status,
)


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _ecb_fallback_check(session: Session) -> dict[str, Any]:
    """USD deposits that fell back to the ECB rate (conversion pool did not cover them)."""
    report = fx_conversion_service.pool_report(session)
    if not report.conversions:
        return {
            "id": "ecb_fallback_deposits",
            "title": "Deposits paid at the ECB rate",
            "severity": "ok",
            "count": 0,
            "detail": "No currency conversions recorded, so deposits use their trade-date rate.",
            "examples": [],
        }
    fallen = [m for m in report.result.deposits if m.is_fallback]
    return {
        "id": "ecb_fallback_deposits",
        "title": "Deposits paid at the ECB rate",
        "severity": "warning" if fallen else "ok",
        "count": len(fallen),
        "detail": (
            "These USD deposits were not fully covered by recorded conversions; "
            "the ECB rate was used for the rest. Add the missing conversion."
            if fallen
            else "Every USD deposit is covered by a recorded conversion."
        ),
        "examples": [f"{m.date.isoformat()} ({m.fallback_usd:f} USD)" for m in fallen[:5]],
    }


def build(session: Session, *, log_limit: int = 50) -> dict[str, Any]:
    """Return the JSON-serializable diagnostics read-model."""
    report = diagnostics_service.check_health(session)
    fallback_check = _ecb_fallback_check(session)
    latest = provider_status.all_latest()
    fetched = fetch_report.all_latest()
    providers = []
    for name in sorted(set(latest) | set(fetched)):
        event = latest.get(name)
        fetch = fetched.get(name)
        providers.append(
            {
                "name": name,
                "status": event.status if event else None,
                "message": event.message if event else None,
                "at": _iso(event.at) if event else None,
                "last_fetch_at": _iso(fetch.at) if fetch else None,
                "last_fetch_symbols": list(fetch.symbols) if fetch else [],
            }
        )
    activity = refresh_status.snapshot()
    return {
        "status": "warning"
        if fallback_check["count"] and report.worst_severity == "ok"
        else report.worst_severity,
        "count": report.problem_count + (1 if fallback_check["count"] else 0),
        "generated_at": report.generated_at.isoformat(),
        "checks": [
            {
                "id": i.key,
                "title": i.title,
                "severity": i.severity,
                "count": i.count,
                "detail": i.detail,
                "examples": list(i.examples),
            }
            for i in report.items
        ]
        + [fallback_check],
        "providers": providers,
        "provider_log": [
            {"provider": e.provider, "status": e.status, "message": e.message, "at": _iso(e.at)}
            for e in provider_status.get_log(log_limit)
        ],
        "problems": [
            {
                "id": e.seq,
                "source": e.source,
                "message": e.message,
                "severity": e.severity,
                "at": _iso(e.at),
            }
            for e in runtime_status.recent(log_limit)
        ],
        "refresh": {
            "active": activity.active,
            "source": activity.source,
            "last_update_at": _iso(activity.last_update_at),
            "historical": activity.historical,
            "progress_done": activity.progress_done,
            "progress_total": activity.progress_total,
            "progress_label": activity.progress_label,
        },
    }
