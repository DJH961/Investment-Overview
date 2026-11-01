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

    def test_recent_price_is_not_stale(self, session: Session) -> None:
        # A close from today reflects the latest session, so it must never be
        # flagged stale just because it is past the short internal refresh TTL
        # (the bug the user kept hitting: a permanent warning they can't clear).
        instr = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
        prices_repo.upsert_closes(session, instr.id, {date.today(): Decimal("100")})
        session.commit()

        report = diagnostics_service.check_health(session)

        assert not any(i.key == "prices_stale" for i in report.items)

    def test_genuinely_old_price_is_flagged_stale(self, session: Session) -> None:
        # A close that predates the last completed trading day is genuinely
        # stale — a fresh price failed to land — so it is surfaced as a warning.
        instr = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
        prices_repo.upsert_closes(session, instr.id, {date(2020, 1, 6): Decimal("100")})
        session.commit()

        report = diagnostics_service.check_health(session)

        stale = next(i for i in report.items if i.key == "prices_stale")
        assert stale.severity == "warning"
        assert "VTI" in stale.examples

    def test_price_two_trading_days_back_absorbs_a_holiday(self, session: Session) -> None:
        # An equity whose newest close is two trading days behind is not flagged:
        # the extra grace day absorbs a single exchange holiday (which our
        # weekday-only clock would otherwise read as a missed session and warn on
        # the morning after a long weekend).
        from investment_dashboard.domain import market_hours

        instr = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
        two_back = market_hours.trading_days_before(date.today(), 2)
        prices_repo.upsert_closes(session, instr.id, {two_back: Decimal("100")})
        session.commit()

        report = diagnostics_service.check_health(session)

        assert not any(i.key == "prices_stale" for i in report.items)

    def test_mutual_fund_gets_extra_staleness_leeway(self, session: Session) -> None:
        # A mutual-fund NAV that is three trading days behind is *not* stale —
        # NAVs publish once a day and routinely land late — while an equity at the
        # same date would be flagged.
        from investment_dashboard.domain import market_hours

        fund = instruments_repo.get_or_create(session, symbol="VTSAX", asset_class="mutual_fund")
        etf = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
        three_back = market_hours.trading_days_before(date.today(), 3)
        prices_repo.upsert_closes(session, fund.id, {three_back: Decimal("100")})
        prices_repo.upsert_closes(session, etf.id, {three_back: Decimal("100")})
        session.commit()

        report = diagnostics_service.check_health(session)

        stale = next(i for i in report.items if i.key == "prices_stale")
        # The equity is flagged; the mutual fund is given leeway.
        assert "VTI" in stale.examples
        assert "VTSAX" not in stale.examples

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


class TestIntradayGraphProbe:
    """The Data Health flag for live graphs the backfill could not fill.

    The probe delegates the (date-sensitive, cache-reading) coverage assessment
    to ``intraday_snapshots_service.assess_graph_coverage``; these tests stub that
    out so they assert the probe's *reporting* — severity, count, and examples —
    deterministically.
    """

    def test_full_coverage_is_ok(self, session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
        from investment_dashboard.services import intraday_snapshots_service

        monkeypatch.setattr(
            intraday_snapshots_service,
            "assess_graph_coverage",
            lambda *a, **k: intraday_snapshots_service.GraphCoverage(
                day_below_target=False, week_days_below_target=()
            ),
        )
        report = diagnostics_service.check_health(session)
        item = next(i for i in report.items if i.key == "intraday_graph")
        assert item.severity == "ok"
        assert item.count == 0
        assert not report.has_problems

    def test_uncovered_sessions_are_flagged_with_examples(
        self, session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from investment_dashboard.services import intraday_snapshots_service

        monkeypatch.setattr(
            intraday_snapshots_service,
            "assess_graph_coverage",
            lambda *a, **k: intraday_snapshots_service.GraphCoverage(
                day_below_target=True,
                week_days_below_target=(date(2024, 6, 3), date(2024, 6, 4)),
            ),
        )
        report = diagnostics_service.check_health(session)
        item = next(i for i in report.items if i.key == "intraday_graph")
        assert item.severity == "warning"
        # One "1 Day" gap plus two "1 Week" sessions.
        assert item.count == 3
        assert "1 Day" in item.detail
        assert "1 Week" in item.detail
        assert "2024-06-03" in item.examples
        assert "2024-06-04" in item.examples
        assert report.has_problems

    def test_day_only_gap_omits_week_label(
        self, session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from investment_dashboard.services import intraday_snapshots_service

        monkeypatch.setattr(
            intraday_snapshots_service,
            "assess_graph_coverage",
            lambda *a, **k: intraday_snapshots_service.GraphCoverage(
                day_below_target=True, week_days_below_target=()
            ),
        )
        report = diagnostics_service.check_health(session)
        item = next(i for i in report.items if i.key == "intraday_graph")
        assert item.severity == "warning"
        assert item.count == 1
        assert "1 Day" in item.detail
        assert "1 Week" not in item.detail

    def test_probe_is_skipped_in_quick_status(
        self, session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # quick_status drives the cheap header badge and must not run the
        # per-day positions walk the graph probe needs.
        from investment_dashboard.services import intraday_snapshots_service

        def _boom(*a: object, **k: object) -> object:
            raise AssertionError("assess_graph_coverage must not run in quick_status")

        monkeypatch.setattr(intraday_snapshots_service, "assess_graph_coverage", _boom)
        severity, _count = diagnostics_service.quick_status(session)
        assert severity in {"ok", "warning", "error"}
