"""Tests for the dual-currency projection seed loader (v2.5 integration)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.repositories import accounts_repo
from investment_dashboard.ui.pages._projection_model import FALLBACK_EXPECTED_RATE
from investment_dashboard.ui.pages._projection_view import build_seed


def _seed_deposits(session: Session) -> None:
    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Fid",
        native_currency="USD",
        account_type="brokerage",
    )
    session.add_all(
        [
            Transaction(
                account_id=acct.id,
                date=date(2023, 6, 1),
                kind="deposit",
                net_eur=Decimal("1000"),
                source=TransactionSource.MANUAL,
            ),
            Transaction(
                account_id=acct.id,
                date=date(2024, 6, 1),
                kind="deposit",
                net_eur=Decimal("3000"),
                source=TransactionSource.MANUAL,
            ),
        ]
    )
    session.flush()


def test_build_seed_yearly_average_contribution(session: Session) -> None:
    _seed_deposits(session)
    seed = build_seed(session, monthly=False, primary="EUR", today=date(2025, 1, 1))
    # Average of the two positive yearly contributions (1000, 3000) → 2000 EUR.
    assert seed.avg_contribution_eur == Decimal("2000")
    assert seed.periods_per_year == 1
    assert seed.primary == "EUR"


def test_build_seed_falls_back_without_history(session: Session) -> None:
    # No transactions ⇒ no XIRR ⇒ both expected rates default to the fallback,
    # and the contribution average is zero. The seed must still build cleanly.
    seed = build_seed(session, monthly=True, primary="USD", today=date(2025, 1, 1))
    assert seed.avg_contribution_eur == Decimal("0")
    assert seed.expected_rate_eur == FALLBACK_EXPECTED_RATE
    assert seed.expected_rate_usd == FALLBACK_EXPECTED_RATE
    assert seed.usd_per_eur > 0  # never zero/negative, so conversions are safe
    assert seed.periods_per_year == 12
