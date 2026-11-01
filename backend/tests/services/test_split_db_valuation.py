"""Regression tests for portfolio valuation under a **split-DB** layout.

These lock the v2.9.4 fix for the long-standing "everything reads as 0" bug on
cloud installs that keep the ledger/config tiers on OneDrive and the cache tier
(prices / FX / snapshots) in a separate local file.

Two compounding defects are covered:

1. In split + Alembic mode only the ledger DB was migrated, so the cache and
   config databases never got their tables — the background FX/price refresh
   wrote into a schemaless cache DB (every write silently failed). The boot
   sequence now creates the secondary tiers' schema; here we create them the
   same way ``boot._ensure_secondary_tier_schema`` does.
2. The dashboard read paths queried prices/FX/snapshots through the *ledger*
   session, which in split mode cannot see the cache tables, so every
   historical valuation resolved to 0 (zeroing closing values, inflating YTD,
   and dropping MTD). The read paths now route cache-tier reads to the cache
   engine.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from investment_dashboard import config as config_mod
from investment_dashboard import db as db_mod
from investment_dashboard.models import Account, Instrument, Transaction
from investment_dashboard.models.base import ALL_METADATAS, CacheBase, ConfigBase
from investment_dashboard.repositories import prices_repo, snapshots_repo
from investment_dashboard.services import (
    metrics_service,
    positions_service,
    snapshots_service,
)


@pytest.fixture
def split_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Configure three separate tier databases, like a cloud/local split."""
    monkeypatch.setenv("INV_DASHBOARD_LEDGER_PATH", str(tmp_path / "ledger.sqlite"))
    monkeypatch.setenv("INV_DASHBOARD_CONFIG_PATH", str(tmp_path / "config.sqlite"))
    monkeypatch.setenv("INV_DASHBOARD_CACHE_PATH", str(tmp_path / "cache.sqlite"))
    config_mod.get_settings.cache_clear()  # type: ignore[attr-defined]
    db_mod.dispose_engines()

    assert config_mod.get_settings().is_split_db is True

    # Mirror the real boot: Alembic migrates the *ledger* DB only (and the
    # migration scripts create every table), then our boot fix creates the
    # config + cache tier schemas in their own files.
    for md in ALL_METADATAS:
        md.create_all(db_mod.get_ledger_engine())
    ConfigBase.metadata.create_all(db_mod.get_config_engine())
    CacheBase.metadata.create_all(db_mod.get_cache_engine())

    try:
        yield
    finally:
        db_mod.dispose_engines()
        config_mod.get_settings.cache_clear()  # type: ignore[attr-defined]


def _seed(today_price: Decimal) -> int:
    """Seed a EUR holding in the ledger and its prices in the cache tier.

    Returns the instrument id. ``today_price`` is the close on the valuation
    date so callers can assert a non-zero mark-to-market value.
    """
    with db_mod.ledger_session_scope() as ledger:
        acct = Account(
            broker="vanguard",
            account_label="EUR Brokerage",
            native_currency="EUR",
            account_type="brokerage",
        )
        ledger.add(acct)
        ledger.flush()
        instr = Instrument(symbol="ACME", name="Acme", asset_class="etf", native_currency="EUR")
        ledger.add(instr)
        ledger.flush()
        ledger.add(
            Transaction(
                account_id=acct.id,
                instrument_id=instr.id,
                date=date(2025, 1, 6),
                kind="buy",
                quantity=Decimal("10"),
                price_native=Decimal("100.00"),
                net_native=Decimal("-1000.00"),
                net_eur=Decimal("-1000.00"),
                source="manual",
            )
        )
        instr_id = instr.id

    # Prices live in the cache tier — exactly where the background refresh
    # writes them, and a *different* database from the ledger session above.
    with db_mod.cache_session_scope() as cache:
        prices_repo.upsert_closes(
            cache,
            instr_id,
            {
                date(2025, 1, 6): Decimal("100.00"),
                date(2025, 6, 2): today_price,
            },
        )
    return instr_id


def test_total_value_reads_prices_from_cache_tier(split_db: None) -> None:
    _seed(today_price=Decimal("150.00"))
    with db_mod.ledger_session_scope() as ledger:
        value = positions_service.total_portfolio_value(ledger, as_of=date(2025, 6, 2))
    # 10 shares * 150 = 1500. Pre-fix this was 0 because the ledger session
    # could not see the cache-tier price history.
    assert value == Decimal("1500.00")


def test_snapshot_round_trips_through_cache_tier(split_db: None) -> None:
    _seed(today_price=Decimal("150.00"))
    with db_mod.ledger_session_scope() as ledger:
        snap = snapshots_service.get_or_compute(ledger, date(2025, 6, 2))
    assert snap == Decimal("1500.00")

    # The cached snapshot must land in the cache database (the tier the boot
    # invalidation clears), not the ledger DB.
    with db_mod.cache_session_scope() as cache:
        assert snapshots_repo.get_snapshot(cache, date(2025, 6, 2)) is not None
    with db_mod.ledger_session_scope() as ledger:
        assert snapshots_repo.get_snapshot(ledger, date(2025, 6, 2)) is None


def test_ytd_and_mtd_present_in_split_db(split_db: None) -> None:
    _seed(today_price=Decimal("150.00"))
    with db_mod.ledger_session_scope() as ledger:
        metrics = metrics_service.compute_portfolio_metrics(ledger, as_of=date(2025, 6, 2))
    # Headline value is non-zero...
    assert metrics.total_value_eur == Decimal("1500.00")
    # ...YTD is a real, bounded figure (not the inflated value that resulted
    # from a zero start value dividing by contributions alone)...
    assert metrics.ytd_growth_pct is not None
    assert metrics.ytd_growth_pct == pytest.approx(Decimal("0.5"))
    # ...and MTD is present rather than dropped to None by a 0 month-start.
    assert metrics.mtd_growth_pct is not None
