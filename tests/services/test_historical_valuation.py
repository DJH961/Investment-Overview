"""Regression tests for as-of (historical) portfolio valuation.

Locks the v2.8 item-1 fix: historical valuations (YTD start, MTD start, the
equity curve) must price holdings with the close that was in effect on the
``as_of`` date, not today's latest close. Pricing the past with today's price
inflated the YTD start value and flipped a genuinely-positive YTD into a
reported loss.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.repositories import (
    accounts_repo,
    instruments_repo,
    prices_repo,
)
from investment_dashboard.services import metrics_service, positions_service


def _seed_eur_brokerage(session: Session) -> int:
    a = accounts_repo.create_account(
        session,
        broker="vanguard",
        account_label="EUR Brokerage",
        native_currency="EUR",
        account_type="brokerage",
    )
    return a.id


def _seed_holding(session: Session) -> None:
    """10 shares bought last year; prices rise across the current year."""
    acct_id = _seed_eur_brokerage(session)
    instr = instruments_repo.get_or_create(session, symbol="ACME", native_currency="EUR")
    session.add(
        Transaction(
            account_id=acct_id,
            instrument_id=instr.id,
            date=date(2024, 12, 15),
            kind="buy",
            quantity=Decimal("10"),
            price_native=Decimal("100.00"),
            net_native=Decimal("-1000.00"),
            net_eur=Decimal("-1000.00"),
            source="manual",
        )
    )
    prices_repo.upsert_closes(
        session,
        instr.id,
        {
            date(2025, 1, 1): Decimal("100.00"),  # start of year
            date(2025, 6, 1): Decimal("130.00"),  # mid-year (up 30%)
            date(2099, 1, 2): Decimal("999.00"),  # "today" — must NOT leak into history
        },
    )
    session.flush()


def test_historical_value_uses_historical_price(session: Session) -> None:
    _seed_holding(session)
    # Jan-1 valuation uses the Jan-1 close (100), not the far-future 999.
    assert positions_service.total_portfolio_value(session, as_of=date(2025, 1, 1)) == Decimal(
        "1000.00"
    )
    # Mid-year valuation uses the mid-year close (130).
    assert positions_service.total_portfolio_value(session, as_of=date(2025, 6, 1)) == Decimal(
        "1300.00"
    )


def test_ytd_growth_positive_when_prices_rose(session: Session) -> None:
    _seed_holding(session)
    metrics = metrics_service.compute_portfolio_metrics(session, as_of=date(2025, 6, 1))
    # Start-of-year 1000 → 1300 with no 2025 contributions ⇒ +30% YTD.
    assert metrics.ytd_growth_pct is not None
    assert metrics.ytd_growth_pct > 0
    assert abs(metrics.ytd_growth_pct - Decimal("0.30")) < Decimal("0.001")
