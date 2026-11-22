"""Impact headline returns (``readmodels.currency_effect``): the hardened daily chain.

Root cause pinned here: the attribution book is the holdings plus cash/savings
accounts, not idle broker cash. A deposit is a flow on its own day but enters the
book only on the buy days later; a sale drops the book with no flow until the
proceeds are withdrawn. Chained day by day, those days read as -67 % / +100 % /
-100 % and the product collapses towards -100 % (or divides by zero). The hardened
chain merges such days into one span until the money shows up.

Synthetic ledgers and hand-made day parts only; no real data.
"""

from __future__ import annotations

from collections.abc import Collection, Sequence
from datetime import date, timedelta
from decimal import Decimal

from hypothesis import given, settings
from hypothesis import strategies as st
from sqlalchemy.orm import Session

from investment_dashboard.domain import fx_attribution as fa
from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.readmodels import currency_effect as ce
from investment_dashboard.readmodels.fx_attribution_rows import (
    HoldingDayDividend,
    HoldingDayValue,
)
from investment_dashboard.repositories import accounts_repo, fx_repo

D = Decimal
DAY0 = date(2024, 3, 1)


def _part(
    i: int, start: str | Decimal, end: str | Decimal, flow: str | Decimal = "0"
) -> fa.DayParts:
    s, e, f = D(start), D(end), D(flow)
    return fa.DayParts(DAY0 + timedelta(i), DAY0 + timedelta(i + 1), s, e, f, e - s - f, D(0))


def _naive_chain(parts: Sequence[fa.DayParts]) -> Decimal | None:
    """The 7.2.0 chain: one-day Modified Dietz per day, no merging."""
    growth = D(1)
    for p in parts:
        denom = p.start + p.flow / 2
        if denom <= 0:
            if p.start == 0 and p.end == 0 and p.flow == 0:
                continue
            return None
        growth *= 1 + (p.end - p.start - p.flow) / denom
    return growth - 1


# -- golden values, worked by hand ----------------------------------------------------


def test_golden_deposit_seen_two_days_later() -> None:
    # Day 1: 100 -> 110 (+10 %). Day 2: 50 deposited, not in the book yet (110 -> 110).
    # Day 3: bought: 110 -> 165 (the 50 plus a 5 gain).
    # Day 2 alone would be -50 / 135 = -37 %: implausible, so days 2-3 form one span:
    #   gain  = 165 - 110 - 50 = 5
    #   denom = 110 + 50 * (2 - 0 - 0.5) / 2 = 110 + 37.5 = 147.5
    #   total = 1.1 * (1 + 5 / 147.5) - 1 = 1.1 * 152.5 / 147.5 - 1 = 20.25 / 147.5
    parts = [_part(0, "100", "110"), _part(1, "110", "110", "50"), _part(2, "110", "165")]
    got = ce.chained_return(parts)
    assert got is not None
    assert abs(got - D("20.25") / D("147.5")) < D("1e-20")
    assert abs(got - D("0.13728813559322033898")) < D("1e-18")


def test_golden_sale_then_withdrawal_is_flat() -> None:
    # 1000 held, +1 % on day 1, sold on day 2 (book 0, no flow), proceeds withdrawn day 3.
    # Span days 2-3: gain = 0 - 1010 - (-1010) = 0 -> 0 %. Total = +1 %.
    parts = [
        _part(0, "1000", "1010"),
        _part(1, "1010", "0"),
        _part(2, "0", "0", "-1010"),
    ]
    assert _naive_chain(parts) is None  # the old chain: -100 % on day 2, then 0 / negative
    assert ce.chained_return(parts) == D("0.01")


def test_money_never_seen_by_the_range_end_is_left_out() -> None:
    parts = [_part(0, "1000", "1020"), _part(1, "1020", "0")]  # sold, proceeds idle
    assert ce.chained_return(parts) == D("0.02")


def test_only_empty_days_give_none() -> None:
    assert ce.chained_return([_part(0, "0", "0"), _part(1, "0", "0")]) is None
    assert ce.chained_return([]) is None


# -- reproduction on a synthetic ledger ---------------------------------------------------


class _FakeHoldings:
    """One USD fund in a brokerage account, values given per day (7.1 service stand-in)."""

    def __init__(self, account_id: int, values: dict[date, Decimal]) -> None:
        self.account_id = account_id
        self.values = values

    def holding_values(
        self,
        session: Session,
        start: date,
        end: date,
        instrument_ids: Collection[int] | None = None,
    ) -> Sequence[HoldingDayValue]:
        return [
            HoldingDayValue(d, 1, self.account_id, v, D(1), v, "USD", D(0), D(0))
            for d, v in sorted(self.values.items())
            if start <= d <= end
        ]

    def holding_dividends(
        self,
        session: Session,
        start: date,
        end: date,
        instrument_ids: Collection[int] | None = None,
    ) -> Sequence[HoldingDayDividend]:
        return []


def _txn(session: Session, account_id: int, on: date, kind: str, amount: str) -> None:
    session.add(
        Transaction(
            account_id=account_id,
            date=on,
            kind=kind,
            net_native=D(amount),
            source=TransactionSource.MANUAL,
        )
    )


def test_deposit_before_buy_sale_and_withdrawal_no_longer_wreck_the_chain(
    session: Session,
) -> None:
    """Day 1 deposit 1000 (bought day 4); +1 % a day while held; day 8 deposit 1000
    (bought day 10); day 14 sold everything, day 16 the proceeds withdrawn."""
    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="USD brokerage",
        native_currency="USD",
        account_type="brokerage",
    ).id
    days = 18
    fx_repo.upsert_rates(session, {DAY0 + timedelta(i): D("1.10") for i in range(days)})
    _txn(session, acct, DAY0 + timedelta(1), "deposit", "1000")
    _txn(session, acct, DAY0 + timedelta(8), "deposit", "1000")
    values: dict[date, Decimal] = {}
    held = D(0)
    true_growth = D(1)
    for i in range(days):
        if 4 < i <= 14 and held:
            held *= D("1.01")  # +1 % on every held day
            true_growth *= D("1.01")
        if i == 4:
            held += D(1000)
        if i == 10:
            held += D(1000)
        if i == 14:
            held = D(0)
        values[DAY0 + timedelta(i)] = held
    _txn(session, acct, DAY0 + timedelta(16), "withdrawal", "-1000")
    session.flush()

    life = ce.build_lifetime(
        session, "USD", through=DAY0 + timedelta(days - 1), source=_FakeHoldings(acct, values)
    )
    assert life is not None
    naive = _naive_chain(life.parts)
    assert naive is None or naive <= D("-0.5")  # the bug: None or "super negative"
    got = ce.chained_return(life.parts)
    assert got is not None
    assert got > 0
    # True time-weighted return: +1 % on each of the 9 held days before the sale
    # (days 5-13; day 14 is the sale), the sale proceeds sitting outside the book.
    assert abs(got - (D("1.01") ** 9 - 1)) < D("0.03")


# -- properties ----------------------------------------------------------------------------

_returns = st.lists(
    st.decimals(min_value=D("-0.05"), max_value=D("0.05"), places=4), min_size=1, max_size=40
)


@given(start=st.integers(min_value=100, max_value=10**7), rs=_returns)
def test_no_flows_telescopes_to_end_over_start(start: int, rs: list[Decimal]) -> None:
    value = D(start)
    parts = []
    for i, r in enumerate(rs):
        nxt = value * (1 + r)
        parts.append(_part(i, value, nxt))
        value = nxt
    got = ce.chained_return(parts)
    assert got is not None
    assert abs(got - (value / D(start) - 1)) < D("1e-18")


@settings(max_examples=150)
@given(
    rs=st.lists(
        st.decimals(min_value=D("-0.02"), max_value=D("0.02"), places=4), min_size=5, max_size=40
    ),
    deposits=st.lists(
        st.tuples(
            st.integers(min_value=0, max_value=39),
            st.integers(min_value=0, max_value=5),
            st.integers(min_value=1, max_value=5),
        ),
        max_size=4,
    ),
    scale=st.sampled_from([D(1), D(1000), D("0.37")]),
)
def test_delayed_deposits_stay_close_to_the_true_twr(
    rs: list[Decimal], deposits: list[tuple[int, int, int]], scale: Decimal
) -> None:
    """Deposits (as a multiple of the start) seen in the book 0-5 days late: the chain
    stays near the true time-weighted return, never near -100 %, at any scale."""
    n = len(rs)
    start = D(1000) * scale
    flow_on: dict[int, Decimal] = {}
    seen_on: dict[int, Decimal] = {}
    for day, delay, size in deposits:
        d = day % n
        amount = start * size
        flow_on[d] = flow_on.get(d, D(0)) + amount
        seen = min(d + delay, n - 1)
        seen_on[seen] = seen_on.get(seen, D(0)) + amount
    book = start
    parts = []
    true_growth = D(1)
    for i, r in enumerate(rs):
        before = book
        book = book * (1 + r) + seen_on.get(i, D(0))
        true_growth *= 1 + r
        parts.append(_part(i, before, book, flow_on.get(i, D(0))))
    got = ce.chained_return(parts)
    assert got is not None
    # Every deposit is in the book by the last day: within a few points of the TWR.
    assert abs(got - (true_growth - 1)) < D("0.05")


@given(rs=_returns, k=st.sampled_from([D(2), D(1000), D("0.001")]))
def test_scale_invariance(rs: list[Decimal], k: Decimal) -> None:
    parts = [_part(0, "100", "100", "0"), _part(1, "100", "100", "300")]
    value = D(100)
    for i, r in enumerate(rs, start=2):
        nxt = (value + (D(300) if i == 2 else D(0))) * (1 + r)
        parts.append(_part(i, value, nxt))
        value = nxt
    scaled = [
        fa.DayParts(p.prev_on, p.on, p.start * k, p.end * k, p.flow * k, p.market * k, D(0))
        for p in parts
    ]
    a, b = ce.chained_return(parts), ce.chained_return(scaled)
    assert a is not None
    assert b is not None
    assert abs(a - b) < D("1e-15")


# -- headline wording guards -------------------------------------------------------------


def test_mismatch_note_only_when_signs_differ_as_shown() -> None:
    assert ce.mismatch_note(D("-500"), D("0.01")) is not None
    assert ce.mismatch_note(D("500"), D("0.01")) is None
    assert ce.mismatch_note(D("-500"), None) is None
    assert ce.mismatch_note(D("-0.4"), D("0.01")) is None  # prints as 0
    assert ce.mismatch_note(D("-500"), D("0.0004")) is None  # prints as 0.0 pp


def _side(lead: str, effect: str, pp: str | None) -> dict[str, object]:
    return {"headline": {"lead": lead, "effect": effect, "effect_pp": pp, "note": None}}


def test_link_sides_gives_the_gap_side_the_euro_effect() -> None:
    sides = {"EUR": _side("effect", "-1234.5", "-0.02"), "USD": _side("gap", "0", "-0.02")}
    ce.link_sides(sides)  # type: ignore[arg-type]
    usd = sides["USD"]["headline"]
    assert usd["other_effect"] == "-1234.5"  # type: ignore[index]
    assert usd["other_ccy"] == "EUR"  # type: ignore[index]
    assert usd["note"] is None  # type: ignore[index]
    assert "other_effect" not in sides["EUR"]["headline"]  # type: ignore[operator]


def test_link_sides_explains_a_gap_against_the_euro_money() -> None:
    sides = {"EUR": _side("effect", "800", "-0.02"), "USD": _side("gap", "0", "-0.02")}
    ce.link_sides(sides)  # type: ignore[arg-type]
    assert sides["USD"]["headline"]["note"] == ce.MISMATCH_NOTE  # type: ignore[index]


def test_new_windows_exist() -> None:
    today = date(2026, 6, 30)
    assert ce.range_window("5y", today)[0] == date(2021, 6, 30)
    assert ce.range_window("10y", today)[0] == date(2016, 6, 30)
    assert {"5y", "10y"} <= set(ce.FIXED_RANGES)
