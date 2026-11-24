"""A tailwind / headwind is read from the value as printed: a zero on screen is neutral."""

from __future__ import annotations

from decimal import Decimal

from hypothesis import given
from hypothesis import strategies as st

from investment_dashboard.readmodels import currency, currency_deposits, currency_effect
from investment_dashboard.readmodels._serialize import kind_at_display

D = Decimal


def test_golden_money_prints_whole_units() -> None:
    # "$0" on the strip: +0.40 and -0.40 both print as zero.
    assert kind_at_display(D("0.40")) == "neutral"
    assert kind_at_display(D("-0.40")) == "neutral"
    assert kind_at_display(D("0.50")) == "tailwind"
    assert kind_at_display(D("-0.50")) == "headwind"
    assert kind_at_display(D("14895")) == "tailwind"
    assert kind_at_display(D(0)) == "neutral"


def test_golden_fraction_prints_one_digit_of_points() -> None:
    # 0.04 pp prints as "0.0 pp"; 0.05 pp prints as "0.1 pp".
    assert kind_at_display(D("0.0004"), fraction=True) == "neutral"
    assert kind_at_display(D("-0.0004"), fraction=True) == "neutral"
    assert kind_at_display(D("0.0005"), fraction=True) == "tailwind"
    assert kind_at_display(D("-0.0005"), fraction=True) == "headwind"


def test_every_kind_helper_shares_the_rule() -> None:
    tiny = D("0.37")
    assert currency._kind(tiny) == "neutral"
    assert currency_effect.kind_of(tiny) == "neutral"
    assert currency_deposits._kind(tiny) == "neutral"
    assert currency._kind(D("0.0003"), fraction=True) == "neutral"
    assert currency_effect.kind_of(D("-0.0003"), fraction=True) == "neutral"


@given(
    value=st.decimals(min_value=D("-1e6"), max_value=D("1e6"), places=6),
    fraction=st.booleans(),
)
def test_property_a_printed_zero_is_never_a_tailwind_or_headwind(
    value: Decimal, fraction: bool
) -> None:
    kind = kind_at_display(value, fraction=fraction)
    printed = (value * 100).quantize(D("0.1")) if fraction else value.quantize(D(1))
    if printed == 0:
        assert kind == "neutral"
    else:
        assert kind == ("tailwind" if value > 0 else "headwind")
