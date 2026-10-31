"""Diagnostics read-model."""

from __future__ import annotations

from investment_dashboard.readmodels import diagnostics
from investment_dashboard.services import fetch_report, provider_status, runtime_status


def test_build_flattens_process_status(session) -> None:  # type: ignore[no-untyped-def]
    provider_status.reset()
    runtime_status.reset()
    fetch_report.clear()
    provider_status.record("tiingo", "ok", "fine")
    fetch_report.record("tiingo", ["VTI", "VT"])
    out = diagnostics.build(session)
    prov = next(p for p in out["providers"] if p["name"] == "tiingo")
    assert prov["status"] == "ok"
    assert prov["last_fetch_symbols"] == ["VTI", "VT"]
    assert out["problems"] == []
    assert out["status"] in {"ok", "warning", "error"}
    provider_status.reset()
    fetch_report.clear()
