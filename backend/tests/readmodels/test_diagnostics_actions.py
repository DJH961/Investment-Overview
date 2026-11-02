"""Failing health checks carry "Fix" actions that point at real repair jobs."""

from __future__ import annotations

from sqlalchemy.orm import Session

from investment_dashboard.models import Instrument
from investment_dashboard.readmodels import diagnostics as rm
from investment_dashboard.services import maintenance_service


def test_ok_checks_have_no_actions(session: Session) -> None:
    assert rm.actions_for(session, "prices_stale", "ok", ["AAA"]) == []


def test_every_mapped_job_exists() -> None:
    for actions in rm._JOB_ACTIONS.values():
        for job_id, _label, params in actions:
            spec = maintenance_service.get_spec(job_id)
            maintenance_service.validate_params(spec, params)


def test_per_instrument_redownload(session: Session) -> None:
    instr = Instrument(symbol="AAA", name="A", asset_class="etf", native_currency="USD")
    session.add(instr)
    session.flush()
    actions = rm.actions_for(session, "prices_stale", "warning", ["AAA", "ZZZ"])
    ids = [(a["id"], a["params"]) for a in actions]
    assert ("prices.refresh", {"force": True}) in ids
    assert ("prices.redownload", {"instrument_id": instr.id}) in ids
    assert len(ids) == 2  # unknown symbol skipped
    redownload = next(a for a in actions if a["id"] == "prices.redownload")
    assert redownload["danger"] == "confirm"


def test_links(session: Session) -> None:
    actions = rm.actions_for(session, "providers", "error", [])
    assert actions == [
        {
            "kind": "link",
            "id": "providers",
            "label": "Test the providers",
            "params": {},
            "danger": "none",
            "href": "/diagnostics#system",
        }
    ]
