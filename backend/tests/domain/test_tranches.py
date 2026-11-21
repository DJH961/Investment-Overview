"""Tests for :mod:`investment_dashboard.domain.tranches` (7.1, FIFO purchase view).

Golden ledger, one USD account, worked by hand (as of Sat 21 Nov 2026, price 60):

====  ==========  ==============================  =====================================
id    date        row                             open tranches after
====  ==========  ==============================  =====================================
1     2024-02-29  buy 10 @ 100, fee 1 (net -1001)  T1 10 sh, cost 1001
2     2025-01-10  buy 5 @ 120 (net -600)           T1 10 / 1001, T2 5 / 600
3     2025-06-01  split 2:1 (+15 sh)               T1 20 / 1001 (50.05), T2 10 / 600 (60)
4     2025-09-15  buy 4 @ 55 (net -220)            + T3 4 / 220 (55)
5     2026-01-05  sell 25 @ 58                     T1 used up (20), T2 10 -> 5, cost 300
6     2026-03-31  reinvest 1 @ 57                  + T4 1 / 57
7     2026-09-30  reinvest 0.5 @ 62                + T5 0.5 / 31
====  ==========  ==============================  =====================================

Position (ledger walk): 10 + 5 + 15 + 4 - 25 + 1 + 0.5 = 10.5 shares; open
tranches 5 + 4 + 1 + 0.5 = 10.5, so ``matches_position``. One tranche (T1) is
fully sold. The split kept the total cost: 1001 + 600 = 1601 before and after.

* T2 (10 Jan 2025): long-term on 11 Jan 2026 -> long. Age 365 + 315 = 680 days.
  Gain 5 x 60 - 300 = 0.
* T3 (15 Sep 2025): long-term on 16 Sep 2026 -> long. Gain 240 - 220 = 20,
  20 / 220 = 9.09 %.
* T4 (31 Mar 2026): long-term on 1 Apr 2027, 131 days away -> short.
  Gain 60 - 57 = 3, 3 / 57 = 5.26 %.
* T5 (30 Sep 2026): long-term on 1 Oct 2027, 314 days away -> short.
  Gain 30 - 31 = -1, -1 / 31 = -3.23 %.
* Reinvest group: 2 rows, 1.5 shares, cost 88, average 58.67, gain 90 - 88 = 2
  (2.27 %), 0 long, 2 short.
* Long 9 shares (T2 + T3), short 1.5 shares.
* T1 (29 Feb 2024) would have been long-term on 2 Mar 2025 (no 29 Feb in 2025:
  the year ends on 1 Mar, plus a day).
"""

from __future__ import annotations

import random
from datetime import date, timedelta
from decimal import ROUND_DOWN, Decimal
from types import SimpleNamespace

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from investment_dashboard.domain import tranches as tr
from investment_dashboard.domain.tranches import TrancheTxn
from investment_dashboard.services import ledger_walk

D = Decimal
AS_OF = date(2026, 11, 21)
PRICE = D(60)


def _t(
    tid: int,
    day: date,
    kind: str,
    qty: str | None = None,
    net: str | None = None,
    price: str | None = None,
    account: int = 1,
) -> TrancheTxn:
    return TrancheTxn(
        id=tid,
        account_id=account,
        date=day,
        kind=kind,
        quantity=D(qty) if qty is not None else None,
        net_native=D(net) if net is not None else None,
        price_native=D(price) if price is not None else None,
    )


GOLDEN = [
    _t(1, date(2024, 2, 29), "buy", "10", "-1001", "100"),
    _t(2, date(2025, 1, 10), "buy", "5", "-600", "120"),
    _t(3, date(2025, 6, 1), "split", "15"),
    _t(4, date(2025, 9, 15), "buy", "4", "-220", "55"),
    _t(5, date(2026, 1, 5), "sell", "-25", "1450", "58"),
    _t(6, date(2026, 3, 31), "dividend_reinvest", "1", "-57", "57"),
    _t(7, date(2026, 9, 30), "dividend_reinvest", "0.5", "-31", "62"),
]


def _golden_view() -> tr.TrancheView:
    return tr.build_view(
        tr.replay(GOLDEN), as_of=AS_OF, price_native=PRICE, position_quantity=D("10.5")
    )


def test_golden_rows() -> None:
    view = _golden_view()
    rows = {r.tranche.id: r for r in view.rows}
    assert list(rows) == [2, 4, 6, 7]
    t2, t3, t4, t5 = rows[2], rows[4], rows[6], rows[7]
    assert (t2.tranche.quantity_bought, t2.tranche.quantity_left) == (D(10), D(5))
    assert t2.tranche.cost_native == D(300)
    assert t2.tranche.cost_per_share_native == D(60)
    assert t2.long_term_on == date(2026, 1, 11)
    assert (t2.status, t2.days_to_long_term, t2.age_days) == ("long", None, 680)
    assert t2.gain_native == D(0)
    assert t3.tranche.cost_per_share_native == D(55)
    assert (t3.status, t3.gain_native, t3.gain_pct) == ("long", D(20), D(20) / D(220))
    assert t4.tranche.source == "reinvest"
    assert (t4.status, t4.days_to_long_term) == ("short", 131)
    assert (t4.gain_native, t4.gain_pct) == (D(3), D(3) / D(57))
    assert (t5.status, t5.days_to_long_term) == ("short", 314)
    assert (t5.gain_native, t5.gain_pct) == (D(-1), D(-1) / D(31))


def test_golden_split_adjusts_the_sold_tranche_and_keeps_cost() -> None:
    t1 = next(t for t in tr.replay(GOLDEN) if t.id == 1)
    assert t1.quantity_bought == D(20)
    assert t1.cost_per_share_native == D("50.05")
    assert not t1.is_open
    before = tr.replay(GOLDEN[:2])
    after = tr.replay(GOLDEN[:3])
    assert sum(t.cost_native for t in before) == sum(t.cost_native for t in after) == D(1601)


def test_golden_groups_and_totals() -> None:
    view = _golden_view()
    (group,) = view.groups
    assert group.count == 2
    assert group.row_ids == (6, 7)
    assert group.quantity_left == D("1.5")
    assert group.cost_native == D(88)
    assert group.avg_cost_per_share_native == D(88) / D("1.5")
    assert (group.gain_native, group.gain_pct) == (D(2), D(2) / D(88))
    assert (group.long_count, group.short_count) == (0, 2)
    totals = view.totals
    assert totals.quantity_left == D("10.5")
    assert totals.matches_position
    assert (totals.long_quantity, totals.short_quantity) == (D(9), D("1.5"))
    assert totals.fully_sold_count == 1


def test_long_term_on_leap_day_and_plain_day() -> None:
    assert tr.long_term_on(date(2024, 2, 29)) == date(2025, 3, 2)
    assert tr.long_term_on(date(2024, 1, 15)) == date(2025, 1, 16)
    assert tr.long_term_on(date(2023, 2, 28)) == date(2024, 2, 29)


def test_status_soon_boundary() -> None:
    """Long-term on 20 Jan 2027 is 60 days after 21 Nov 2026: soon; 61 days: short."""
    soon = tr.Tranche(1, 1, date(2026, 1, 19), "buy", D(1), D(1), D(10), D(10))
    later = tr.Tranche(2, 1, date(2026, 1, 20), "buy", D(1), D(1), D(10), D(10))
    long_ = tr.Tranche(3, 1, date(2025, 11, 20), "buy", D(1), D(1), D(10), D(10))
    assert tr.classify(soon, as_of=AS_OF, price_native=None).status == "soon"
    assert tr.classify(soon, as_of=AS_OF, price_native=None).days_to_long_term == 60
    assert tr.classify(later, as_of=AS_OF, price_native=None).status == "short"
    row = tr.classify(long_, as_of=AS_OF, price_native=None)
    assert (row.status, row.days_to_long_term, row.gain_native) == ("long", None, None)


def test_same_day_buy_then_sell_uses_the_id_order() -> None:
    """Two buys and a sell on one day: the lower ids are consumed first."""
    day = date(2026, 5, 4)
    txns = [
        _t(3, day, "sell", "-4", "40", "10"),
        _t(2, day, "buy", "5", "-55", "11"),
        _t(1, day, "buy", "3", "-30", "10"),
    ]
    out = {t.id: t for t in tr.replay(txns)}
    assert out[1].quantity_left == 0
    assert out[2].quantity_left == D(4)
    assert out[2].cost_native == D(44)


def test_money_market_reinvest_has_no_cost() -> None:
    txns = [
        _t(1, date(2026, 1, 2), "buy", "100", "-100", "1"),
        _t(2, date(2026, 2, 2), "dividend_reinvest", "0.4", "-0.4", "1"),
    ]
    reinvest = tr.replay(txns, money_market=True)[1]
    assert reinvest.cost_native == 0


def test_accounts_never_pool() -> None:
    """A sell in account 2 cannot consume account 1's older tranche."""
    txns = [
        _t(1, date(2025, 1, 2), "buy", "5", "-50", "10", account=1),
        _t(2, date(2025, 2, 2), "buy", "5", "-60", "12", account=2),
        _t(3, date(2025, 3, 2), "sell", "-2", "26", "13", account=2),
    ]
    out = {t.id: t for t in tr.replay(txns)}
    assert out[1].quantity_left == D(5)
    assert out[2].quantity_left == D(3)


# --- properties ---------------------------------------------------------------

_OPS = st.lists(
    st.tuples(
        st.sampled_from(["buy", "sell", "dividend_reinvest", "split", "dividend_cash", "deposit"]),
        st.integers(min_value=1, max_value=2),  # account
        st.integers(min_value=0, max_value=3),  # days after the previous row
        st.integers(min_value=1, max_value=50_000),  # quantity in 1/1000 shares
        st.integers(min_value=1, max_value=50_000),  # price in cents
        st.sampled_from([D(2), D(3), D("1.5"), D("0.5")]),  # split ratio
        st.floats(min_value=0, max_value=1),  # share of the holding sold
    ),
    min_size=1,
    max_size=25,
)


def _ledger(ops: list[tuple[str, int, int, int, int, Decimal, float]]) -> list[TrancheTxn]:
    """A valid random ledger: sells never exceed the account's holding."""
    held = {1: D(0), 2: D(0)}
    day = date(2024, 1, 2)
    out: list[TrancheTxn] = []
    for i, (kind, acct, gap, q, p, ratio, frac) in enumerate(ops, start=1):
        day += timedelta(days=gap)
        qty = D(q) / 1000
        price = D(p) / 100
        if kind == "sell":
            qty = (held[acct] * D(str(round(frac, 3)))).quantize(D("0.001"), rounding=ROUND_DOWN)
            if qty <= 0:
                continue
            out.append(TrancheTxn(i, acct, day, kind, -qty, qty * price, price))
            held[acct] -= qty
        elif kind == "split":
            if held[acct] <= 0:
                continue
            delta = held[acct] * (ratio - 1)
            out.append(TrancheTxn(i, acct, day, kind, delta, None, None))
            held[acct] += delta
        elif kind in {"buy", "dividend_reinvest"}:
            out.append(TrancheTxn(i, acct, day, kind, qty, -(qty * price), price))
            held[acct] += qty
        else:  # cash rows move no shares
            out.append(TrancheTxn(i, acct, day, kind, None, price, None))
    return out


def _walk_shares(txns: list[TrancheTxn]) -> dict[int, Decimal]:
    rows = [
        SimpleNamespace(
            account_id=t.account_id,
            instrument_id=7,
            kind=t.kind,
            quantity=t.quantity,
            net_native=t.net_native,
            price_native=t.price_native,
            date=t.date,
            account=None,
        )
        for t in sorted(txns, key=lambda t: (t.date, t.id))
    ]
    lots = ledger_walk.walk(rows, reinvest_keys=set(), money_market_ids=set())  # type: ignore[arg-type]
    return {acct: lot.shares for (acct, _iid), lot in lots.items()}


@settings(max_examples=150, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(_OPS)
def test_open_quantity_equals_the_ledger_walk(
    ops: list[tuple[str, int, int, int, int, Decimal, float]],
) -> None:
    txns = _ledger(ops)
    tranches = tr.replay(txns)
    for acct, shares in _walk_shares(txns).items():
        left = sum((t.quantity_left for t in tranches if t.account_id == acct), start=D(0))
        assert abs(left - shares) <= tr.MATCH_TOLERANCE


@settings(max_examples=100, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(_OPS, st.randoms(use_true_random=False))
def test_input_order_does_not_matter(
    ops: list[tuple[str, int, int, int, int, Decimal, float]], rnd: random.Random
) -> None:
    txns = _ledger(ops)
    shuffled = list(txns)
    rnd.shuffle(shuffled)
    assert tr.replay(shuffled) == tr.replay(txns)


@settings(max_examples=100, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(_OPS, st.sampled_from([D(2), D(3), D("1.5"), D("0.25")]))
def test_a_split_preserves_total_cost(
    ops: list[tuple[str, int, int, int, int, Decimal, float]], ratio: Decimal
) -> None:
    txns = _ledger(ops)
    before = tr.replay(txns)
    held = sum((t.quantity_left for t in before if t.account_id == 1), start=D(0))
    if held <= 0:
        return
    last = max((t.date for t in txns), default=date(2024, 1, 2))
    split = TrancheTxn(10_000, 1, last, "split", held * (ratio - 1), None, None)
    after = tr.replay([*txns, split])
    assert sum(t.cost_native for t in after) == sum(t.cost_native for t in before)
    left_after = sum((t.quantity_left for t in after if t.account_id == 1), start=D(0))
    assert abs(left_after - held * ratio) <= tr.MATCH_TOLERANCE
