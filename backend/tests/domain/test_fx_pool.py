# ruff: noqa: PT018
"""Tests for ``domain.fx_pool`` (FIFO USD pool).

Golden case (plan section 7), worked by hand. Rates are USD per EUR.

Batches:
  B1 2024-01-15: EUR 8980 + fee EUR 20 -> cost EUR 9000, USD 10000 (0.9 EUR/USD)
  B2 2024-04-15: EUR 9200, no fee       -> cost EUR 9200, USD 10000 (0.92 EUR/USD)
Deposits (ECB fallback rate 1.10 USD/EUR):
  D1 2024-02-01 USD  4000: all from B1 -> 4000 * 0.9 = EUR 3600
       B1 left: USD 6000 / EUR 5400
  D2 2024-05-01 USD  8000: B1 6000 -> EUR 5400; B2 2000 -> 2000*0.92 = EUR 1840
       total EUR 7240, blended 8000/7240; B1 empty, B2 left USD 8000 / EUR 7360
  D3 2024-07-01 USD 10000: B2 8000 -> EUR 7360; uncovered USD 2000 at 1.10
       -> EUR 2000/1.10 = 1818.1818...; total EUR 9178.1818...; pool empty
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from hypothesis import given, settings
from hypothesis import strategies as st

from investment_dashboard.domain.fx_pool import Batch, UsdDeposit, match_deposits

D = Decimal
ECB = D("1.10")


def _ecb(_d: date) -> Decimal | None:
    return ECB


def test_golden_two_batches_three_deposits() -> None:
    batches = [
        Batch(1, date(2024, 1, 15), D("8980"), D("10000"), D("20")),
        Batch(2, date(2024, 4, 15), D("9200"), D("10000")),
    ]
    deposits = [
        UsdDeposit(10, date(2024, 2, 1), D("4000")),
        UsdDeposit(11, date(2024, 5, 1), D("8000")),
        UsdDeposit(12, date(2024, 7, 1), D("10000")),
    ]
    res = match_deposits(batches, deposits, _ecb)
    d1, d2, d3 = res.deposits
    assert d1.eur_total == D("3600") and not d1.is_fallback
    assert [(s.conversion_id, s.usd, s.eur) for s in d2.matched] == [
        (1, D("6000"), D("5400")),
        (2, D("2000"), D("1840")),
    ]
    assert d2.eur_total == D("7240")
    assert d2.blended_rate == D("8000") / D("7240")
    assert d3.matched_usd == D("8000") and d3.fallback_usd == D("2000")
    assert d3.is_fallback and d3.fallback_rate == ECB
    assert d3.fallback_eur == D("2000") / D("1.10")
    assert d3.eur_total == D("7360") + D("2000") / D("1.10")
    assert res.remaining_usd == 0 and res.remaining_eur == 0


def test_deposit_before_batch_uses_fallback_only() -> None:
    res = match_deposits(
        [Batch(1, date(2024, 3, 1), D("900"), D("1000"))],
        [UsdDeposit(1, date(2024, 2, 1), D("500"))],
        _ecb,
    )
    assert res.deposits[0].matched == ()
    assert res.deposits[0].fallback_usd == D("500")
    assert res.remaining_usd == D("1000")


def test_missing_ecb_rate_is_flagged() -> None:
    res = match_deposits([], [UsdDeposit(1, date(2024, 2, 1), D("500"))], lambda _d: None)
    m = res.deposits[0]
    assert m.rate_missing and m.eur_total == 0 and m.blended_rate is None


_amount = st.decimals(min_value=D("0.01"), max_value=D("100000"), places=2)
_fee = st.decimals(min_value=D("0"), max_value=D("50"), places=2)
_day = st.integers(0, 400).map(lambda n: date(2023, 1, 1) + timedelta(days=n))
_batches = st.lists(st.tuples(_day, _amount, _amount, _fee), max_size=6).map(
    lambda xs: [Batch(i + 1, d, e, u, f) for i, (d, e, u, f) in enumerate(xs)]
)
_deposits = st.lists(st.tuples(_day, _amount), max_size=8).map(
    lambda xs: [UsdDeposit(i + 1, d, a) for i, (d, a) in enumerate(xs)]
)


@settings(max_examples=150, deadline=None)
@given(_batches, _deposits)
def test_properties(batches: list[Batch], deposits: list[UsdDeposit]) -> None:
    res = match_deposits(batches, deposits, _ecb)
    by_batch = {b.id: b for b in batches}
    used: dict[int, Decimal] = {b.id: D(0) for b in batches}
    dep_by_id = {d.id: d for d in deposits}
    for m in res.deposits:
        assert m.matched_usd + m.fallback_usd == dep_by_id[m.deposit_id].usd  # conserved
        assert m.eur_total >= 0
        for s in m.matched:
            assert by_batch[s.conversion_id].date <= m.date  # no future batch
            assert s.usd > 0 and s.eur >= 0
            used[s.conversion_id] += s.usd
    for r in res.remaining:
        assert r.usd >= 0 and r.eur >= 0
        assert r.usd + used[r.conversion_id] == by_batch[r.conversion_id].usd_received
    # input order must not matter
    rev = match_deposits(list(reversed(batches)), list(reversed(deposits)), _ecb)
    assert rev == res
