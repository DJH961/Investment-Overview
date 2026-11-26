"""A fee in dollars on a conversion back (7.4): paid out of the dollars sent.

Golden, worked by hand: 1,100.00 USD sent, fee 5.00 USD, 945.00 EUR received, ECB fixing
1.16.

* dollars converted ``1100 - 5 = 1095``; ``rate = 1095 / 945 = 1.158730``;
* ``all_in = 1100 / 945 = 1.164021`` (every dollar sent per euro received);
* ``fee_eur = 5 / 1.16 = 4.310345``; ``ecb_eur = 1095 / 1.16 = 943.965517``;
* ``spread_eur = 943.965517 - 945 = -1.034483``;
* ``cost_eur = spread + fee = 1100 / 1.16 - 945 = 948.275862 - 945 = 3.275862``.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from hypothesis import given
from hypothesis import strategies as st

from investment_dashboard.domain import fx_spread as fs
from investment_dashboard.domain.cash_out import cash_out
from investment_dashboard.domain.cash_pool import ConversionBack

D = Decimal
DAY = date(2026, 3, 2)


def _conv(usd: str, eur: str, fee: str, ecb: str | None) -> fs.Conversion:
    return fs.Conversion(
        id=1,
        date=DAY,
        eur_sent=D(eur),
        usd_received=D(usd),
        fees_eur=D(0),
        provider=None,
        ecb_rate=None if ecb is None else D(ecb),
        ecb_rate_date=None if ecb is None else DAY,
        direction="to_eur",
        fees_usd=D(fee),
    )


def near(a: Decimal | None, b: str, tol: str = "0.000001") -> bool:
    return a is not None and abs(a - D(b)) <= D(tol)


def test_golden_usd_fee_back() -> None:
    c = fs.conversion_cost(_conv("1100", "945", "5", "1.16"))
    assert near(c.all_in_rate, "1.164021")
    assert near(c.fees_eur, "4.310345")
    assert near(c.ecb_eur, "943.965517")
    assert near(c.spread_eur, "-1.034483")
    assert near(c.cost_eur, "3.275862")
    assert c.fees_usd == D(5)
    assert near(c.cost_usd, "3.8")  # 1100 - 945 * 1.16 = 3.80
    s = fs.summarise([c])
    assert near(s.all_in_rate, "1.164021")


def test_usd_fee_without_fixing_uses_own_rate() -> None:
    c = fs.conversion_cost(_conv("1100", "945", "5", None))
    assert near(c.fees_eur, "4.315068")  # 5 / (1095 / 945)
    assert c.cost_eur is None


def test_eur_fee_back_is_unchanged() -> None:
    c = fs.Conversion(
        id=2,
        date=DAY,
        eur_sent=D("100"),
        usd_received=D("120"),
        fees_eur=D("2"),
        provider=None,
        ecb_rate=D("1.2"),
        ecb_rate_date=DAY,
        direction="to_eur",
    )
    cost = fs.conversion_cost(c)
    assert near(cost.all_in_rate, "1.224490")  # 120 / (100 - 2)
    assert near(cost.cost_eur, "2")  # 120 / 1.2 - 100 + 2... fee on top of the spread of 0


@given(
    usd=st.integers(10_000, 5_000_000),
    fee=st.integers(0, 9_999),
    eur=st.integers(5_000, 5_000_000),
    ecb=st.decimals(D("0.8"), D("1.6"), places=4),
)
def test_usd_fee_cost_is_dollars_sent_over_fixing_minus_euros(
    usd: int, fee: int, eur: int, ecb: Decimal
) -> None:
    usd_d, fee_d, eur_d = D(usd) / 100, D(fee) / 100, D(eur) / 100
    c = fs.conversion_cost(_conv(str(usd_d), str(eur_d), str(fee_d), str(ecb)))
    assert c.cost_eur is not None
    assert c.spread_eur is not None
    assert abs(c.cost_eur - (usd_d / ecb - eur_d)) <= D("1e-18")
    assert abs(c.cost_eur - (c.spread_eur + c.fees_eur)) <= D("1e-18")
    assert abs(c.fees_eur - fee_d / ecb) <= D("1e-18")
    assert abs(c.all_in_rate - usd_d / eur_d) <= D("1e-18")


def test_cash_out_usd_fee_is_inside_the_cost() -> None:
    co = cash_out(
        ConversionBack(1, DAY, "USD", D("1100"), D("945"), D(0), D("5")), [], lambda c, d: D("1.16")
    )
    assert near(co.conversion_cost_eur, "-3.275862", "0.000001")
    assert near(co.fees_usd_eur, "4.310345")
    assert co.fees_usd == D(5)
    assert co.realised_eur == D("945")
