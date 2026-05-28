"""Tests for the overview query helpers (positions table + treemap aggregation)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.repositories import (
    accounts_repo,
    instrument_overrides_repo,
    instruments_repo,
    prices_repo,
)
from investment_dashboard.ui.pages._overview_query import (
    allocation_treemap,
    get_positions,
    position_rows,
)


@pytest.fixture
def seeded(session: Session) -> None:
    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Fidelity",
        native_currency="USD",
        account_type="brokerage",
    )
    vti = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
    bnd = instruments_repo.get_or_create(session, symbol="BND", asset_class="etf")
    instrument_overrides_repo.set_category(session, vti.id, "US Stocks")
    instrument_overrides_repo.set_category(session, bnd.id, "US Bonds")
    prices_repo.upsert_closes(session, vti.id, {date.today(): Decimal("230.00")})
    prices_repo.upsert_closes(session, bnd.id, {date.today(): Decimal("75.00")})
    session.add_all(
        [
            Transaction(
                account_id=acct.id,
                date=date(2024, 1, 5),
                kind="buy",
                instrument_id=vti.id,
                quantity=Decimal("10"),
                price_native=Decimal("220"),
                net_native=Decimal("-2200"),
                source=TransactionSource.MANUAL,
            ),
            Transaction(
                account_id=acct.id,
                date=date(2024, 1, 5),
                kind="buy",
                instrument_id=bnd.id,
                quantity=Decimal("20"),
                price_native=Decimal("74"),
                net_native=Decimal("-1480"),
                source=TransactionSource.MANUAL,
            ),
        ]
    )
    session.flush()


def test_positions_table_has_growth_pct(session: Session, seeded: None) -> None:
    positions = get_positions(session)
    rows = position_rows(positions)
    symbols = {r["symbol"] for r in rows}
    assert symbols == {"VTI", "BND"}
    vti_row = next(r for r in rows if r["symbol"] == "VTI")
    # cost 2200, current 2300 ⇒ +4.55 %
    assert "4.55" in vti_row["total_growth_pct"]


def test_treemap_aggregates_by_category(session: Session, seeded: None) -> None:
    positions = get_positions(session)
    data = allocation_treemap(positions)
    labels = {d.label for d in data}
    assert labels == {"US Stocks", "US Bonds"}
    # US Stocks (VTI=2300) > US Bonds (BND=1500) ⇒ sorted descending
    assert data[0].label == "US Stocks"


def test_treemap_handles_no_positions(session: Session) -> None:
    assert allocation_treemap([]) == []
