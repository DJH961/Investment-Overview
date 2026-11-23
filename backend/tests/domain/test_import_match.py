"""Tests for ``domain.import_match`` (smart import matching)."""

from __future__ import annotations

import random
from datetime import date, timedelta
from decimal import Decimal

from hypothesis import given, settings
from hypothesis import strategies as st

from investment_dashboard.domain.import_match import (
    MatchTolerance,
    TxnFigures,
    business_day_gap,
    is_near_match,
    match_updates,
    within_tolerance,
)

D = Decimal
TOL = MatchTolerance()


def fig(
    key: str,
    *,
    on: date = date(2026, 3, 10),  # a Tuesday
    net: str | None = "-20.00",
    qty: str | None = "0.1",
    symbol: str | None = "VTI",
    kind: str = "buy",
    account: int = 1,
) -> TxnFigures:
    return TxnFigures(
        key=key,
        account_id=account,
        symbol=symbol,
        kind=kind,
        on=on,
        quantity=None if qty is None else D(qty),
        net=None if net is None else D(net),
    )


# -- business days (hand-worked) ----------------------------------------------


def test_business_day_gap_golden() -> None:
    assert business_day_gap(date(2026, 3, 10), date(2026, 3, 10)) == 0
    assert business_day_gap(date(2026, 3, 10), date(2026, 3, 11)) == 1
    assert business_day_gap(date(2026, 3, 13), date(2026, 3, 16)) == 1  # Fri -> Mon
    assert business_day_gap(date(2026, 3, 14), date(2026, 3, 16)) == 1  # Sat -> Mon
    assert business_day_gap(date(2026, 3, 13), date(2026, 3, 14)) == 0  # Fri -> Sat
    assert business_day_gap(date(2026, 3, 13), date(2026, 3, 17)) == 2  # Fri -> Tue
    # Good Friday 2026-04-03 is an NYSE holiday: Thu -> Mon is one session.
    assert business_day_gap(date(2026, 4, 2), date(2026, 4, 6)) == 1


@settings(deadline=None)
@given(st.dates(min_value=date(2020, 1, 1), max_value=date(2030, 1, 1)), st.integers(-30, 30))
def test_business_day_gap_symmetric(a: date, delta: int) -> None:
    b = a + timedelta(days=delta)
    assert business_day_gap(a, b) == business_day_gap(b, a)


# -- tolerance (hand-worked) --------------------------------------------------


def test_tolerance_golden() -> None:
    kw = {"relative": D("0.005"), "absolute": D("0.05")}
    assert within_tolerance(D("20.00"), D("19.99"), **kw)  # 0.01 <= 0.05
    assert within_tolerance(D("20.00"), D("20.05"), **kw)  # exactly the absolute floor
    assert within_tolerance(D("20.00"), D("20.10"), **kw)  # 0.5 % of 20.10 = 0.1005
    assert not within_tolerance(D("20.00"), D("20.11"), **kw)  # 0.11 > 0.1006
    assert within_tolerance(D("1000"), D("1004.9"), **kw)  # 0.5 % of 1004.9 = 5.02
    assert not within_tolerance(D("1000"), D("1006"), **kw)
    assert within_tolerance(None, None, **kw)
    assert not within_tolerance(None, D("1"), **kw)


@settings(deadline=None)
@given(
    st.decimals(min_value=-10000, max_value=10000, places=4),
    st.decimals(min_value=-10000, max_value=10000, places=4),
)
def test_tolerance_symmetric(a: Decimal, b: Decimal) -> None:
    kw = {"relative": D("0.005"), "absolute": D("0.05")}
    assert within_tolerance(a, b, **kw) == within_tolerance(b, a, **kw)


# -- near-match ---------------------------------------------------------------


def test_golden_near_match() -> None:
    ex = fig("e", net="-20.00")
    assert is_near_match(ex, fig("i", net="-19.99", on=date(2026, 3, 11)), TOL)
    assert not is_near_match(ex, fig("i", net="-19.99", on=date(2026, 3, 12)), TOL)  # 2 sessions
    assert not is_near_match(ex, fig("i", net="-21.00"), TOL)
    assert not is_near_match(ex, fig("i", qty="0.2"), TOL)
    assert not is_near_match(ex, fig("i", account=2), TOL)
    assert not is_near_match(ex, fig("i", symbol="VXUS"), TOL)
    assert not is_near_match(ex, fig("i", kind="sell"), TOL)
    assert is_near_match(ex, fig("i", symbol="vti"), TOL)


def test_golden_each_existing_used_once_closest_wins() -> None:
    existing = [fig("e1", net="-20.00")]
    incoming = [fig("i-far", net="-19.97"), fig("i-near", net="-19.99")]
    assert match_updates(existing, incoming) == {"i-near": "e1"}


def test_golden_date_distance_beats_amount_distance() -> None:
    existing = [fig("e1", net="-20.00", on=date(2026, 3, 10))]
    incoming = [
        fig("i-next-day", net="-20.00", on=date(2026, 3, 11)),
        fig("i-same-day", net="-19.96", on=date(2026, 3, 10)),
    ]
    assert match_updates(existing, incoming) == {"i-same-day": "e1"}


def test_two_incoming_two_existing_pair_up() -> None:
    existing = [fig("e1", net="-20.00"), fig("e2", net="-20.04")]
    incoming = [fig("i1", net="-20.04"), fig("i2", net="-20.00")]
    assert match_updates(existing, incoming) == {"i1": "e2", "i2": "e1"}


# -- properties ----------------------------------------------------------------

_money = st.decimals(min_value=-500, max_value=500, places=2)
_qty = st.one_of(st.none(), st.decimals(min_value=-50, max_value=50, places=4))


@st.composite
def figures(draw: st.DrawFn, prefix: str, index: int) -> TxnFigures:
    return TxnFigures(
        key=f"{prefix}{index}",
        account_id=draw(st.integers(1, 2)),
        symbol=draw(st.sampled_from(["VTI", "VXUS", None])),
        kind=draw(st.sampled_from(["buy", "sell", "dividend"])),
        on=date(2026, 3, 2) + timedelta(days=draw(st.integers(0, 9))),
        quantity=draw(_qty),
        net=draw(_money),
    )


@st.composite
def sides(draw: st.DrawFn) -> tuple[list[TxnFigures], list[TxnFigures]]:
    n = draw(st.integers(0, 6))
    m = draw(st.integers(0, 6))
    return (
        [draw(figures("e", i)) for i in range(n)],
        [draw(figures("i", i)) for i in range(m)],
    )


@settings(deadline=None)
@given(sides())
def test_never_matches_across_account_instrument_or_kind(
    data: tuple[list[TxnFigures], list[TxnFigures]],
) -> None:
    existing, incoming = data
    by_e = {e.key: e for e in existing}
    by_i = {i.key: i for i in incoming}
    for ik, ek in match_updates(existing, incoming).items():
        a, b = by_e[ek], by_i[ik]
        assert a.account_id == b.account_id
        assert (a.symbol or "") == (b.symbol or "")
        assert a.kind == b.kind
        assert is_near_match(a, b, TOL)


@settings(deadline=None)
@given(sides())
def test_each_existing_and_incoming_used_at_most_once(
    data: tuple[list[TxnFigures], list[TxnFigures]],
) -> None:
    existing, incoming = data
    result = match_updates(existing, incoming)
    assert len(set(result.values())) == len(result)
    assert set(result) <= {i.key for i in incoming}
    assert set(result.values()) <= {e.key for e in existing}


@settings(deadline=None)
@given(sides(), st.integers(0, 10_000))
def test_result_independent_of_input_order(
    data: tuple[list[TxnFigures], list[TxnFigures]], seed: int
) -> None:
    existing, incoming = data
    rng = random.Random(seed)
    shuffled_e = list(existing)
    shuffled_i = list(incoming)
    rng.shuffle(shuffled_e)
    rng.shuffle(shuffled_i)
    assert match_updates(existing, incoming) == match_updates(shuffled_e, shuffled_i)


@settings(deadline=None)
@given(figures("e", 0), figures("i", 0))
def test_near_match_symmetric(a: TxnFigures, b: TxnFigures) -> None:
    assert is_near_match(a, b, TOL) == is_near_match(b, a, TOL)


# -- estimated profile (recurring-plan estimates) ---------------------------------


def est(key: str, **kw: str) -> TxnFigures:
    base = fig(key, **kw)  # type: ignore[arg-type]
    return TxnFigures(**{**base.__dict__, "profile": "estimated"})


def test_estimated_profile_golden() -> None:
    # 100.00 estimate; the real buy is booked 3 sessions later at 101.50 (1.5 %), other shares.
    ex = est("e", net="-100.00", qty="0.5")
    inc = fig("i", net="-101.50", qty="0.49", on=date(2026, 3, 13))
    assert match_updates([ex], [inc]) == {"i": "e"}
    # The same figures against a confirmed row do not match.
    assert match_updates([fig("e", net="-100.00", qty="0.5")], [inc]) == {}
    # Beyond the estimate limits: 4 sessions, or 3 % off.
    assert match_updates([ex], [fig("i", net="-100.00", on=date(2026, 3, 16))]) == {}
    assert match_updates([ex], [fig("i", net="-103.00", qty="0.5")]) == {}


def test_estimated_ignores_quantity_only_for_trades() -> None:
    div = est("e", kind="dividend", net="5.00", qty="1")
    assert match_updates([div], [fig("i", kind="dividend", net="5.00", qty="9")]) == {}


def test_estimated_row_preferred_over_confirmed() -> None:
    confirmed = fig("c", net="-100.00")
    estimate = est("e", net="-100.00")
    inc = fig("i", net="-100.00")
    assert match_updates([confirmed, estimate], [inc]) == {"i": "e"}
