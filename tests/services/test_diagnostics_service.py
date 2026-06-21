"""Tests for :mod:`investment_dashboard.services.diagnostics_service`.

The diagnostics sweep is read-only and reuses the live services, so these
tests seed a small ledger and assert the silent-degradation signals surface as
structured :class:`HealthItem` rows with the right severity.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.repositories import (
    accounts_repo,
    instruments_repo,
    prices_repo,
    transactions_repo,
)
from investment_dashboard.services import diagnostics_service, provider_status


@pytest.fixture(autouse=True)
def _reset_provider_status() -> None:
    """Isolate the process-global provider status between tests.

    ``provider_status`` keeps the last outcome per provider in a module-level
    dict, so a provider event recorded by an earlier test in the full suite
    would otherwise leak into these probes and make the all-green assertions
    flaky. Reset before each test here so every case starts from a clean slate.
    """
    provider_status.reset()


def _account(session: Session, native: str = "USD") -> int:
    return accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label=f"Acct {native}",
        native_currency=native,
        account_type="brokerage",
    ).id


class TestHealthReportAggregation:
    def test_clean_ledger_reports_no_problems(self, session: Session) -> None:
        report = diagnostics_service.check_health(session)
        assert not report.has_problems
        assert report.worst_severity == "ok"
        assert report.problem_count == 0
        # Every probe still produces an item (so the page can show all-green).
        assert {i.key for i in report.items} >= {
            "fx_legs",
            "prices_missing",
            "position_value",
            "providers",
        }

    def test_missing_price_is_flagged_as_error(self, session: Session) -> None:
        instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
        session.commit()

        report = diagnostics_service.check_health(session)

        missing = next(i for i in report.items if i.key == "prices_missing")
        assert missing.severity == "error"
        assert missing.count == 1
        assert "VTI" in missing.examples
        assert report.has_problems
        assert report.worst_severity == "error"

    def test_priced_instrument_is_not_missing(self, session: Session) -> None:
        instr = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
        prices_repo.upsert_closes(session, instr.id, {date(2024, 1, 5): Decimal("100")})
        session.commit()

        report = diagnostics_service.check_health(session)

        missing = next(i for i in report.items if i.key == "prices_missing")
        assert missing.severity == "ok"
        assert missing.count == 0

    def test_missing_fx_leg_is_flagged(self, session: Session) -> None:
        account_id = _account(session, native="USD")
        # A row written before the leg-freeze: net_usd / net_eur are NULL.
        transactions_repo.insert_transaction(
            session,
            Transaction(
                account_id=account_id,
                date=date(2024, 1, 5),
                kind="deposit",
                net_native=Decimal("1000"),
                source="manual",
            ),
        )
        session.commit()

        report = diagnostics_service.check_health(session)

        legs = next(i for i in report.items if i.key == "fx_legs")
        assert legs.severity == "warning"
        assert legs.count >= 1
        assert "2024-01-05" in legs.examples


class TestProviderProbe:
    def test_failing_provider_is_error(self, session: Session) -> None:
        provider_status.reset()
        provider_status.record("yfinance", "error", "HTTP 503")
        try:
            report = diagnostics_service.check_health(session)
            providers = next(i for i in report.items if i.key == "providers")
            assert providers.severity == "error"
            assert any("yfinance" in e for e in providers.examples)
        finally:
            provider_status.reset()

    def test_partial_provider_is_warning(self, session: Session) -> None:
        provider_status.reset()
        provider_status.record("yfinance", "partial", "2/3 symbols")
        try:
            report = diagnostics_service.check_health(session)
            providers = next(i for i in report.items if i.key == "providers")
            assert providers.severity == "warning"
        finally:
            provider_status.reset()
