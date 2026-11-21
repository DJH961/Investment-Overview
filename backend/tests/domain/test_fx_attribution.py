"""Flows / market / currency split (domain.fx_attribution): properties + golden."""

from __future__ import annotations

import functools
from collections.abc import Callable
from datetime import date, timedelta
from decimal import Decimal, localcontext
from typing import Any

from hypothesis import given, settings
from hypothesis import strategies as st

from investment_dashboard.domain import fx_attribution as fa
from investment_dashboard.domain.fx_attribution import AttributionDay, FxRate
from investment_dashboard.domain.late_data import Holding, value_at_rate

D = Decimal
START = date(2024, 1, 1)


def _exact(fn: Callable[..., None]) -> Callable[..., None]:
    """Check the identities in a 200-digit context, so the test's own sums never round."""

    @functools.wraps(fn)
    def run(*args: Any, **kwargs: Any) -> None:
        with localcontext(prec=200):
            fn(*args, **kwargs)

    return run


_money = st.decimals(min_value=D(0), max_value=D(1_000_000), places=2)
_flow = st.decimals(min_value=D(-50_000), max_value=D(50_000), places=2)
_rate = st.decimals(min_value=D("0.8"), max_value=D("1.6"), places=4)


@st.composite
def _ledger(draw: st.DrawFn, *, flat: bool = False) -> list[AttributionDay]:
    n = draw(st.integers(min_value=2, max_value=25))
    fixed = draw(_rate)
    days: list[AttributionDay] = []
    for i in range(n):
        r = fixed if flat else draw(_rate)
        q = fixed if flat else draw(_rate)
        days.append(
            AttributionDay(
                on=START + timedelta(days=i * draw(st.integers(1, 3)) + i),
                book={"USD": draw(_money), "EUR": draw(_money), "GBP": draw(_money)},
                rates={"USD": FxRate(divide_by=r), "GBP": FxRate(divide_by=q)},
                flow=draw(_flow),
            )
        )
    return _sorted_unique(days)


def _sorted_unique(days: list[AttributionDay]) -> list[AttributionDay]:
    out: list[AttributionDay] = []
    for d in sorted(days, key=lambda x: x.on):
        if out and out[-1].on == d.on:
            continue
        out.append(d)
    return out


@settings(max_examples=60, deadline=None)
@given(_ledger())
@_exact
def test_parts_sum_to_each_days_change(days: list[AttributionDay]) -> None:
    for p in fa.attribute_days(days, "EUR"):
        assert p.flow + p.market + p.currency == p.end - p.start


@settings(max_examples=60, deadline=None)
@given(_ledger(), st.data())
@_exact
def test_days_sum_to_every_period_and_periods_are_additive(
    days: list[AttributionDay], data: st.DataObject
) -> None:
    parts = fa.attribute_days(days, "EUR")
    if len(parts) < 2:
        return
    i = data.draw(st.integers(min_value=1, max_value=len(parts) - 1))
    whole = fa.bridge(parts)
    left, right = fa.bridge(parts[:i]), fa.bridge(parts[i:])
    assert whole.start + whole.flows + whole.market + whole.currency == whole.end
    assert whole.currency == sum((p.currency for p in parts), D(0))
    assert left.end == right.start
    assert left.currency + right.currency == whole.currency
    assert left.market + right.market == whole.market
    assert left.flows + right.flows == whole.flows
    months = fa.month_totals(parts)
    assert sum((m.currency for m in months), D(0)) == whole.currency
    assert sum((m.market for m in months), D(0)) == whole.market
    years = fa.year_totals(parts)
    assert sum((y.currency for y in years), D(0)) == whole.currency


@settings(max_examples=40, deadline=None)
@given(_ledger(flat=True))
def test_flat_rate_means_zero_currency_part(days: list[AttributionDay]) -> None:
    for p in fa.attribute_days(days, "EUR"):
        assert p.currency == 0
    assert all(
        c.constant_currency == c.value for c in fa.cumulative_series(fa.attribute_days(days, "EUR"))
    )


@settings(max_examples=40, deadline=None)
@given(_ledger())
def test_only_reporting_currency_holdings_have_no_currency_part(
    days: list[AttributionDay],
) -> None:
    eur_only = [AttributionDay(d.on, {"EUR": d.book["EUR"]}, d.rates, d.flow) for d in days]
    for p in fa.attribute_days(eur_only, "EUR"):
        assert p.currency == 0
    usd_only = [AttributionDay(d.on, {"USD": d.book["USD"]}, {}, d.flow) for d in days]
    for p in fa.attribute_days(usd_only, "USD"):
        assert p.currency == 0


@settings(max_examples=60, deadline=None)
@given(_money, _money, _rate, _rate, _rate)
@_exact
def test_inside_plus_outside_is_the_currency_part(
    usd: Decimal, gbp: Decimal, prev: Decimal, opn: Decimal, close: Decimal
) -> None:
    book = {"USD": usd, "GBP": gbp, "EUR": D(5)}

    def rates(r: Decimal) -> dict[str, FxRate]:
        return {"USD": FxRate(divide_by=r), "GBP": FxRate(divide_by=r * D("0.85"))}

    legs = fa.session_legs(
        book, "EUR", prev_close=rates(prev), session_open=rates(opn), session_close=rates(close)
    )
    assert legs.outside + legs.inside == legs.currency
    day = fa.attribute_days(
        [
            AttributionDay(START, book, rates(prev)),
            AttributionDay(START + timedelta(1), book, rates(close)),
        ],
        "EUR",
    )[0]
    assert legs.currency == day.currency


@settings(max_examples=40, deadline=None)
@given(_money, _money, _rate, _rate)
def test_same_convention_as_value_at_rate(
    usd: Decimal, eur: Decimal, prev: Decimal, now: Decimal
) -> None:
    """C_t equals the Overview's ``value_at_rate(book, now) - value_at_rate(book, prev)``."""
    holdings = [Holding("USD", usd), Holding("EUR", eur)]
    now_eur, now_usd = value_at_rate(holdings, now)
    prev_eur, prev_usd = value_at_rate(holdings, prev)
    book = {"USD": usd, "EUR": eur}
    c_eur = fa.revaluation(
        book,
        "EUR",
        rates_from={"USD": FxRate(divide_by=prev)},
        rates_to={"USD": FxRate(divide_by=now)},
    )
    c_usd = fa.revaluation(
        book,
        "USD",
        rates_from={"EUR": FxRate(multiply_by=prev)},
        rates_to={"EUR": FxRate(multiply_by=now)},
    )
    tol = D("1e-20")
    assert abs(c_eur - (now_eur - prev_eur)) <= tol
    assert abs(c_usd - (now_usd - prev_usd)) <= tol


def _golden_days() -> list[AttributionDay]:
    rows = [  # (day of Jan 2024, USD book, rate USD per EUR, deposit flow in EUR)
        (1, "1000", "1.25", "0"),
        (2, "1000", "1.25", "0"),
        (3, "1100", "1.25", "0"),
        (4, "2100", "1.25", "800"),
        (5, "2100", "1.25", "0"),
        (6, "2100", "1.00", "0"),
        (7, "2000", "1.00", "0"),
        (8, "2000", "1.00", "0"),
        (9, "2200", "1.00", "0"),
        (10, "2200", "1.00", "0"),
    ]
    return [
        AttributionDay(date(2024, 1, d), {"USD": D(n)}, {"USD": FxRate(divide_by=D(r))}, D(f))
        for d, n, r, f in rows
    ]


def test_golden_ten_day_ledger() -> None:
    """Ten closes (1-10 Jan 2024), all-USD book, EUR view, one deposit, one rate jump.

    Hand arithmetic (E = N / r, C = N_t/r_t - N_t/r_{t-1}, M = dE - C - F):

    ==== ====== ===== ====== ===== ===== =====
    day  N USD  r     E EUR  F     C     M
    ==== ====== ===== ====== ===== ===== =====
    1    1000   1.25  800    (anchor)
    2    1000   1.25  800    0     0     0
    3    1100   1.25  880    0     0     80      100 USD / 1.25
    4    2100   1.25  1680   800   0     0       deposit 1000 USD at 1.25
    5    2100   1.25  1680   0     0     0
    6    2100   1.00  2100   0     420   0       2100/1.00 - 2100/1.25
    7    2000   1.00  2000   0     0     -100
    8    2000   1.00  2000   0     0     0
    9    2200   1.00  2200   0     0     200
    10   2200   1.00  2200   0     0     0
    ==== ====== ===== ====== ===== ===== =====

    Bridge: 800 + 800 (flows) + 180 (market 80 - 100 + 200) + 420 (currency) = 2200.
    Constant-currency line at the end: 2200 - 420 = 1780, *not* 2200 / 1.25 = 1760
    (the 100 USD loss and the 200 USD gain after the jump are worth 1.00 each).
    Session legs of day 6 with an open rate of 1.05: outside = 2100/1.05 - 1680
    = 320, inside = 2100 - 2000 = 100, together 420.
    """
    days = _golden_days()
    parts = fa.attribute_days(days, "EUR")
    assert [p.currency for p in parts] == [
        D(x) for x in ("0", "0", "0", "0", "420", "0", "0", "0", "0")
    ]
    assert [p.market for p in parts] == [
        D(x) for x in ("0", "80", "0", "0", "0", "-100", "0", "200", "0")
    ]
    assert [p.flow for p in parts] == [
        D(x) for x in ("0", "0", "800", "0", "0", "0", "0", "0", "0")
    ]
    b = fa.bridge(parts)
    assert (b.start, b.flows, b.market, b.currency, b.end) == (
        D(800),
        D(800),
        D(180),
        D(420),
        D(2200),
    )
    series = fa.cumulative_series(parts)
    assert series[0].on == date(2024, 1, 1)
    assert series[0].value == D(800)
    assert series[-1].constant_currency == D(1780)
    assert series[5].currency == D(420)
    assert series[5].constant_currency == D(1680)
    rec = fa.records(parts)
    assert rec.best_day == fa.Extreme("2024-01-06", D(420))
    assert rec.best_month == fa.Extreme("2024-01", D(420))
    assert rec.best_year == fa.Extreme("2024", D(420))
    assert fa.largest_day(parts) == fa.Extreme("2024-01-06", D(420))
    assert fa.median_abs_daily(parts) == D(0)
    months = fa.month_totals(parts)
    assert fa.current_run(months) == fa.Run(sign=1, length=1, since="2024-01", currency=D(420))
    assert fa.tailwind_share(months) == D(1)
    assert fa.months_of_contributions(D(420), [D(800), D(0)]) == D("1.05")
    legs = fa.session_legs(
        {"USD": D(2100)},
        "EUR",
        prev_close={"USD": FxRate(divide_by=D("1.25"))},
        session_open={"USD": FxRate(divide_by=D("1.05"))},
        session_close={"USD": FxRate(divide_by=D("1.00"))},
    )
    assert (legs.outside, legs.inside, legs.currency) == (D(320), D(100), D(420))


def test_golden_usd_view_puts_the_effect_on_euro_holdings() -> None:
    """USD view of 1000 EUR: 1.10 -> 1.20 USD per EUR is +100 USD of currency."""
    days = [
        AttributionDay(
            date(2024, 1, 1), {"EUR": D(1000), "USD": D(50)}, {"EUR": FxRate(multiply_by=D("1.10"))}
        ),
        AttributionDay(
            date(2024, 1, 2), {"EUR": D(1000), "USD": D(50)}, {"EUR": FxRate(multiply_by=D("1.20"))}
        ),
    ]
    (p,) = fa.attribute_days(days, "USD")
    assert (p.start, p.end, p.currency, p.market) == (D(1150), D(1250), D(100), D(0))


def test_rolling_windows_count_business_days() -> None:
    # Mon 1 Jan 2024 anchor, then 14 daily moves; each day's currency part is 1 EUR.
    days = [
        AttributionDay(
            START + timedelta(i),
            {"USD": D(100)},
            {"USD": FxRate(divide_by=D(100) / (D(100) + D(i)) if i else D(1))},
        )
        for i in range(15)
    ]
    parts = fa.attribute_days(days, "EUR")
    assert all(abs(p.currency - 1) < D("1e-20") for p in parts)
    roll = fa.rolling_currency(parts, 5)
    # First business-day point: Fri 5 Jan with five moves (Tue-Fri + Mon 1 Jan? no: 2..5 Jan + Mon 8 Jan).
    assert roll[0].on == date(2024, 1, 8)
    # Window ending Mon 8 Jan covers Tue 2 .. Mon 8 incl. the weekend rows: 7 moves.
    assert abs(roll[0].currency - 7) < D("1e-18")
    # Window ending Fri 12 Jan covers Sat 6 .. Fri 12: Mon-Fri plus the weekend.
    last = next(r for r in roll if r.on == date(2024, 1, 12))
    assert abs(last.currency - 7) < D("1e-18")
    assert fa.ROLLING_WINDOWS == (63, 126, 252)


def test_run_and_share_stop_at_a_sign_change() -> None:
    def m(label: str, c: str) -> fa.Bridge:
        return fa.Bridge(label, START, START, D(0), D(0), D(0), D(c), D(0))

    months = [m("2024-01", "5"), m("2024-02", "-1"), m("2024-03", "-2"), m("2024-04", "-3")]
    assert fa.current_run(months) == fa.Run(sign=-1, length=3, since="2024-02", currency=D(-6))
    assert fa.tailwind_share(months) == D("0.25")
    assert fa.current_run([m("2024-01", "0")]) is None
    assert fa.months_of_contributions(D(10), []) is None
