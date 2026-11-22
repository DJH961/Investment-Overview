# ruff: noqa: PT018
"""Property and golden tests for ``domain/fx_spread.py`` (what converting costs).

Golden ledger: the contract's C1-C3 (``docs/v7_3_contract.md``) with made-up ECB
fixings, worked by hand.

* C1 2026-01-05, EUR 1,000 -> USD 1,100, fees 2, provider wise, fixing 1.10:
  ecb_eur = 1100 / 1.10 = 1000, spread = 1000 - 1000 = 0, cost = 0 + 2 = 2;
  off = (1100 / 1002) / 1.10 - 1 = 1000 / 1002 - 1 = -0.001996;
  USD: spread = 1000 * 1.10 - 1100 = 0, fees = 2 * 1.10 = 2.2, cost = 2.2.
* C2 2026-02-02, EUR 900 -> USD 1,000, fees 0, revolut, fixing 1.25:
  ecb_eur = 1000 / 1.25 = 800, spread = 900 - 800 = 100, cost = 100;
  off = (1000 / 900) / 1.25 - 1 = -1/9 = -0.111111;
  USD: spread = 900 * 1.25 - 1000 = 125, fees = 0, cost = 125.
* C3 2026-03-09, EUR 1,850 -> USD 2,000, fees 3, wise, fixing 1.00 (a negative cost:
  intraday noise, not a win): ecb_eur = 2000, spread = 1850 - 2000 = -150, cost = -147;
  off = (2000 / 1853) / 1.00 - 1 = 147 / 1853 = +0.079331;
  USD: spread = 1850 * 1.00 - 2000 = -150, fees = 3, cost = -147.

Totals: converted 1000 + 900 + 1850 = 3750; fees 2 + 0 + 3 = 5; spread 0 + 100 - 150 =
-50; cost 2 + 100 - 147 = -45 (cost % of converted -45 / 3750 = -1.2 %). USD: fees
2.2 + 0 + 3 = 5.2, spread 0 + 125 - 150 = -25, cost -19.8 on 4,100 received.
Average distance, EUR-weighted (the plain mean of the three percentages would be
-1.13 %, which is wrong):
(1000 * -2/1002 + 900 * -1/9 + 1850 * 147/1853) / 3750 = (-1.996008 - 100 + 146.762000)
/ 3750 = +0.011938. Best C3, worst C2. Wise spread only (fees out): (1000 * 0 + 1850 *
(2000/1850 - 1)) / 2850 = 150 / 2850 = +0.052632; revolut: -1/9.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from hypothesis import given, settings
from hypothesis import strategies as st

from investment_dashboard.domain import fx_spread as fs

D = Decimal


def _golden() -> list[fs.Conversion]:
    return [
        fs.Conversion(
            1, date(2026, 1, 5), D(1000), D(1100), D(2), "wise", D("1.10"), date(2026, 1, 5)
        ),
        fs.Conversion(
            2, date(2026, 2, 2), D(900), D(1000), D(0), "revolut", D("1.25"), date(2026, 2, 2)
        ),
        fs.Conversion(
            3, date(2026, 3, 9), D(1850), D(2000), D(3), "wise", D("1.00"), date(2026, 3, 9)
        ),
    ]


def near(a: Decimal | None, b: str, tol: str = "0.000001") -> bool:
    assert a is not None
    return abs(a - D(b)) <= D(tol)


def test_golden_per_conversion() -> None:
    c1, c2, c3 = (fs.conversion_cost(c) for c in _golden())
    assert (c1.ecb_eur, c1.spread_eur, c1.cost_eur) == (D(1000), D(0), D(2))
    assert near(c1.off_pct, "-0.001996")
    assert (c1.spread_usd, c1.fees_usd, c1.cost_usd) == (D(0), D("2.20"), D("2.20"))
    assert (c2.ecb_eur, c2.spread_eur, c2.cost_eur) == (D(800), D(100), D(100))
    assert near(c2.off_pct, "-0.111111")
    assert (c2.spread_usd, c2.cost_usd) == (D(125), D(125))
    assert (c3.ecb_eur, c3.spread_eur, c3.cost_eur) == (D(2000), D(-150), D(-147))
    assert near(c3.off_pct, "0.079331")
    assert (c3.spread_usd, c3.fees_usd, c3.cost_usd) == (D(-150), D(3), D(-147))


def test_golden_report() -> None:
    rep = fs.build_report(_golden())
    s = rep.summary
    assert (s.count, s.converted_eur, s.fees_eur, s.spread_eur, s.cost_eur) == (
        3,
        D(3750),
        D(5),
        D(-50),
        D(-45),
    )
    assert s.cost_pct == D(-45) / D(3750)
    assert (s.fees_usd, s.spread_usd, s.cost_usd, s.converted_usd) == (
        D("5.2"),
        D(-25),
        D("-19.8"),
        D(4100),
    )
    assert near(s.avg_off_pct, "0.011938")
    assert rep.best is not None and rep.best.id == 3
    assert rep.worst is not None and rep.worst.id == 2
    assert [(p.date, p.cost_eur) for p in rep.cumulative] == [
        (date(2026, 1, 5), D(2)),
        (date(2026, 2, 2), D(102)),
        (date(2026, 3, 9), D(-45)),
    ]
    assert [(y, ys.cost_eur) for y, ys in rep.by_year] == [(2026, D(-45))]
    assert near(fs.provider_avg_off_pct(rep.rows, "wise"), "0.052632")
    assert near(fs.provider_avg_off_pct(rep.rows, "revolut"), "-0.111111")
    assert fs.provider_avg_off_pct(rep.rows, "other") is None
    assert fs.provider_avg_off_pct(rep.rows, None) is None
    assert [p for p, _ in rep.by_provider] == ["wise", "revolut"]


def test_range_window_and_unpriced() -> None:
    rows = [*_golden(), fs.Conversion(4, date(2026, 3, 10), D(100), D(110), D(0), None, None, None)]
    rep = fs.build_report(rows, start=date(2026, 2, 1))
    assert [r.id for r in rep.rows] == [4, 3, 2]
    assert rep.unpriced == 1
    assert rep.summary.count == 2
    assert rep.rows[0].cost_eur is None
    assert [p for p, _ in rep.by_provider] == ["wise", "revolut", "none"]


def test_fixing_for_uses_last_settled_before_a_weekend() -> None:
    rates = {date(2026, 3, 6): D("1.08"), date(2026, 3, 9): D("1.09")}
    assert fs.fixing_for(rates, date(2026, 3, 9)) == (D("1.09"), date(2026, 3, 9))
    # Saturday and Sunday: the Friday fixing, labelled with its own date
    assert fs.fixing_for(rates, date(2026, 3, 7)) == (D("1.08"), date(2026, 3, 6))
    assert fs.fixing_for(rates, date(2026, 3, 8)) == (D("1.08"), date(2026, 3, 6))
    assert fs.fixing_for(rates, date(2026, 3, 20)) is None
    assert fs.fixing_for({}, date(2026, 3, 9)) is None


money = st.integers(1, 10_000_000).map(lambda n: D(n) / 100)
fees = st.integers(0, 50_000).map(lambda n: D(n) / 100)
ecb = st.integers(8000, 15000).map(lambda n: D(n) / 10000)
providers = st.sampled_from(["wise", "revolut", "other", None])


@st.composite
def conversions(draw: st.DrawFn) -> list[fs.Conversion]:
    n = draw(st.integers(1, 8))
    out = []
    for i in range(n):
        day = date(2024, 1, 1) + timedelta(days=draw(st.integers(0, 900)))
        out.append(
            fs.Conversion(
                i + 1, day, draw(money), draw(money), draw(fees), draw(providers), draw(ecb), day
            )
        )
    return out


@settings(max_examples=60, deadline=None)
@given(conversions())
def test_cost_is_spread_plus_fees_and_sums(rows: list[fs.Conversion]) -> None:
    rep = fs.build_report(rows)
    for r in rep.rows:
        assert r.cost_eur == r.spread_eur + r.fees_eur  # type: ignore[operator]
        assert abs(r.cost_usd - (r.spread_usd + r.fees_usd)) < D("1e-9")  # type: ignore[operator]
    s = rep.summary
    tol = D("1e-18")
    assert abs(s.cost_eur - (s.spread_eur + s.fees_eur)) < tol
    assert abs(s.cost_eur - sum((r.cost_eur for r in rep.rows), D(0))) < tol  # type: ignore[misc]
    assert abs(sum((y.cost_eur for _, y in rep.by_year), D(0)) - s.cost_eur) < tol
    assert abs(sum((p.cost_eur for _, p in rep.by_provider), D(0)) - s.cost_eur) < tol
    assert abs(rep.cumulative[-1].cost_eur - s.cost_eur) < tol


@settings(max_examples=60, deadline=None)
@given(conversions())
def test_weighted_average_between_min_and_max(rows: list[fs.Conversion]) -> None:
    rep = fs.build_report(rows)
    offs = [r.off_pct for r in rep.rows]
    avg = rep.summary.avg_off_pct
    assert avg is not None
    tol = D("1e-18")
    assert min(offs) - tol <= avg <= max(offs) + tol  # type: ignore[type-var]
    assert rep.best is not None and rep.worst is not None
    assert rep.best.off_pct == max(offs)
    assert rep.worst.off_pct == min(offs)
    for p in ("wise", "revolut", "other", None):
        got = fs.provider_avg_off_pct(rep.rows, p)
        mine = [r.spread_off_pct for r in rep.rows if r.provider == (p or "none")]
        if mine:
            assert got is not None
            assert min(mine) - tol <= got <= max(mine) + tol  # type: ignore[type-var]
        else:
            assert got is None


@settings(max_examples=40, deadline=None)
@given(conversions(), st.randoms())
def test_order_independent(rows: list[fs.Conversion], rnd: object) -> None:
    shuffled = list(rows)
    rnd.shuffle(shuffled)  # type: ignore[attr-defined]
    assert fs.build_report(rows) == fs.build_report(shuffled)


@settings(max_examples=60, deadline=None)
@given(st.integers(1, 1_000_000), st.integers(0, 5000), ecb)
def test_zero_spread_when_rate_equals_ecb(eur_cents: int, fee_cents: int, rate: Decimal) -> None:
    eur = D(eur_cents) / 100
    c = fs.Conversion(
        1, date(2025, 5, 5), eur, eur * rate, D(fee_cents) / 100, "wise", rate, date(2025, 5, 5)
    )
    got = fs.conversion_cost(c)
    assert abs(got.spread_eur) < D("1e-18")  # type: ignore[arg-type]
    assert abs(got.cost_eur - c.fees_eur) < D("1e-18")  # type: ignore[operator]
    assert abs(got.spread_off_pct) < D("1e-18")  # type: ignore[arg-type]


# --- timing: your rate against the month's average fixing -------------------------------
# Golden, by hand. March 2026 fixings 1.00 (2nd), 1.10 (9th), 1.20 (16th); April 1.50 is
# another month. Month average = (1.00 + 1.10 + 1.20) / 3 = 1.10. Conversion A, 9 Mar,
# EUR 1,000 -> USD 1,155 (rate 1.155): 1.155 / 1.10 - 1 = +5 % (better). Conversion B,
# 16 Mar, EUR 3,000 -> USD 3,135 (rate 1.045): 1.045 / 1.10 - 1 = -5 % (worse). EUR-weighted:
# (1000 * 0.05 + 3000 * -0.05) / 4000 = -0.025; the plain mean of the two (0 %) is wrong.
# While March is running with today = 10 Mar only 1.00 and 1.10 count: mean 1.05, "so far".
RATES = {
    date(2026, 3, 2): D("1.00"),
    date(2026, 3, 9): D("1.10"),
    date(2026, 3, 16): D("1.20"),
    date(2026, 4, 1): D("1.50"),
}


def test_month_average_closed_and_running() -> None:
    assert fs.month_average(RATES, date(2026, 3, 9), date(2026, 11, 22)) == (D("1.10"), False)
    assert fs.month_average(RATES, date(2026, 3, 9), date(2026, 3, 10)) == (D("1.05"), True)
    assert fs.month_average(RATES, date(2026, 5, 9), date(2026, 11, 22)) is None


def test_timing_golden() -> None:
    avg = D("1.10")
    a = fs.Conversion(
        1, date(2026, 3, 9), D(1000), D(1155), D(0), None, D("1.10"), date(2026, 3, 9), avg
    )
    b = fs.Conversion(
        2, date(2026, 3, 16), D(3000), D(3135), D(0), None, D("1.20"), date(2026, 3, 16), avg, True
    )
    rep = fs.build_report([a, b])
    by_id = {r.id: r for r in rep.rows}
    assert near(by_id[1].timing_pct, "0.05")
    assert near(by_id[2].timing_pct, "-0.05")
    t = rep.timing
    assert (t.count, t.better, t.worse, t.so_far) == (2, 1, 1, 1)
    assert near(t.avg_pct, "-0.025")


def test_timing_none_without_month_average() -> None:
    rep = fs.build_report(_golden())
    assert rep.timing.count == 0 and rep.timing.avg_pct is None


@settings(max_examples=60, deadline=None)
@given(conversions(), ecb)
def test_timing_weighted_between_min_and_max(rows: list[fs.Conversion], avg: Decimal) -> None:
    with_avg = [
        fs.Conversion(
            c.id,
            c.date,
            c.eur_sent,
            c.usd_received,
            c.fees_eur,
            c.provider,
            c.ecb_rate,
            c.ecb_rate_date,
            avg,
        )
        for c in rows
    ]
    rep = fs.build_report(with_avg)
    vals = [r.timing_pct for r in rep.rows]
    assert rep.timing.avg_pct is not None
    tol = D("1e-18")
    assert min(vals) - tol <= rep.timing.avg_pct <= max(vals) + tol  # type: ignore[type-var]
    assert rep.timing.better + rep.timing.worse <= rep.timing.count
