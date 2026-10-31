"""Tests for the v1.1 yearly hypothetical-projection helper."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.repositories import accounts_repo
from investment_dashboard.ui.pages._projection_query import (
    DEFAULT_SCENARIOS,
    project,
    project_from_session,
)


def test_project_zero_years_returns_empty() -> None:
    assert project(Decimal("1000"), Decimal("100"), years=0) == []


def test_project_compounds_then_contributes() -> None:
    rows = project(
        Decimal("1000"),
        Decimal("100"),
        years=2,
        scenarios=(Decimal("0.10"),),
        start_year=2030,
    )
    rate = Decimal("0.10")
    # Year 1: 1000 * 1.10 + 100 = 1200
    # Year 2: 1200 * 1.10 + 100 = 1420
    assert rows[0].year == 2031
    assert rows[0].contributed == Decimal("100")
    assert rows[0].values_by_rate[rate] == Decimal("1200.00")
    assert rows[1].year == 2032
    assert rows[1].contributed == Decimal("200")
    assert rows[1].values_by_rate[rate] == Decimal("1420.000")


def test_project_no_contribution_pure_compounding() -> None:
    rows = project(
        Decimal("100"),
        Decimal("0"),
        years=3,
        scenarios=(Decimal("0.05"),),
        start_year=2030,
    )
    rate = Decimal("0.05")
    assert rows[-1].values_by_rate[rate] == Decimal("100") * (Decimal("1.05") ** 3)
    assert rows[-1].contributed == Decimal("0")


def test_project_rejects_negative_years() -> None:
    with pytest.raises(ValueError, match="non-negative"):
        project(Decimal("1"), Decimal("0"), years=-1)


def test_project_rejects_total_loss_rate() -> None:
    with pytest.raises(ValueError, match="zero out"):
        project(Decimal("1"), Decimal("0"), years=1, scenarios=(Decimal("-1"),))


def test_project_from_session_uses_average_contribution(session: Session) -> None:
    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Fid",
        native_currency="USD",
        account_type="brokerage",
    )
    # Two years of deposits: 1000 and 3000 → average 2000.
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

    rows = project_from_session(session, years=3, today=date(2025, 1, 1))
    # Each year contributed grows by the average (2000).
    assert rows[0].contributed == Decimal("2000")
    assert rows[2].contributed == Decimal("6000")
    # All default scenarios are present.
    for rate in DEFAULT_SCENARIOS:
        assert rate in rows[0].values_by_rate
