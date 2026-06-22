"""Tests for the Calculator page data builder (``_calculator_query``)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.repositories import (
    accounts_repo,
    fx_repo,
    instrument_overrides_repo,
    instruments_repo,
    prices_repo,
)
from investment_dashboard.ui.pages._calculator_query import build_calculator_data


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
    vxus = instruments_repo.get_or_create(session, symbol="VXUS", asset_class="etf")
    veu = instruments_repo.get_or_create(session, symbol="VEU", asset_class="etf")
    instrument_overrides_repo.set_category(session, vti.id, "US")
    instrument_overrides_repo.set_category(session, vxus.id, "International")
    instrument_overrides_repo.set_category(session, veu.id, "International")
    prices_repo.upsert_closes(session, vti.id, {date.today(): Decimal("100.00")})
    prices_repo.upsert_closes(session, vxus.id, {date.today(): Decimal("50.00")})
    prices_repo.upsert_closes(session, veu.id, {date.today(): Decimal("25.00")})
    fx_repo.upsert_rates(
        session,
        {date(2024, 1, 5): Decimal("1.25"), date.today(): Decimal("1.25")},
    )
    session.add_all(
        [
            Transaction(
                account_id=acct.id,
                date=date(2024, 1, 5),
                kind="buy",
                instrument_id=vti.id,
                quantity=Decimal("30"),
                price_native=Decimal("100"),
                net_native=Decimal("-3000"),
                source=TransactionSource.MANUAL,
            ),
            Transaction(
                account_id=acct.id,
                date=date(2024, 1, 5),
                kind="buy",
                instrument_id=vxus.id,
                quantity=Decimal("20"),
                price_native=Decimal("50"),
                net_native=Decimal("-1000"),
                source=TransactionSource.MANUAL,
            ),
        ]
    )
    session.flush()


def test_groups_by_category_and_computes_pcts(session: Session, seeded: None) -> None:
    data = build_calculator_data(session)
    cats = {c.name: c for c in data.categories}
    assert set(cats) == {"US", "International"}
    # US holds 30*100=3000 USD; Intl holds 20*50=1000 USD. Total 4000 → 75/25.
    assert cats["US"].current_pct == Decimal(75)
    assert cats["International"].current_pct == Decimal(25)
    # Heaviest category leads.
    assert data.categories[0].name == "US"


def test_includes_unheld_instrument_in_its_category(session: Session, seeded: None) -> None:
    data = build_calculator_data(session)
    intl = next(c for c in data.categories if c.name == "International")
    symbols = {m.symbol for m in intl.members}
    # VEU is in International but currently unheld — it must still appear.
    assert symbols == {"VXUS", "VEU"}
    veu = next(m for m in intl.members if m.symbol == "VEU")
    assert veu.current_value_eur == Decimal(0)
    assert veu.current_pct == Decimal(0)


def test_price_converted_to_eur_for_share_math(session: Session, seeded: None) -> None:
    data = build_calculator_data(session)
    by_symbol = {i.symbol: i for i in data.instruments}
    # USD close 100 at 1.25 USD/EUR → 80 EUR.
    assert by_symbol["VTI"].price_eur == Decimal(80)


def test_inactive_instrument_excluded(session: Session, seeded: None) -> None:
    vxus = instruments_repo.get_or_create(session, symbol="VXUS", asset_class="etf")
    instrument_overrides_repo.set_active(session, vxus.id, False)
    session.flush()
    data = build_calculator_data(session)
    assert all(i.symbol != "VXUS" for i in data.instruments)
