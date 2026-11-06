"""Property tests: capital gain and dividend income always add back to total return."""

from __future__ import annotations

from decimal import Decimal

from hypothesis import given
from hypothesis import strategies as st

from investment_dashboard.domain.returns import capital_gain, capital_gain_excl_income

money = st.decimals(min_value=Decimal("-1e9"), max_value=Decimal("1e9"), places=2)
positive = st.decimals(min_value=Decimal(0), max_value=Decimal("1e9"), places=2)


@given(total_return=money, income=positive)
def test_gain_plus_income_is_total_return(total_return: Decimal, income: Decimal) -> None:
    assert capital_gain_excl_income(total_return, income) + income == total_return


@given(value=positive, contributions=positive, realised_cash=positive, reinvested=positive)
def test_reinvested_income_never_changes_total_return(
    value: Decimal, contributions: Decimal, realised_cash: Decimal, reinvested: Decimal
) -> None:
    """Reinvested dividends sit in ``value``; they move between gain and income only."""
    total_return = capital_gain(contributions, value, realised_cash)
    income = realised_cash + reinvested
    gain = capital_gain_excl_income(total_return, income)
    assert gain + income == total_return
    assert gain == value - contributions - reinvested
