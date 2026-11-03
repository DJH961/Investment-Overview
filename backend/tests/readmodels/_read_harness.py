"""Shared harness for the read-path golden / budget tests (single-file DB, API test ledger)."""

from __future__ import annotations

import importlib.util
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from investment_dashboard.config import get_settings
from investment_dashboard.db import (
    dispose_engines,
    get_ledger_engine,
    ledger_session_scope,
)
from investment_dashboard.models import ALL_METADATAS
from investment_dashboard.readmodels import allocations, holdings, live_graphs, overview, periods
from investment_dashboard.services import intraday_snapshots_service

_SEED_PATH = Path(__file__).resolve().parents[1] / "api" / "_seed.py"
_spec = importlib.util.spec_from_file_location("_read_harness_seed", _SEED_PATH)
assert _spec is not None
assert _spec.loader is not None
_seed_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_seed_module)
seed_ledger = _seed_module.seed_ledger

Builder = Callable[[Any], Any]

#: name -> builder(session); every builder is a pure read of the seeded ledger.
BUILDS: dict[str, Builder] = {
    "overview_eur": lambda s: overview.build_overview(s, ccy="EUR"),
    "overview_usd": lambda s: overview.build_overview(s, ccy="USD"),
    "holdings_eur": lambda s: holdings.build(s, ccy="EUR", group_by="none"),
    "holdings_usd_grouped": lambda s: holdings.build(s, ccy="USD", group_by="asset_class"),
    "graph_1d": lambda s: live_graphs.build_graph(s, range_key="1d", ccy="EUR", compare=True),
    "graph_1m": lambda s: live_graphs.build_graph(s, range_key="1m", ccy="EUR", compare=True),
    "monthly": lambda s: periods.build_for_ccy(s, monthly=True, ccy="EUR", fill_gaps=False),
    "yearly": lambda s: periods.build_for_ccy(s, monthly=False, ccy="USD"),
    "allocations": lambda s: allocations.build(s, ccy="EUR"),
}


@pytest.fixture
def read_ledger(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(tmp_path / "app.sqlite"))
    for tier in ("LEDGER", "CONFIG", "CACHE"):
        monkeypatch.delenv(f"INV_DASHBOARD_{tier}_PATH", raising=False)
    get_settings.cache_clear()
    dispose_engines()
    engine = get_ledger_engine()
    for metadata in ALL_METADATAS:
        metadata.create_all(engine)
    samples = [
        (datetime(2026, 10, 30, 14, 30, tzinfo=UTC), Decimal("4000"), Decimal("1.2")),
        (datetime(2026, 10, 30, 15, 30, tzinfo=UTC), Decimal("4100"), Decimal("1.2")),
    ]
    monkeypatch.setattr(
        intraday_snapshots_service,
        "day_series_with_fx",
        lambda *_a, **_k: [(t.replace(tzinfo=None), v, r) for t, v, r in samples],
    )
    monkeypatch.setattr(
        intraday_snapshots_service,
        "week_series_with_fx",
        lambda *_a, **_k: [(t.replace(tzinfo=None), v, r) for t, v, r in samples],
    )
    monkeypatch.setattr(intraday_snapshots_service, "week_nav_drift_with_fx", lambda *_a, **_k: {})
    with ledger_session_scope() as session:
        seed_ledger(session)
    try:
        yield
    finally:
        dispose_engines()
        get_settings.cache_clear()


def run_build(name: str) -> Any:
    """Run one build on a fresh session (so session memos never leak between runs)."""
    with ledger_session_scope() as session:
        return BUILDS[name](session)
