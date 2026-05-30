"""Tests for ``investment_dashboard.services.database_reset_service``.

These exercise the real per-tier app sessions against an on-disk SQLite file
(configured via ``INV_DASHBOARD_DB_PATH``) so the foreign-key-safe delete
order and per-tier routing are covered end to end.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path

import pytest

from investment_dashboard.services import database_reset_service as svc
from investment_dashboard.services.database_reset_service import ResetLevel


@pytest.fixture
def app_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Point the app at a fresh on-disk DB and create the schema."""
    from investment_dashboard.boot import _ensure_schema_present
    from investment_dashboard.config import get_settings
    from investment_dashboard.db import dispose_engines

    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(tmp_path / "reset.sqlite"))
    get_settings.cache_clear()
    dispose_engines()
    _ensure_schema_present()
    try:
        yield
    finally:
        dispose_engines()
        get_settings.cache_clear()


def _seed_everything() -> None:
    """Insert one row in every table the reset service can touch."""
    from investment_dashboard.db import config_session_scope, ledger_session_scope
    from investment_dashboard.models import (
        Account,
        AppConfig,
        FxHistory,
        Instrument,
        InstrumentOverride,
        PositionSnapshot,
        PriceCacheMetadata,
        PriceHistory,
        TargetAllocation,
        TargetAllocationItem,
        Transaction,
    )

    now = datetime.now(UTC)
    with ledger_session_scope() as s:
        s.add(Account(id=1, broker="vanguard", account_label="Brokerage", native_currency="USD"))
        s.add(Instrument(id=1, symbol="VT", asset_class="etf", native_currency="USD"))
        s.flush()
        s.add(
            Transaction(
                account_id=1,
                instrument_id=1,
                date=date(2026, 1, 2),
                kind="buy",
                source="manual",
            )
        )
        s.add(PriceHistory(instrument_id=1, date=date(2026, 1, 2), close_native=Decimal("100")))
        s.add(FxHistory(date=date(2026, 1, 2), base="USD", quote="EUR", rate=Decimal("0.9")))
        s.add(
            PositionSnapshot(
                snapshot_date=date(2026, 1, 2),
                total_value_eur=Decimal("100"),
                computed_at=now,
            )
        )
        s.add(PriceCacheMetadata(instrument_id=1, last_refreshed_at=now))
        s.add(AppConfig(key="display_currency", value="EUR"))
        s.add(TargetAllocation(id=1, name="Default"))
        s.flush()
        s.add(
            TargetAllocationItem(target_allocation_id=1, instrument_id=1, weight_pct=Decimal("100"))
        )

    with config_session_scope() as s:
        s.add(InstrumentOverride(instrument_id=1, category="core"))


def _counts() -> dict[str, int]:
    from investment_dashboard.db import config_session_scope, ledger_session_scope
    from investment_dashboard.models import (
        Account,
        AppConfig,
        FxHistory,
        Instrument,
        InstrumentOverride,
        PositionSnapshot,
        PriceCacheMetadata,
        PriceHistory,
        TargetAllocation,
        TargetAllocationItem,
        Transaction,
    )

    ledger_models = [
        Account,
        Instrument,
        Transaction,
        PriceHistory,
        FxHistory,
        PositionSnapshot,
        PriceCacheMetadata,
        AppConfig,
        TargetAllocation,
        TargetAllocationItem,
    ]
    out: dict[str, int] = {}
    with ledger_session_scope() as s:
        for m in ledger_models:
            out[m.__tablename__] = s.query(m).count()
    with config_session_scope() as s:
        out[InstrumentOverride.__tablename__] = s.query(InstrumentOverride).count()
    return out


def test_cache_reset_clears_only_derived_data(app_db: None) -> None:
    _seed_everything()
    result = svc.reset_database(ResetLevel.CACHE)

    counts = _counts()
    # Derived/cache tables emptied.
    assert counts["price_history"] == 0
    assert counts["fx_history"] == 0
    assert counts["position_snapshots"] == 0
    assert counts["price_cache_metadata"] == 0
    # Source-of-truth untouched.
    assert counts["transactions"] == 1
    assert counts["accounts"] == 1
    assert counts["instruments"] == 1
    assert counts["instrument_overrides"] == 1
    assert result.total_deleted == 4


def test_transactions_reset_clears_ledger_and_cache(app_db: None) -> None:
    _seed_everything()
    result = svc.reset_database(ResetLevel.TRANSACTIONS)

    counts = _counts()
    assert counts["transactions"] == 0
    assert counts["price_history"] == 0
    assert counts["position_snapshots"] == 0
    # Accounts / instruments / overrides / allocations remain for re-import.
    assert counts["accounts"] == 1
    assert counts["instruments"] == 1
    assert counts["instrument_overrides"] == 1
    assert counts["target_allocations"] == 1
    assert result.deleted["transactions"] == 1


def test_everything_reset_clears_all_tables(app_db: None) -> None:
    _seed_everything()
    result = svc.reset_database(ResetLevel.EVERYTHING)

    counts = _counts()
    assert all(n == 0 for n in counts.values()), counts
    # One row per table was seeded; all must be reported as deleted.
    assert result.total_deleted == len(counts)


def test_reset_on_empty_db_is_safe(app_db: None) -> None:
    result = svc.reset_database(ResetLevel.EVERYTHING)
    assert result.total_deleted == 0
