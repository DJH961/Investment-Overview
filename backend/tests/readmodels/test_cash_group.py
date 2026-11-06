"""Money-market funds are Cash in the allocation calculators, and held cash is investable."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.readmodels import allocations as allocations_rm
from investment_dashboard.readmodels import calculator as calculator_rm
from investment_dashboard.readmodels import rebalance
from investment_dashboard.readmodels.queries.calculator_query import build_calculator_data
from investment_dashboard.repositories import (
    accounts_repo,
    fx_repo,
    instrument_overrides_repo,
    instruments_repo,
    prices_repo,
)

FX = Decimal("1.25")  # USD per EUR


def _buy(acct_id: int, iid: int, qty: str, price: str) -> Transaction:
    return Transaction(
        account_id=acct_id,
        date=date(2024, 1, 5),
        kind="buy",
        instrument_id=iid,
        quantity=Decimal(qty),
        price_native=Decimal(price),
        net_native=-(Decimal(qty) * Decimal(price)),
        source=TransactionSource.MANUAL,
    )


@pytest.fixture
def seeded(session: Session) -> dict[str, int]:
    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Fidelity",
        native_currency="USD",
        account_type="brokerage",
    )
    ids: dict[str, int] = {}
    for symbol, asset_class, category, price, qty in [
        ("VTI", "etf", "US", "100", "30"),  # 3000 USD
        ("VXUS", "etf", "International", "50", "20"),  # 1000 USD
        ("FXAIX", "mutual_fund", "US", "10", "100"),  # 1000 USD
        ("VMFXX", "mutual_fund", None, "1", "1000"),  # 1000 USD of cash
    ]:
        instr = instruments_repo.get_or_create(session, symbol=symbol, asset_class=asset_class)
        if category:
            instrument_overrides_repo.set_category(session, instr.id, category)
        prices_repo.upsert_closes(session, instr.id, {date.today(): Decimal(price)})
        session.add(_buy(acct.id, instr.id, qty, price))
        ids[symbol] = instr.id
    fx_repo.upsert_rates(session, {date(2024, 1, 5): FX, date.today(): FX})
    session.flush()
    return ids


def test_money_market_lands_in_cash_group(session: Session, seeded: dict[str, int]) -> None:
    data = build_calculator_data(session)
    cash_cat = next(c for c in data.categories if c.name == "Cash")
    assert [m.symbol for m in cash_cat.members] == ["VMFXX"]
    assert cash_cat.is_cash
    by_symbol = {i.symbol: i for i in data.instruments}
    assert by_symbol["VMFXX"].is_cash
    assert not by_symbol["FXAIX"].is_cash  # a real mutual fund stays a fund
    assert by_symbol["FXAIX"].category == "US"
    assert data.cash_eur == Decimal(1000) / FX


def test_inputs_expose_investable_cash_in_ccy(session: Session, seeded: dict[str, int]) -> None:
    eur = calculator_rm.build_inputs(session, ccy="EUR")
    usd = calculator_rm.build_inputs(session, ccy="USD")
    assert Decimal(eur["investable_cash"]) == Decimal(800)
    assert Decimal(usd["investable_cash"]) == Decimal(1000)
    cash = [i for i in eur["instruments"] if i["is_cash"]]
    assert [i["symbol"] for i in cash] == ["VMFXX"]


def test_drift_puts_cash_in_its_own_bucket_and_never_asks_to_sell_it(
    session: Session, seeded: dict[str, int]
) -> None:
    allocations_rm.save_target(
        session,
        target_id=None,
        name="T",
        active=True,
        allow_sell=True,
        display_currency=None,
        items=[(seeded["VTI"], Decimal(60), False), (seeded["VXUS"], Decimal(40), False)],
    )
    out = allocations_rm.build(session, ccy="EUR")
    labels = {b["label"] for b in out["current_by_asset_class"]}
    assert "Cash" in labels
    assert "mutual_fund" in labels  # FXAIX
    row = next(r for r in out["drift"] if r["label"] == "VMFXX")
    assert row["category"] == "Cash"
    assert row["is_cash"] is True
    assert Decimal(row["delta_value"]) == 0
    assert Decimal(row["drift_pp"]) == 0


def _plan(session: Session, ids: dict[str, int], amount: str, **kw: object) -> dict[str, object]:
    return rebalance.build_builder_plan(
        session,
        amount=Decimal(amount),
        ccy="EUR",
        allow_fractional=True,
        allow_sell=False,
        mode="fund",
        fund_weights={ids["VTI"]: Decimal(50), ids["VXUS"]: Decimal(50)},
        **kw,  # type: ignore[arg-type]
    )


def test_cash_is_not_a_buy_candidate_and_spending_it_is_not_double_counted(
    session: Session, seeded: dict[str, int]
) -> None:
    plan = _plan(session, seeded, "800", use_held_cash=True)
    rows = plan["rows"]
    assert isinstance(rows, list)
    assert "VMFXX" not in {r["symbol"] for r in rows}
    summary = plan["summary"]
    assert isinstance(summary, dict)
    assert Decimal(summary["held_cash"]) == Decimal(800)
    assert Decimal(summary["from_held_cash"]) == Decimal(800)
    # Everything held in cash goes into the ETFs; the plan total after is the ETFs'
    # value (3000+1000 USD = 3200 EUR) plus the 800 EUR moved, not 800 on top of cash.
    bought = sum(Decimal(r["add_value"]) for r in rows)
    assert bought == Decimal(800)
    after = sum(Decimal(r["current_value"]) + Decimal(r["add_value"]) for r in rows)
    assert after == Decimal(3200) + Decimal(800)
    # The cash that funds it is exactly what the Cash group holds: nothing left over.
    assert build_calculator_data(session).cash_eur - Decimal(800) == 0


def test_without_use_held_cash_from_held_is_none(session: Session, seeded: dict[str, int]) -> None:
    summary = _plan(session, seeded, "100")["summary"]
    assert isinstance(summary, dict)
    assert summary["from_held_cash"] is None
    assert Decimal(summary["held_cash"]) == Decimal(800)


def test_targeted_cash_row_falls_by_the_amount_invested(
    session: Session, seeded: dict[str, int]
) -> None:
    ids = seeded
    plan = rebalance.build_builder_plan(
        session,
        amount=Decimal(400),
        ccy="EUR",
        allow_fractional=True,
        allow_sell=True,
        mode="fund",
        fund_weights={ids["VTI"]: Decimal(50), ids["VXUS"]: Decimal(25), ids["VMFXX"]: Decimal(25)},
        use_held_cash=True,
    )
    rows = {r["symbol"]: r for r in plan["rows"]}  # type: ignore[attr-defined]
    # 400 of the 800 EUR cash was spent: the Cash row now counts 400, not 800 + 400.
    assert Decimal(rows["VMFXX"]["current_value"]) == Decimal(400)
    total_after = sum(Decimal(r["current_value"]) + Decimal(r["add_value"]) for r in rows.values())
    # 3200 (ETFs) + 400 (cash left) + 400 (new into funds), no stock-fund FXAIX in the plan.
    assert total_after == Decimal(4000)
