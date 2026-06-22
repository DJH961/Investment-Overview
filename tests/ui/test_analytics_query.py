"""Tests for ``investment_dashboard.ui.pages._analytics_query``."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest

from investment_dashboard.models import (
    Account,
    Instrument,
    PriceHistory,
    Transaction,
    TransactionKind,
)
from investment_dashboard.repositories import app_config_repo, snapshots_repo
from investment_dashboard.services import benchmark_service
from investment_dashboard.ui.pages._analytics_query import build_bundle


@pytest.fixture(autouse=True)
def no_live_risk_free_fetch(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep analytics query tests deterministic even when yfinance is reachable."""
    monkeypatch.setattr(
        "investment_dashboard.adapters.yfinance_client.fetch_latest_close",
        lambda _symbol: None,
    )


@pytest.fixture
def populated_session(session):  # type: ignore[no-untyped-def]
    """Account + instrument + a year of synthetic snapshot history."""
    account = Account(
        broker="vanguard",
        account_label="Brokerage",
        account_type="brokerage",
        native_currency="EUR",
    )
    instrument = Instrument(symbol="VTI", asset_class="etf", native_currency="USD")
    session.add_all([account, instrument])
    session.flush()

    # 30 daily snapshots, slow drift up: 1000 → 1030.
    today = date(2026, 5, 1)
    for i in range(30):
        d = today - timedelta(days=29 - i)
        snapshots_repo.upsert_snapshot(session, d, Decimal(1000 + i))

    # One deposit at start so cumulative_contributions has a non-zero value.
    session.add(
        Transaction(
            account_id=account.id,
            instrument_id=None,
            date=today - timedelta(days=29),
            kind=TransactionKind.DEPOSIT.value,
            quantity=None,
            price_native=None,
            net_native=Decimal(1000),
            net_eur=Decimal(1000),
            source="manual",
        )
    )

    # Benchmark price history under the default symbol VT.
    bench_instrument = Instrument(symbol="VT", asset_class="etf", native_currency="USD")
    session.add(bench_instrument)
    session.flush()
    for i in range(30):
        d = today - timedelta(days=29 - i)
        session.add(
            PriceHistory(
                instrument_id=bench_instrument.id,
                date=d,
                close_native=Decimal(100 + i * Decimal("0.5")),
                source="benchmark",
            )
        )
    session.flush()
    return session, today


def test_bundle_populates_curve_and_kpis(populated_session) -> None:  # type: ignore[no-untyped-def]
    session, as_of = populated_session
    bundle = build_bundle(session, currency="EUR", lookback_days=29, as_of=as_of)
    assert len(bundle.curve) == 30  # inclusive of both endpoints
    assert bundle.curve[0].portfolio_value == Decimal(1000)
    assert bundle.curve[-1].portfolio_value == Decimal(1029)
    assert bundle.cagr is not None
    assert bundle.cagr > 0
    assert bundle.volatility is not None
    assert bundle.max_drawdown == Decimal(0)  # monotone up
    assert bundle.benchmark_symbol == "VT"
    # Curve picks up the benchmark series.
    bench_points = [p for p in bundle.curve if p.benchmark_value is not None]
    assert len(bench_points) >= 25


def test_bundle_safe_on_empty_db(session) -> None:  # type: ignore[no-untyped-def]
    bundle = build_bundle(session, currency="EUR", lookback_days=7, as_of=date(2026, 5, 1))
    assert bundle.cagr is None
    assert bundle.sharpe is None
    assert bundle.attribution == []
    # Curve still has one point per day, even if values are zero.
    assert len(bundle.curve) == 8


def test_curve_counts_transfer_in_as_a_contribution(populated_session) -> None:  # type: ignore[no-untyped-def]
    """A transfer_in funds the portfolio just like a deposit, so the cumulative-
    contributions overlay must climb when money arrives via transfer rather than
    a plain deposit — otherwise the equity-curve contributions line stays flat.
    """
    session, as_of = populated_session
    account = session.query(Account).first()
    # Existing fixture deposits 1000 on day 0. Add a transfer_in mid-window.
    session.add(
        Transaction(
            account_id=account.id,
            instrument_id=None,
            date=as_of - timedelta(days=10),
            kind=TransactionKind.TRANSFER_IN.value,
            quantity=None,
            price_native=None,
            net_native=Decimal(500),
            net_eur=Decimal(500),
            source="manual",
        )
    )
    session.flush()
    bundle = build_bundle(session, currency="EUR", lookback_days=29, as_of=as_of)
    # Baseline starts at the day-0 deposit and ends at deposit + transfer_in.
    assert bundle.curve[0].cumulative_contributions == Decimal(1000)
    assert bundle.curve[-1].cumulative_contributions == Decimal(1500)
    # The line genuinely steps up rather than staying flat across the window.
    assert bundle.curve[-1].cumulative_contributions > bundle.curve[0].cumulative_contributions


def test_risk_free_unavailable_yields_none_sharpe(populated_session) -> None:  # type: ignore[no-untyped-def]
    session, as_of = populated_session
    # Make sure no manual / cached rate is present.
    bundle = build_bundle(session, currency="EUR", lookback_days=29, as_of=as_of)
    assert bundle.risk_free_rate is None
    assert bundle.sharpe is None
    assert bundle.sortino is None
    assert bundle.alpha is None


def test_manual_risk_free_enables_sharpe(populated_session) -> None:  # type: ignore[no-untyped-def]
    from investment_dashboard.services import risk_free_service

    session, as_of = populated_session
    risk_free_service.set_manual_rate(session, Decimal("0.04"))
    bundle = build_bundle(session, currency="EUR", lookback_days=29, as_of=as_of)
    assert bundle.risk_free_rate == Decimal("0.04")
    assert bundle.sharpe is not None
    # Sortino can be None on a monotone-up series (no downside variance);
    # that's a legitimate domain result, not a bug.


def test_benchmark_override_via_app_config(populated_session) -> None:  # type: ignore[no-untyped-def]
    session, as_of = populated_session
    benchmark_service.set_symbol(session, "URTH")
    bundle = build_bundle(session, currency="EUR", lookback_days=29, as_of=as_of)
    assert bundle.benchmark_symbol == "URTH"
    # No closes cached for URTH ⇒ no benchmark points.
    assert all(p.benchmark_value is None for p in bundle.curve)
    # Sanity: app_config persisted.
    assert app_config_repo.get(session, benchmark_service.KEY_SYMBOL) == "URTH"
