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


# ---------------------------------------------------------------- 7.3 pins

from investment_dashboard.domain.fx_pool import Pin  # noqa: E402

_C = D("0.01")


def _golden() -> tuple[list[Batch], list[UsdDeposit]]:
    return (
        [
            Batch(1, date(2026, 1, 5), D("1000"), D("1100"), D("2")),
            Batch(2, date(2026, 2, 2), D("900"), D("1000")),
            Batch(3, date(2026, 3, 9), D("1850"), D("2000"), D("3")),
        ],
        [
            UsdDeposit(1, date(2026, 1, 10), D("800")),
            UsdDeposit(2, date(2026, 3, 6), D("1500")),
            UsdDeposit(3, date(2026, 3, 12), D("1000")),
        ],
    )


def test_golden_pin_ledger() -> None:
    batches, deposits = _golden()
    res = match_deposits(batches, deposits, _ecb, pins=[Pin(2, 3, D("500"))])
    assert res.rejected_pins == ()
    d1, d2, d3 = res.deposits
    assert [(s.conversion_id, s.usd, s.eur.quantize(_C), s.pinned) for s in d1.matched] == [
        (1, D("800"), D("728.73"), False)
    ]
    assert [(s.conversion_id, s.usd, s.eur.quantize(_C), s.pinned) for s in d2.matched] == [
        (3, D("500"), D("463.25"), True),
        (1, D("300"), D("273.27"), False),
        (2, D("700"), D("630.00"), False),
    ]
    assert d2.eur_total.quantize(_C) == D("1366.52")
    assert (D("1500") / d2.eur_total).quantize(D("0.0001")) == D("1.0977")
    assert [(s.conversion_id, s.usd, s.eur.quantize(_C)) for s in d3.matched] == [
        (2, D("300"), D("270.00")),
        (3, D("700"), D("648.55")),
    ]
    assert d3.eur_total.quantize(_C) == D("918.55")
    left = {r.conversion_id: r for r in res.remaining}
    assert left[3].usd == D("800") and left[3].eur.quantize(_C) == D("741.20")
    assert left[1].usd == 0 and left[2].usd == 0
    total_eur = sum((m.eur_total for m in res.deposits), D(0)) + res.remaining_eur
    assert total_eur.quantize(_C) == D("3755.00")
    assert abs(total_eur - D("3755")) < D("1e-20")
    c3 = next(u for u in res.by_conversion if u.conversion_id == 3)
    assert [(s.deposit_id, s.usd, s.pinned) for s in c3.slices] == [
        (2, D("500"), True),
        (3, D("700"), False),
    ]
    assert c3.remaining_usd == D("800")


def test_pin_rejections() -> None:
    batches, deposits = _golden()
    pins = [
        Pin(1, 3, D("10")),  # 2026-03-09 vs D1 2026-01-10: outside 7 days
        Pin(2, 2, D("1600")),  # over the deposit
        Pin(3, 1, D("5000")),  # over the deposit
        Pin(9, 1, D("1")),
        Pin(2, 9, D("1")),
    ]
    res = match_deposits(batches, deposits, _ecb, pins=pins)
    assert len(res.rejected_pins) == 5
    assert all(not s.pinned for m in res.deposits for s in m.matched)


def test_conversion_over_pinned_rejected() -> None:
    batches, deposits = _golden()
    pins = [Pin(2, 3, D("1500")), Pin(3, 3, D("1000"))]
    res = match_deposits(batches, deposits, _ecb, pins=pins)
    assert [p for p, _ in res.rejected_pins] == [Pin(3, 3, D("1000"))]


_pins_st = st.lists(st.tuples(st.integers(1, 8), st.integers(1, 6), _amount), max_size=6).map(
    lambda xs: [Pin(d, c, u) for d, c, u in xs]
)


@settings(max_examples=150, deadline=None)
@given(_batches, _deposits, _pins_st)
def test_pin_properties(batches: list[Batch], deposits: list[UsdDeposit], pins: list[Pin]) -> None:
    res = match_deposits(batches, deposits, _ecb, pins=pins)
    by_batch = {b.id: b for b in batches}
    dep_by_id = {d.id: d for d in deposits}
    # deposit = matched + fallback
    for m in res.deposits:
        assert m.matched_usd + m.fallback_usd == dep_by_id[m.deposit_id].usd
    # conversions = used + remaining; EUR conserved per conversion
    for use in res.by_conversion:
        b = by_batch[use.conversion_id]
        used = sum((s.usd for s in use.slices), D(0))
        assert used + use.remaining_usd == b.usd_received
        rem = next(r for r in res.remaining if r.conversion_id == b.id)
        assert abs(sum((s.eur for s in use.slices), D(0)) + rem.eur - b.eur_cost) < D("1e-20")
        assert rem.usd == use.remaining_usd
    # a valid pin appears as a pinned slice of the stated USD
    rejected = {p for p, _ in res.rejected_pins}
    for p in pins:
        if p not in rejected:
            m = next(x for x in res.deposits if x.deposit_id == p.deposit_id)
            assert any(s.pinned and s.conversion_id == p.conversion_id for s in m.matched)
    pinned_total = sum((s.usd for m in res.deposits for s in m.matched if s.pinned), D(0))
    assert pinned_total == sum((p.usd for p in pins if p not in rejected), D(0))
    # order independence
    rev = match_deposits(
        list(reversed(batches)), list(reversed(deposits)), _ecb, pins=list(reversed(pins))
    )
    assert rev == res


@settings(max_examples=100, deadline=None)
@given(_batches, _deposits)
def test_no_pins_equals_fifo(batches: list[Batch], deposits: list[UsdDeposit]) -> None:
    res = match_deposits(batches, deposits, _ecb, pins=())
    assert res.rejected_pins == ()
    assert all(not s.pinned for m in res.deposits for s in m.matched)


# ------------------------------------------------- 7.3 kept dollars, USD-received deposits
#
# Golden case worked by hand. C1 2024-01-10: EUR 880 + fee EUR 20 -> all-in EUR 900,
# USD 1000, of which USD 100 is kept in the owner's USD account (never sent on).
# The investable part is USD 900 costing EUR 900 * 900 / 1000 = 810 (0.9 EUR per USD).
#   D1 2024-02-01 USD 500 -> all from C1: 500 * 0.9 = EUR 450; C1 left USD 400 / EUR 360.
#   D2 2024-03-01 USD 600 -> C1 400 -> EUR 360; uncovered USD 200 at ECB 1.10
#      -> EUR 181.8181...; the kept USD 100 never matches anything.
#   D3 2024-04-01 USD 300 marked "received in USD": ECB only, EUR 300 / 1.10.


def test_golden_kept_dollars() -> None:
    from dataclasses import replace

    batch = Batch(1, date(2024, 1, 10), D("880"), D("1000"), D("20"), kept_usd=D("100"))
    assert batch.pool_usd == D("900") and batch.pool_eur == D("810")
    deposits = [
        UsdDeposit(1, date(2024, 2, 1), D("500")),
        UsdDeposit(2, date(2024, 3, 1), D("600")),
        UsdDeposit(3, date(2024, 4, 1), D("300"), no_conversion=True),
    ]
    res = match_deposits([batch], deposits, _ecb)
    d1, d2, d3 = res.deposits
    assert [(s.usd, s.eur) for s in d1.matched] == [(D("500"), D("450"))]
    assert [(s.usd, s.eur) for s in d2.matched] == [(D("400"), D("360"))]
    assert d2.fallback_usd == D("200") and d2.fallback_eur == D("200") / D("1.10")
    assert d3.matched == () and d3.fallback_usd == D("300") and d3.fallback_rate == ECB
    assert res.remaining_usd == 0 and res.remaining_eur == 0  # kept dollars are not "in the pool"
    # all kept: nothing to match, nothing remaining
    none = match_deposits([replace(batch, kept_usd=D("1000"))], deposits[:1], _ecb)
    assert none.deposits[0].matched == () and none.remaining_usd == 0


def test_pin_cannot_use_kept_dollars() -> None:
    batch = Batch(1, date(2024, 1, 10), D("900"), D("1000"), kept_usd=D("100"))
    dep = UsdDeposit(1, date(2024, 1, 20), D("1000"))
    res = match_deposits([batch], [dep], _ecb, pins=[Pin(1, 1, D("1000"))])
    assert [r for _, r in res.rejected_pins] == ["conversion is pinned for more than its amount"]
    ok = match_deposits([batch], [dep], _ecb, pins=[Pin(1, 1, D("900"))])
    assert ok.rejected_pins == () and ok.deposits[0].fallback_usd == D("100")


def test_pin_on_usd_received_deposit_rejected() -> None:
    batch = Batch(1, date(2024, 1, 10), D("900"), D("1000"))
    dep = UsdDeposit(1, date(2024, 1, 20), D("100"), no_conversion=True)
    res = match_deposits([batch], [dep], _ecb, pins=[Pin(1, 1, D("50"))])
    assert len(res.rejected_pins) == 1 and res.remaining_usd == D("1000")


_kept_batches = st.lists(
    st.tuples(_day, _amount, _amount, _fee, st.integers(0, 100)), max_size=6
).map(
    lambda xs: [
        Batch(i + 1, d, e, u, f, kept_usd=(u * pct / 100).quantize(_C))
        for i, (d, e, u, f, pct) in enumerate(xs)
    ]
)


@settings(max_examples=150, deadline=None)
@given(_kept_batches, _deposits, _pins_st)
def test_kept_conservation(
    batches: list[Batch], deposits: list[UsdDeposit], pins: list[Pin]
) -> None:
    res = match_deposits(batches, deposits, _ecb, pins=pins)
    by_batch = {b.id: b for b in batches}
    for use in res.by_conversion:
        b = by_batch[use.conversion_id]
        used = sum((s.usd for s in use.slices), D(0))
        # received = used + remaining + kept
        assert used + use.remaining_usd + b.kept_usd == b.usd_received
        rem = next(r for r in res.remaining if r.conversion_id == b.id)
        # the pool's EUR (all-in minus the kept share) is conserved
        assert abs(sum((s.eur for s in use.slices), D(0)) + rem.eur - b.pool_eur) < D("1e-20")
    for m in res.deposits:
        assert m.matched_usd + m.fallback_usd == m.usd


@settings(max_examples=100, deadline=None)
@given(_batches, _deposits, _pins_st)
def test_zero_kept_is_todays_result(
    batches: list[Batch], deposits: list[UsdDeposit], pins: list[Pin]
) -> None:
    from dataclasses import replace

    explicit = [replace(b, kept_usd=D(0)) for b in batches]
    assert match_deposits(explicit, deposits, _ecb, pins=pins) == match_deposits(
        batches, deposits, _ecb, pins=pins
    )
    assert all(b.pool_eur == b.eur_cost and b.pool_usd == b.usd_received for b in batches)
