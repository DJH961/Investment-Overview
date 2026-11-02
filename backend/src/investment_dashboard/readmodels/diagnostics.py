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

from investment_dashboard.repositories import instruments_repo
from investment_dashboard.services import (
    diagnostics_service,
    fetch_report,
    fx_conversion_service,
    maintenance_service,
    provider_status,
    refresh_status,
    runtime_status,
)

#: Failing check id -> repair jobs offered next to it (job id, label, params).
_JOB_ACTIONS: dict[str, tuple[tuple[str, str, dict[str, Any]], ...]] = {
    "fx_legs": (
        ("fx.refresh", "Re-download FX history", {}),
        ("fx.recalc_legs", "Recalculate missing FX legs", {"force": False}),
    ),
    "frozen_legs": (("fx.recalc_legs", "Recalculate all FX legs", {"force": True}),),
    "prices_missing": (("prices.refresh", "Refresh prices", {"force": True}),),
    "prices_stale": (("prices.refresh", "Refresh prices", {"force": True}),),
    "prices_anomaly": (),
    "position_value": (("snapshots.rebuild", "Rebuild valuation history", {}),),
    "intraday_graph": (("graphs.reload", "Reload 1D / 1W graphs", {"which": "all"}),),
}
#: Checks whose examples are instrument symbols (offer a per-instrument re-download).
_PER_INSTRUMENT = frozenset({"prices_missing", "prices_stale", "prices_anomaly"})
_MAX_PER_INSTRUMENT = 5
#: Failing check id -> a page to open instead of (or besides) a job.
_LINKS: dict[str, tuple[str, str]] = {
    "providers": ("Test the providers", "/diagnostics#system"),
    "prices_anomaly": ("Open the price editor", "/diagnostics#market-data"),
    "ecb_fallback_deposits": ("Record the missing conversion", "/transactions"),
}


def _job_action(job_id: str, label: str, params: dict[str, Any]) -> dict[str, Any]:
    spec = maintenance_service.BY_ID[job_id]
    return {
        "kind": "job",
        "id": job_id,
        "label": label,
        "params": params,
        "danger": spec.danger,
        "href": None,
    }


def actions_for(
    session: Session, check_id: str, severity: str, examples: list[str]
) -> list[dict[str, Any]]:
    """The "Fix" buttons for one check (none while it is ok)."""
    if severity == "ok":
        return []
    out = [_job_action(*a) for a in _JOB_ACTIONS.get(check_id, ())]
    if check_id in _PER_INSTRUMENT:
        for symbol in examples[:_MAX_PER_INSTRUMENT]:
            instr = instruments_repo.get_by_symbol(session, symbol)
            if instr is not None:
                out.append(
                    _job_action(
                        "prices.redownload", f"Re-download {symbol}", {"instrument_id": instr.id}
                    )
                )
    link = _LINKS.get(check_id)
    if link is not None:
        out.append(
            {
                "kind": "link",
                "id": check_id,
                "label": link[0],
                "params": {},
                "danger": "none",
                "href": link[1],
            }
        )
    return out


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
    fallback_check["actions"] = actions_for(
        session, fallback_check["id"], fallback_check["severity"], fallback_check["examples"]
    )
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
                "actions": actions_for(session, i.key, i.severity, list(i.examples)),
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
