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


def _brokerage(session: Session) -> int:
    return accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="USD brokerage",
        native_currency="USD",
        account_type="brokerage",
    ).id


def _impact_life(
    session: Session, acct: int, values: dict[date, Decimal], last: date, ccy: str = "USD"
) -> ce.Lifetime:
    session.flush()
    life = ce.build_lifetime(session, ccy, through=last, source=_FakeHoldings(acct, values))
    assert life is not None
    return life


def test_golden_big_deposit_partly_invested_rest_idle(session: Session) -> None:
    """The fixture's 2023: 1000 deposited, only 700 bought, 300 idle for good.

    Day 1 deposit 1000 (cash 1000). Day 3 buy 700 (cash 300, fund 700). Day 4 the
    fund gains 10 % (770). The idle 300 earns 0 %. By hand: days 1-3 are 0 %
    (1000 in, 1000 in the book), day 4 is (1070 - 1000) / 1000 = +7 %, later days 0 %.
    Without the broker cash the 300 read as a permanent -30 % loss.
    """
    acct = _brokerage(session)
    days = 12
    fx_repo.upsert_rates(session, {DAY0 + timedelta(i): D("1.10") for i in range(days)})
    _txn(session, acct, DAY0 + timedelta(1), "deposit", "1000")
    _txn(session, acct, DAY0 + timedelta(3), "buy", "-700")
    values = {DAY0 + timedelta(i): D(0) for i in range(3)}
    values |= {DAY0 + timedelta(3): D(700)}
    values |= {DAY0 + timedelta(i): D(770) for i in range(4, days)}
    life = _impact_life(session, acct, values, DAY0 + timedelta(days - 1))
    got = ce.chained_return(life.parts)
    assert got == D("0.07")
    assert life.rows[-1].book == {"USD": D(1070)}
    assert life.shortfalls == []
    # EUR view: the idle dollars are dollars too, revalued like the fund.
    eur = _impact_life(session, acct, values, DAY0 + timedelta(days - 1), "EUR")
    assert eur.rows[-1].book == {"USD": D(1070)}


def test_deposit_before_buy_sale_and_withdrawal_no_longer_wreck_the_chain(
    session: Session,
) -> None:
    """Day 1 deposit 1000 (bought day 4); +1 % a day while held; day 8 deposit 1000
    (bought day 10); day 14 sold everything, day 16 1000 of the proceeds withdrawn.
    With the broker cash in the book every day is a plain one-day return."""
    acct = _brokerage(session)
    days = 18
    fx_repo.upsert_rates(session, {DAY0 + timedelta(i): D("1.10") for i in range(days)})
    _txn(session, acct, DAY0 + timedelta(1), "deposit", "1000")
    _txn(session, acct, DAY0 + timedelta(4), "buy", "-1000")
    _txn(session, acct, DAY0 + timedelta(8), "deposit", "1000")
    _txn(session, acct, DAY0 + timedelta(10), "buy", "-1000")
    values: dict[date, Decimal] = {}
    held = D(0)
    for i in range(days):
        if 4 < i <= 14 and held:
            held *= D("1.01")
        if i in (4, 10):
            held += D(1000)
        if i == 14:
            _txn(session, acct, DAY0 + timedelta(14), "sell", str(held))
            held = D(0)
        values[DAY0 + timedelta(i)] = held
    _txn(session, acct, DAY0 + timedelta(16), "withdrawal", "-1000")
    life = _impact_life(session, acct, values, DAY0 + timedelta(days - 1))
    naive = _naive_chain(life.parts)
    got = ce.chained_return(life.parts)
    assert got is not None
    assert naive is not None
    assert got == naive  # nothing held open: the hardening changes nothing here
    # Hand check of the shape: 10 days at +1 % on the fund, diluted on days 8-9 by
    # the idle 1000 (fund about 1030 of a 2030 book): between 1.01**8 and 1.01**10.
    assert D("1.01") ** 8 - 1 < got < D("1.01") ** 10 - 1


def test_negative_broker_cash_is_flagged_and_never_a_fake_return(session: Session) -> None:
    """A buy with no deposit on file (an unimported bank transfer): the balance is
    held at zero and the 500 counts as a deposit that day, not as a +500 gain."""
    acct = _brokerage(session)
    days = 6
    fx_repo.upsert_rates(session, {DAY0 + timedelta(i): D("1.10") for i in range(days)})
    _txn(session, acct, DAY0 + timedelta(1), "deposit", "1000")
    _txn(session, acct, DAY0 + timedelta(1), "buy", "-1000")
    _txn(session, acct, DAY0 + timedelta(3), "buy", "-500")  # no deposit for this
    values = {DAY0: D(0), DAY0 + timedelta(1): D(1000), DAY0 + timedelta(2): D(1000)}
    values |= {DAY0 + timedelta(i): D(1500) for i in range(3, days)}
    life = _impact_life(session, acct, values, DAY0 + timedelta(days - 1))
    assert [(sf.on, sf.native) for sf in life.shortfalls] == [(DAY0 + timedelta(3), D(500))]
    assert life.shortfall_days(date.min, DAY0 + timedelta(days)) == 1
    assert ce.chained_return(life.parts) == 0
    assert sum((p.flow for p in life.parts), D(0)) == D(1500)
    eur = _impact_life(session, acct, values, DAY0 + timedelta(days - 1), "EUR")
    implied = eur.parts[2].flow  # day 3, at that day's rate
    assert implied == D(500) / D("1.10")


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


_DEPOSITS = st.lists(
    st.tuples(
        st.integers(min_value=0, max_value=39),  # day of the flow
        st.integers(min_value=0, max_value=5),  # days until the book sees it
        st.integers(min_value=1, max_value=20),  # size, a multiple of the start
    ),
    max_size=4,
)


def _delayed_ledger(
    rs: Sequence[Decimal], deposits: Sequence[tuple[int, int, int]], start: Decimal
) -> tuple[list[fa.DayParts], Decimal]:
    """Day parts of a book earning ``rs`` whose deposits reach it some days late,
    and the true time-weighted growth factor.

    One transfer at a time, as a broker statement shows it: a deposit is bought
    before the next one is made (a later one moves to the day after).
    """
    n = len(rs)
    flow_on: dict[int, Decimal] = {}
    seen_on: dict[int, Decimal] = {}
    free = 0
    for day, delay, size in sorted(deposits):
        d = max(day % n, free)
        if d > n - 1:
            continue
        amount = start * size
        seen = min(d + delay, n - 1)
        flow_on[d] = amount
        seen_on[seen] = seen_on.get(seen, D(0)) + amount
        free = seen + 1
    book = start
    parts = []
    true_growth = D(1)
    for i, r in enumerate(rs):
        before = book
        book = book * (1 + r) + seen_on.get(i, D(0))
        true_growth *= 1 + r
        parts.append(_part(i, before, book, flow_on.get(i, D(0))))
    return parts, true_growth


@settings(max_examples=300)
@given(
    n=st.integers(min_value=1, max_value=40),
    deposits=_DEPOSITS,
    scale=st.sampled_from([D(1), D(1000), D("0.37")]),
)
def test_money_in_flight_never_makes_a_return(
    n: int, deposits: list[tuple[int, int, int]], scale: Decimal
) -> None:
    """A flat market: deposits of any size, seen any number of days late, give 0 %."""
    parts, _ = _delayed_ledger([D(0)] * n, deposits, D(1000) * scale)
    assert ce.chained_return(parts) == 0


@settings(max_examples=300)
@given(
    rs=st.lists(
        st.decimals(min_value=D("-0.01"), max_value=D("0.01"), places=4), min_size=5, max_size=40
    ),
    deposits=_DEPOSITS,
    scale=st.sampled_from([D(1), D(1000), D("0.37")]),
)
def test_delayed_deposits_stay_close_to_the_true_twr(
    rs: list[Decimal], deposits: list[tuple[int, int, int]], scale: Decimal
) -> None:
    """Deposits (up to 20x the start) seen 0-5 days late, daily moves up to 1 %.

    Outside the merged spans the chain is the exact TWR. Inside one, the waiting money
    dilutes the span's Dietz return, so the error is at most about the span's own
    market move: bounded by ``2 * sum((1.01 ** (delay + 1)) - 1)`` over the deposits.
    Never near -100 %, at any scale.
    """
    parts, true_growth = _delayed_ledger(rs, deposits, D(1000) * scale)
    got = ce.chained_return(parts)
    assert got is not None
    assert got > D("-0.5")
    tol = 2 * sum((D("1.01") ** (delay + 1) - 1 for _d, delay, _s in deposits), D(0))
    assert abs((1 + got) / true_growth - 1) <= tol + D("1e-15")


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


# -- the owner's case and one method for every window -----------------------------------


def test_golden_owner_case_deposit_from_an_empty_book() -> None:
    """Empty book; 1000 deposited on day 1 but bought on day 3; then +1 %, +2 %.

    Day 1 alone: (0 - 0 - 1000) / (0 + 1000 / 2) = -200 % (what the owner saw).
    Days 1-3 as one span: gain 1000 - 0 - 1000 = 0 -> 0 %. Then 1.01 * 1.02 - 1.
    """
    parts = [
        _part(0, "0", "0"),  # before anything
        _part(1, "0", "0", "1000"),  # deposited, cash not in the book
        _part(2, "0", "0"),
        _part(3, "0", "1000"),  # bought
        _part(4, "1000", "1010"),
        _part(5, "1010", "1030.2"),
    ]
    naive_day = (parts[1].end - parts[1].start - parts[1].flow) / (parts[1].flow / 2)
    assert naive_day == D(-2)
    got = ce.chained_return(parts)
    assert got is not None
    assert got > -1
    assert abs(got - D("0.0302")) < D("1e-24")


def _lifetime(parts: Sequence[fa.DayParts]) -> ce.Lifetime:
    return ce.Lifetime("USD", [], list(parts))


def test_all_is_the_product_of_the_years_on_a_synthetic_ledger(session: Session) -> None:
    """A ledger over three calendar years (2023-12-27 .. 2025-01-04) with a deposit
    waiting over the 2023/2024 year end: (1 + All) == prod(1 + year), and a 1-year
    window plus what came before it chains back to All."""
    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="USD brokerage",
        native_currency="USD",
        account_type="brokerage",
    ).id
    first = date(2023, 12, 27)
    last = date(2025, 1, 4)
    fx_repo.upsert_rates(session, {first: D("1.10")})
    _txn(session, acct, first, "deposit", "1000")
    _txn(session, acct, first, "buy", "-1000")
    _txn(session, acct, date(2024, 1, 3), "buy", "-5000")
    _txn(session, acct, date(2023, 12, 30), "deposit", "5000")  # bought 2024-01-03
    values: dict[date, Decimal] = {}
    held = D(1000)
    day = first
    i = 0
    while day <= last:
        if day > first:
            held *= D("1.002") if i % 3 else D("0.997")
        if day == date(2024, 1, 3):
            held += D(5000)
        values[day] = held
        day += timedelta(days=1)
        i += 1
    session.flush()
    life = ce.build_lifetime(session, "USD", through=last, source=_FakeHoldings(acct, values))
    assert life is not None
    today = last + timedelta(days=1)
    whole = ce.window_return(life, *ce.range_window("all", today))
    assert whole is not None
    assert whole > -1
    years = [ce.window_return(life, *ce.range_window(str(y), today)) for y in (2023, 2024, 2025)]
    product = D(1)
    for y in years:
        assert y is not None
        product *= 1 + y
    assert abs((1 + whole) - product) < D("1e-20")
    # A rolling window is a sub-chain: before it times it gives the whole.
    after, through = ce.range_window("1y", today)
    head = ce.window_return(life, date.min, after)
    tail = ce.window_return(life, after, through)
    assert head is not None
    assert tail is not None
    assert abs((1 + head) * (1 + tail) - (1 + whole)) < D("1e-20")


@settings(max_examples=300)
@given(
    rs=st.lists(
        st.decimals(min_value=D("-0.03"), max_value=D("0.03"), places=4), min_size=2, max_size=40
    ),
    deposits=_DEPOSITS,
    cut=st.integers(min_value=0, max_value=40),
)
def test_adjacent_windows_chain_into_the_whole(
    rs: list[Decimal], deposits: list[tuple[int, int, int]], cut: int
) -> None:
    """For any ledger, (1 + left) * (1 + right) == 1 + whole for any cut point."""
    parts, _ = _delayed_ledger(rs, deposits, D(1000))
    life = _lifetime(parts)
    k = cut % (len(parts) + 1)
    cut_day = parts[k - 1].on if k else parts[0].prev_on
    whole = ce.window_return(life, date.min, parts[-1].on)
    left = ce.window_return(life, date.min, cut_day) or D(0)
    right = ce.window_return(life, cut_day, parts[-1].on) or D(0)
    assert whole is not None
    assert abs((1 + left) * (1 + right) - (1 + whole)) < D("1e-20")
