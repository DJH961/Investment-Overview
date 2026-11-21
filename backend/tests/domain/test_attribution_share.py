"""7.1 P17: ``share_of_pnl`` and ``own_return`` on the attribution rows.

Golden values worked by hand (window 1 Jan 2025 -> 31 Jan 2025, 30 days; a flow on
16 Jan weighs (31 - 16) / 30 = 0.5):

* A: start 1000, bought 100 on 16 Jan, end 1150. P&L = 1150 - 1000 - 100 = 50.
  Average capital = 1000 + 0.5 x 100 = 1050. Own return = 50 / 1050 = 0.047619...
* B: start 500, no flows, end 525. P&L 25, own return 25 / 500 = 0.05.
* Cash: start 200, 100 moved out on 16 Jan (to pay for A), end 100. P&L =
  100 - 200 + 100 = 0. Average capital = 200 - 0.5 x 100 = 150. Own return 0.
* Total P&L 75. Portfolio average capital 1050 + 500 + 150 = 1700; 0.5 % of it is
  8.5 <= 75, so shares are shown: A 50/75 = 2/3, B 25/75 = 1/3, Cash 0.
  (The deprecated column divides by the start total 1700: A = 50/1700.)
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from investment_dashboard.domain.attribution import (
    AttributionRow,
    InstrumentReturn,
    attribute_portfolio_return,
    modified_dietz_denominator,
)

START = date(2025, 1, 1)
END = date(2025, 1, 31)
MID = date(2025, 1, 16)
WINDOW = (START, END)


def _golden() -> dict[str, AttributionRow]:
    rows = [
        InstrumentReturn(
            1, "A", Decimal(1000), Decimal(1150), Decimal(100), flows=((MID, Decimal(100)),)
        ),
        InstrumentReturn(2, "B", Decimal(500), Decimal(525), Decimal(0)),
        InstrumentReturn(
            0, "Cash", Decimal(200), Decimal(100), Decimal(-100), flows=((MID, Decimal(-100)),)
        ),
    ]
    return {r.symbol: r for r in attribute_portfolio_return(rows, window=WINDOW)}


def test_golden_share_of_pnl() -> None:
    out = _golden()
    assert out["A"].share_of_pnl == Decimal(50) / Decimal(75)
    assert out["B"].share_of_pnl == Decimal(25) / Decimal(75)
    assert out["Cash"].share_of_pnl == Decimal(0)


def test_golden_own_return() -> None:
    out = _golden()
    assert out["A"].own_return == Decimal(50) / Decimal(1050)
    assert out["B"].own_return == Decimal("0.05")
    assert out["Cash"].own_return == Decimal(0)


def test_deprecated_pct_still_divides_by_start_total() -> None:
    out = _golden()
    assert out["A"].pct_of_total_return == Decimal(50) / Decimal(1700)


def test_share_withheld_when_total_is_tiny() -> None:
    """Total P&L 5 on average capital 1000 sits exactly at 0.5 % and is shown;
    4 is below it, so the shares are withheld (each would be a ratio of noise)."""
    shown = attribute_portfolio_return(
        [
            InstrumentReturn(1, "A", Decimal(500), Decimal(505), Decimal(0)),
            InstrumentReturn(2, "B", Decimal(500), Decimal(500), Decimal(0)),
        ],
        window=WINDOW,
    )
    assert {r.symbol: r.share_of_pnl for r in shown} == {"A": Decimal(1), "B": Decimal(0)}
    hidden = attribute_portfolio_return(
        [
            InstrumentReturn(1, "A", Decimal(500), Decimal(510), Decimal(0)),
            InstrumentReturn(2, "B", Decimal(500), Decimal(494), Decimal(0)),
        ],
        window=WINDOW,
    )
    assert all(r.share_of_pnl is None for r in hidden)
    assert all(r.own_return is not None for r in hidden)


def test_zero_total_pnl_has_no_share() -> None:
    out = attribute_portfolio_return(
        [
            InstrumentReturn(1, "A", Decimal(100), Decimal(110), Decimal(0)),
            InstrumentReturn(2, "B", Decimal(100), Decimal(90), Decimal(0)),
        ],
        window=WINDOW,
    )
    assert all(r.share_of_pnl is None for r in out)


def test_paid_out_dividend_is_a_flow_out() -> None:
    """Start 1000, end 1000, 10 paid out in cash on 16 Jan: P&L 10, capital 1000 - 5."""
    out = attribute_portfolio_return(
        [
            InstrumentReturn(
                1,
                "X",
                Decimal(1000),
                Decimal(1000),
                Decimal(0),
                dividends_cash=Decimal(10),
                flows=((MID, Decimal(-10)),),
            )
        ],
        window=WINDOW,
    )
    assert out[0].own_return == Decimal(10) / Decimal(995)


def test_own_return_none_without_capital() -> None:
    """Bought 100 on the last day (weight 0), start 0: no capital, no return."""
    out = attribute_portfolio_return(
        [
            InstrumentReturn(
                1, "A", Decimal(0), Decimal(101), Decimal(100), flows=((END, Decimal(100)),)
            )
        ],
        window=WINDOW,
    )
    assert out[0].own_return is None
    assert out[0].share_of_pnl == Decimal(1)


def test_no_window_keeps_old_behaviour() -> None:
    out = attribute_portfolio_return(
        [InstrumentReturn(1, "A", Decimal(100), Decimal(110), Decimal(0))]
    )
    assert out[0].own_return is None
    assert out[0].share_of_pnl == Decimal(1)
    assert out[0].pct_of_total_return == Decimal("0.1")


def test_denominator_weights() -> None:
    assert modified_dietz_denominator(
        Decimal(1000), [(MID, Decimal(100))], start=START, end=END
    ) == Decimal(1050)
    assert modified_dietz_denominator(Decimal(1), [], start=END, end=END) is None


_money = st.integers(min_value=0, max_value=10**7).map(lambda c: Decimal(c) / 100)


@settings(max_examples=60, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(
    st.lists(
        st.tuples(_money, _money, st.integers(min_value=-(10**6), max_value=10**6)),
        min_size=1,
        max_size=8,
    )
)
def test_shares_sum_to_one(rows: list[tuple[Decimal, Decimal, int]]) -> None:
    inputs = [
        InstrumentReturn(i, f"S{i}", s, e, Decimal(c) / 100, flows=((MID, Decimal(c) / 100),))
        for i, (s, e, c) in enumerate(rows, start=1)
    ]
    out = attribute_portfolio_return(inputs, window=WINDOW)
    shares = [r.share_of_pnl for r in out]
    if any(s is None for s in shares):
        assert all(s is None for s in shares)
        return
    total = sum((s for s in shares if s is not None), start=Decimal(0))
    assert abs(total - 1) < Decimal("1e-20")


@given(_money.filter(lambda v: v > 0), _money)
def test_own_return_without_flows_is_simple_return(start: Decimal, end: Decimal) -> None:
    out = attribute_portfolio_return(
        [InstrumentReturn(1, "A", start, end, Decimal(0))], window=WINDOW
    )
    assert out[0].own_return == (end - start) / start
