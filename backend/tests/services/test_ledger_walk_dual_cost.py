"""B-010: native and dual-currency average cost use one share count."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from hypothesis import given, settings
from hypothesis import strategies as st

from investment_dashboard.models import Transaction
from investment_dashboard.services import ledger_walk

D = Decimal
RATE = D("1.25")  # USD per EUR, fixed so the USD leg is the native amount


def _resolver() -> ledger_walk.LegResolver:
    return ledger_walk.LegResolver(
        legs=lambda t: ((t.net_native or D(0)) / RATE, t.net_native or D(0)),
        convert_native=lambda v, _native, _on: (v / RATE, v),
        year_start=date(2024, 1, 1),
        month_start=date(2024, 6, 1),
    )


def _txn(
    kind: str, on: date, qty: str, net: str, price: str | None = None, tid: int = 1
) -> Transaction:
    return Transaction(
        id=tid,
        account_id=1,
        instrument_id=7,
        date=on,
        kind=kind,
        quantity=D(qty),
        net_native=D(net),
        price_native=D(price) if price is not None else None,
        source="manual",
    )


def test_priceless_reinvest_keeps_usd_cost_equal_to_native() -> None:
    """Golden (USD account, so cost_usd must equal cost_native exactly).

    Buy 10 @ 10 = 100. Priceless reinvest of 2 shares: 12 shares, cost 100.
    Sell 6 = half the shares: both costs release half -> 50.
    Before the fix the USD side used 10 shares (6/10 = 60 %) and read 40.
    """
    txns = [
        _txn("buy", date(2024, 1, 2), "10", "-100", tid=1),
        _txn("dividend_reinvest", date(2024, 3, 1), "2", "0", tid=2),
        _txn("sell", date(2024, 4, 1), "-6", "70", tid=3),
    ]
    lots = ledger_walk.walk(txns, reinvest_keys=set(), money_market_ids=set(), resolver=_resolver())
    lot = lots[(1, 7)]
    assert lot.shares == D("6")
    assert lot.cost_native == D("50")
    assert lot.cost_usd == D("50")
    assert lot.cost_eur == D("40")  # 100 / 1.25, half released


_STEP = st.one_of(
    st.tuples(st.just("buy"), st.integers(1, 50), st.integers(1, 500)),
    st.tuples(st.just("reinvest"), st.integers(1, 5), st.integers(0, 200)),
    st.tuples(st.just("sell"), st.integers(1, 60), st.integers(1, 500)),
)


@settings(max_examples=150, deadline=None)
@given(st.lists(_STEP, min_size=1, max_size=12))
def test_usd_cost_tracks_native_cost_for_usd_account(steps: list[tuple[str, int, int]]) -> None:
    """Property: on a USD account, cost_usd == cost_native after any walk.

    Reinvests with price 0 stand for a priceless reinvest (``price_native`` None).
    """
    day = date(2024, 1, 2)
    txns: list[Transaction] = []
    for i, (kind, qty, px) in enumerate(steps, start=1):
        day += timedelta(days=1)
        if kind == "buy":
            txns.append(_txn("buy", day, str(qty), str(-qty * px), tid=i))
        elif kind == "reinvest":
            price = str(px) if px else None
            txns.append(_txn("dividend_reinvest", day, str(qty), "0", price, tid=i))
        else:
            txns.append(_txn("sell", day, str(-qty), str(qty * px), tid=i))
    lot = ledger_walk.walk(txns, reinvest_keys=set(), money_market_ids=set(), resolver=_resolver())[
        (1, 7)
    ]
    assert abs(lot.cost_usd - lot.cost_native) <= D("1e-15") * max(D(1), lot.cost_native)
