# ruff: noqa: PT018
"""Setup-flow defaults: the conversion's dollars and the split of the buys."""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.models import Account, FxHistory, Instrument, Transaction
from investment_dashboard.readmodels import rebalance, recurring_setup

D = Decimal


def test_split_whole_dollars_golden() -> None:
    split = recurring_setup.split_whole_dollars
    # $50 against a 60 / 40 plan.
    assert split(D("50"), {1: D("60"), 2: D("40")}) == {1: D("30"), 2: D("20")}
    # Three equal parts: the leftover dollars go to the lower ids, the sum stays $50.
    assert split(D("50"), {1: D(1), 2: D(1), 3: D(1)}) == {1: D("17"), 2: D("17"), 3: D("16")}
    assert split(D("50"), {1: D("50"), 2: D("30"), 3: D("20")}) == {
        1: D("25"),
        2: D("15"),
        3: D("10"),
    }
    # Awkward weights still sum to the total, whole dollars only.
    parts = split(D("50"), {1: D("33.3"), 2: D("16.7")})
    assert parts == {1: D("33"), 2: D("17")} and sum(parts.values()) == 50
    assert split(D("0"), {1: D(1)}) == {} and split(D("50"), {}) == {}


def _account(session: Session) -> tuple[Account, Instrument, Instrument]:
    acct = Account(broker="fidelity", account_label="Brokerage", native_currency="USD")
    a = Instrument(symbol="AAA", name="A fund", asset_class="etf", native_currency="USD")
    b = Instrument(symbol="BBB", name="B fund", asset_class="etf", native_currency="USD")
    fund = Instrument(
        symbol="VMFXX", name="Money Market", asset_class="mutual_fund", native_currency="USD"
    )
    session.add_all([acct, a, b, fund])
    session.flush()
    day = exchange_today() - timedelta(days=10)
    for ins, gross in ((a, "300"), (b, "100"), (fund, "400")):
        session.add(
            Transaction(
                account_id=acct.id,
                date=day,
                kind="buy",
                instrument_id=ins.id,
                quantity=D("1"),
                price_native=D(gross),
                gross_native=D(gross),
                net_native=-D(gross),
                source="manual",
            )
        )
    session.flush()
    return acct, a, b


def _no_plan(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_a: object, **_k: object) -> None:
        raise rebalance.RebalanceInputError("No target allocation found")

    monkeypatch.setattr(rebalance, "build_target_plan", boom)


def test_split_follows_the_allocation_plan_for_the_accounts_holdings(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    acct, a, b = _account(session)

    def fake_plan(*_a: object, **_k: object) -> rebalance.TargetPlan:
        rows = [
            rebalance.PlanRow(a.id, "AAA", "A", D("60"), D("0"), D("30"), D("10"), D("3"), False),
            rebalance.PlanRow(b.id, "BBB", "B", D("40"), D("0"), D("20"), D("10"), D("2"), False),
            # A fund this account does not buy (and the money-market fund) is left out.
            rebalance.PlanRow(999, "ZZZ", "Z", D("10"), D("0"), D("99"), D("10"), D("9"), False),
        ]
        return rebalance.TargetPlan("USD", 1, "My plan", D("50"), D("0"), False, True, None, rows)

    monkeypatch.setattr(rebalance, "build_target_plan", fake_plan)
    got = recurring_setup.buy_split(session, account_id=acct.id, total=D("50"))
    assert (got.method, got.allocation_name, got.has_allocation_plan) == (
        "allocation",
        "My plan",
        True,
    )
    assert [(leg.symbol, leg.amount) for leg in got.legs] == [("AAA", D("30")), ("BBB", D("20"))]


def test_without_a_plan_the_split_follows_recent_buys_then_equal(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    acct, _a, _b = _account(session)
    _no_plan(monkeypatch)
    got = recurring_setup.buy_split(session, account_id=acct.id, total=D("200"))
    assert (got.method, got.has_allocation_plan) == ("history", False)
    assert [(leg.symbol, leg.amount) for leg in got.legs] == [("AAA", D("150")), ("BBB", D("50"))]
    assert sum(leg.amount for leg in got.legs) == 200
    # No recent buys (older than the lookback): equal parts.
    for t in session.query(Transaction):
        t.date = exchange_today() - timedelta(days=400)
    session.flush()
    equal = recurring_setup.buy_split(session, account_id=acct.id, total=D("51"))
    assert equal.method == "equal"
    assert sorted(leg.amount for leg in equal.legs) == [D("25"), D("26")]


def test_nothing_to_split_without_holdings_or_a_total(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    acct = Account(broker="fidelity", account_label="Empty", native_currency="USD")
    session.add(acct)
    session.flush()
    _no_plan(monkeypatch)
    assert recurring_setup.buy_split(session, account_id=acct.id, total=D("50")).method == "none"


def test_conversion_estimate_is_the_ecb_rate_less_the_fee_in_whole_dollars(
    session: Session,
) -> None:
    assert recurring_setup.conversion_estimate(session, eur=D("1000"), provider="revolut") is None
    session.add(FxHistory(date=exchange_today(), base="EUR", quote="USD", rate=D("1.1600")))
    session.flush()
    got = recurring_setup.conversion_estimate(
        session, eur=D("1000"), provider="revolut", fee_eur=D("2.50")
    )
    assert got is not None
    assert got.off_pct is None and got.rate == D("1.16")  # no history: plain ECB
    assert got.usd == D("1157")  # (1000 - 2.50) x 1.16 = 1157.10


def test_conversion_estimate_with_fixed_usd_computes_eur_and_cadence(session: Session) -> None:
    assert recurring_setup.conversion_estimate(session, usd=D("1000"), provider="revolut") is None
    session.add(FxHistory(date=exchange_today(), base="EUR", quote="USD", rate=D("1.2500")))
    session.flush()
    got = recurring_setup.conversion_estimate(
        session,
        usd=D("1000"),
        provider="revolut",
        fee_eur=D("2.50"),
        conversion=("months", 1),
        deposit=("weeks", 2),
    )
    assert got is not None
    assert got.rate == D("1.2500")
    assert got.usd == D("1000")
    assert got.eur == D("803")  # 1000 / 1.25 + 2.50 = 802.50 -> 803
    assert got.deposit_usd == D("462")  # 1000 * 12 / 26 = 461.538... -> 462


def test_a_monthly_deposit_is_spread_over_the_buy_runs(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    acct, _a, _b = _account(session)
    _no_plan(monkeypatch)
    monthly = ("months", 1)

    def run_total(buy: tuple[str, int]) -> tuple[Decimal, Decimal, Decimal]:
        got = recurring_setup.buy_split(
            session, account_id=acct.id, total=D("2750"), deposit=monthly, buy=buy
        )
        return got.total, got.deposit_total, sum((leg.amount for leg in got.legs), D(0))

    # Monthly -> weekly: 2,750 x 12 / 52 = 634.62, whole dollars 635, split exactly.
    assert run_total(("weeks", 1)) == (D("635"), D("2750"), D("635"))
    # Monthly -> monthly: the whole deposit each time.
    assert run_total(("months", 1)) == (D("2750"), D("2750"), D("2750"))
    # Monthly -> every 2 weeks: 2,750 x 12 / 26 = 1,269.23.
    assert run_total(("weeks", 2)) == (D("1269"), D("2750"), D("1269"))
    # Without cadences the whole amount is one run (the old behaviour).
    plain = recurring_setup.buy_split(session, account_id=acct.id, total=D("2750"))
    assert (plain.total, plain.deposit_total) == (D("2750"), D("2750"))


def test_mixed_cadences_chain_per_run(session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    acct, _a, _b = _account(session)
    _no_plan(monkeypatch)
    session.add(FxHistory(date=exchange_today(), base="EUR", quote="USD", rate=D("1.1600")))
    session.flush()
    monthly, biweekly, weekly = ("months", 1), ("weeks", 2), ("weeks", 1)
    # Monthly conversion of 1,000 EUR (fee 2.50): (1000 - 2.50) x 1.16 = 1,157.10 a month.
    conv = recurring_setup.conversion_estimate(
        session,
        eur=D("1000"),
        provider="revolut",
        fee_eur=D("2.50"),
        conversion=monthly,
        deposit=biweekly,
    )
    assert conv is not None and conv.usd == D("1157")
    assert conv.deposit_usd == D("534")  # 1,157.10 x 12 / 26 = 534.05 every 2 weeks
    # ... deposited every 2 weeks, bought weekly: half of each deposit a week.
    buys = recurring_setup.buy_split(
        session, account_id=acct.id, total=conv.deposit_usd, deposit=biweekly, buy=weekly
    )
    assert (buys.total, buys.deposit_total) == (D("267"), D("534"))
    # The reverse direction: a weekly conversion deposited monthly (x 52 / 12).
    back = recurring_setup.conversion_estimate(
        session,
        eur=D("1000"),
        provider="revolut",
        fee_eur=D("2.50"),
        conversion=weekly,
        deposit=monthly,
    )
    assert back is not None and back.deposit_usd == D("5014")  # 1,157.10 x 52 / 12 = 5,014.1
    # Same cadence on both sides keeps the figure; no cadences means one run.
    same = recurring_setup.conversion_estimate(
        session,
        eur=D("1000"),
        provider="revolut",
        fee_eur=D("2.50"),
        conversion=monthly,
        deposit=monthly,
    )
    assert same is not None and same.deposit_usd == D("1157")
