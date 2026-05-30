"""Tests for the JSON read-model layer (sections + full snapshot)."""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from investment_dashboard import readmodels
from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.readmodels import overview as overview_rm
from investment_dashboard.readmodels._serialize import dec, iso
from investment_dashboard.repositories import (
    accounts_repo,
    instrument_overrides_repo,
    instruments_repo,
    prices_repo,
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
    savings = accounts_repo.create_account(
        session,
        broker="savings_bank",
        account_label="Savings",
        native_currency="EUR",
        account_type="savings",
    )
    vti = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
    instrument_overrides_repo.set_category(session, vti.id, "US Stocks")
    prices_repo.upsert_closes(session, vti.id, {date.today(): Decimal("230.00")})
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
                account_id=savings.id,
                date=date(2024, 1, 2),
                kind="deposit",
                net_native=Decimal("1000.00"),
                net_eur=Decimal("1000.00"),
                source=TransactionSource.MANUAL,
            ),
            Transaction(
                account_id=savings.id,
                date=date(2024, 6, 1),
                kind="interest",
                net_native=Decimal("12.00"),
                net_eur=Decimal("12.00"),
                source=TransactionSource.MANUAL,
            ),
        ]
    )
    session.flush()


def test_serialize_helpers() -> None:
    assert dec(None) is None
    assert dec(Decimal("1234.50")) == "1234.50"
    # No scientific notation for small magnitudes.
    assert dec(Decimal("0.00001")) == "0.00001"
    assert iso(None) is None
    assert iso(date(2024, 1, 2)) == "2024-01-02"


def test_overview_readmodel_shape(session: Session, seeded: None) -> None:
    rm = overview_rm.build(session)
    assert set(rm) == {"metrics", "positions", "allocation"}
    vti = next(p for p in rm["positions"] if p["symbol"] == "VTI")
    assert vti["category"] == "US Stocks"
    # cost 2200 native, current 2300 native ⇒ +0.0454…
    assert vti["total_growth_pct"].startswith("0.045")
    assert vti["native_currency"] == "USD"
    labels = {a["label"] for a in rm["allocation"]}
    assert "US Stocks" in labels


def test_overview_readmodel_includes_parity_fields(session: Session, seeded: None) -> None:
    rm = overview_rm.build(session)
    # Portfolio-level KPIs ported from the spreadsheet's ``Total`` block.
    assert "mtd_growth_pct" in rm["metrics"]
    assert "weighted_expense_ratio" in rm["metrics"]
    assert "annual_expense_cost_eur" in rm["metrics"]
    # Per-instrument parity columns.
    vti = next(p for p in rm["positions"] if p["symbol"] == "VTI")
    for key in ("expense_ratio", "capital_gain_native", "xirr", "ytd_growth_pct"):
        assert key in vti
    assert Decimal(vti["capital_gain_native"]) == Decimal("100")


def test_deposits_readmodel(session: Session, seeded: None) -> None:
    rm = readmodels.deposits.build(session)
    assert Decimal(rm["summary"]["total_contrib_eur"]) == Decimal("1000.00")
    kinds = {r["kind"] for r in rm["rows"]}
    assert kinds == {"deposit"}


def test_snapshot_is_json_serializable(session: Session, seeded: None) -> None:
    snap = readmodels.build_snapshot(session)
    assert snap["meta"]["schema_version"] == readmodels.SCHEMA_VERSION
    assert snap["meta"]["base_currency"] == "EUR"
    assert set(snap) == {
        "meta",
        "overview",
        "deposits",
        "transactions",
        "monthly",
        "yearly",
        "analytics",
        "calculator",
    }
    # The whole document must round-trip through the stdlib JSON encoder
    # with no custom default — i.e. only JSON-native types inside.
    text = json.dumps(snap)
    assert json.loads(text)["meta"]["app_version"] == snap["meta"]["app_version"]


def test_snapshot_on_empty_db(session: Session) -> None:
    # Must not raise on a brand-new, empty database.
    snap = readmodels.build_snapshot(session)
    assert snap["overview"]["positions"] == []
    json.dumps(snap)
