"""Late NAVs and overnight currency: estimate, linear correction, day split (pure maths)."""

from __future__ import annotations

import statistics
from datetime import date, datetime, timedelta
from decimal import Decimal

import pytest
from hypothesis import assume, given
from hypothesis import strategies as st

from investment_dashboard.domain import index_twins
from investment_dashboard.domain.late_data import (
    MAX_OUTLIER_SHARE,
    MIN_OUTLIER_SAMPLES,
    OUTLIER_SPREAD_FACTOR,
    Holding,
    corrected_value,
    divergences,
    estimate_value,
    fund_value_at,
    session_fraction,
    split_day_change,
    typical_daily_gap,
    value_at_rate,
)

OPEN = datetime(2026, 11, 4, 14, 30)  # 09:30 New York
CLOSE = datetime(2026, 11, 4, 21, 0)  # 16:00 New York

money = st.decimals(min_value="1", max_value="1000000", places=4, allow_nan=False)
price = st.decimals(min_value="1", max_value="5000", places=4, allow_nan=False)
fx = st.decimals(min_value="0.5", max_value="2", places=6, allow_nan=False)
minutes = st.integers(min_value=0, max_value=390)


# -- golden values (checked by hand) ------------------------------------------------


def test_estimate_golden() -> None:
    # Fund closed at NAV 100; its twin closed at 500 and trades at 505 (+1 %).
    assert estimate_value(Decimal(100), Decimal(505), Decimal(500)) == Decimal("101")
    # No twin price: flat at the previous NAV.
    assert estimate_value(Decimal(100), None, Decimal(500)) == Decimal(100)
    assert estimate_value(Decimal(100), Decimal(505), None) == Decimal(100)


def test_correction_golden() -> None:
    # Twin closed +1 % (estimate 101) but the official NAV is 101.50.
    half = OPEN + (CLOSE - OPEN) / 2
    assert session_fraction(half, OPEN, CLOSE) == Decimal("0.5")
    # Mid-session the twin was +0.6 % -> estimate 100.60, plus half of the +0.50 gap.
    value = fund_value_at(
        prev_value=Decimal(100),
        official_value=Decimal("101.50"),
        twin_at=Decimal(503),
        twin_close=Decimal(505),
        twin_prev_close=Decimal(500),
        fraction=Decimal("0.5"),
    )
    assert value == Decimal("100.85")
    # No twin: a straight line from 100 to the official 101.50.
    flat_mid = fund_value_at(
        prev_value=Decimal(100),
        official_value=Decimal("101.50"),
        twin_at=None,
        twin_close=None,
        twin_prev_close=None,
        fraction=Decimal("0.5"),
    )
    assert flat_mid == Decimal("100.75")


def test_split_golden() -> None:
    # Previous close €10,000, last session's close €10,150, now €10,080 (EUR firmed).
    split = split_day_change(Decimal(10000), Decimal(10150), Decimal(10080))
    assert split.move == Decimal(150)
    assert split.overnight == Decimal(-70)
    assert split.pct == Decimal("0.015")


def test_value_at_rate_golden() -> None:
    book = [Holding("USD", Decimal(1100)), Holding("EUR", Decimal(500))]
    eur, usd = value_at_rate(book, Decimal("1.10"))
    assert eur == Decimal(1500)
    assert usd == Decimal("1650.00")
    with pytest.raises(ValueError, match="positive"):
        value_at_rate(book, Decimal(0))


# -- properties ---------------------------------------------------------------------


@given(prev=price, official=price, twin_prev=price, twin_close=price, twin_mid=price)
def test_line_starts_at_prev_close_and_ends_at_official(
    prev: Decimal, official: Decimal, twin_prev: Decimal, twin_close: Decimal, twin_mid: Decimal
) -> None:
    def at(fraction: Decimal, twin: Decimal | None) -> Decimal:
        return fund_value_at(
            prev_value=prev,
            official_value=official,
            twin_at=twin,
            twin_close=twin_close,
            twin_prev_close=twin_prev,
            fraction=fraction,
        )

    # At the open the twin has not moved yet: the line starts at the previous close.
    assert at(Decimal(0), twin_prev) == prev
    # At the close it is exactly the official NAV: no spike, no gap.
    assert at(Decimal(1), twin_close) == official


@given(prev=price, official=price, a=minutes, b=minutes)
def test_flat_fund_blend_is_monotone(prev: Decimal, official: Decimal, a: int, b: int) -> None:
    """Without a twin the corrected line moves steadily from prev to official."""
    lo, hi = sorted((a, b))

    def at(m: int) -> Decimal:
        fraction = session_fraction(OPEN + timedelta(minutes=m), OPEN, CLOSE)
        return fund_value_at(
            prev_value=prev,
            official_value=official,
            twin_at=None,
            twin_close=None,
            twin_prev_close=None,
            fraction=fraction,
        )

    if official >= prev:
        assert at(lo) <= at(hi)
    else:
        assert at(lo) >= at(hi)
    assert min(prev, official) <= at(lo) <= max(prev, official)


@given(m=st.integers(min_value=-60, max_value=500))
def test_fraction_is_clamped(m: int) -> None:
    f = session_fraction(OPEN + timedelta(minutes=m), OPEN, CLOSE)
    assert Decimal(0) <= f <= Decimal(1)


@given(est=money, est_close=money, official=money)
def test_correction_endpoints(est: Decimal, est_close: Decimal, official: Decimal) -> None:
    assert corrected_value(est, est_close, official, Decimal(0)) == est
    assert corrected_value(est_close, est_close, official, Decimal(1)) == official


@given(
    usd_prev=money,
    usd_last=money,
    eur_prev=money,
    eur_last=money,
    fx_prev=fx,
    fx_close=fx,
    fx_now=fx,
)
def test_split_sums_to_total_change_in_each_currency(
    usd_prev: Decimal,
    usd_last: Decimal,
    eur_prev: Decimal,
    eur_last: Decimal,
    fx_prev: Decimal,
    fx_close: Decimal,
    fx_now: Decimal,
) -> None:
    """Each mark at its own rate; move + overnight == total change, EUR and USD alike."""
    prev = value_at_rate([Holding("USD", usd_prev), Holding("EUR", eur_prev)], fx_prev)
    last = value_at_rate([Holding("USD", usd_last), Holding("EUR", eur_last)], fx_close)
    # Overnight: same holdings and official prices, only the rate moved.
    now = value_at_rate([Holding("USD", usd_last), Holding("EUR", eur_last)], fx_now)
    for i in (0, 1):
        split = split_day_change(prev[i], last[i], now[i])
        # Exact up to Decimal's 28-digit context.
        assert abs(split.move + split.overnight - (now[i] - prev[i])) < Decimal("1e-18")
    # USD holdings are FX-free in USD: the USD overnight effect comes only from EUR ones.
    usd_split = split_day_change(prev[1], last[1], now[1])
    assert abs(usd_split.overnight - eur_last * (fx_now - fx_close)) < Decimal("1e-18")


def test_typical_daily_gap() -> None:
    start = date(2026, 1, 1)
    fund = {start + timedelta(days=i): Decimal(100) + i for i in range(25)}
    assert typical_daily_gap(fund, fund) == Decimal(0)
    assert typical_daily_gap(fund, {}) is None
    short = dict(list(fund.items())[:5])
    assert typical_daily_gap(short, short) is None


# -- twin list ----------------------------------------------------------------------


def test_twin_list_tiers() -> None:
    same = index_twins.suggest_twin("fxaix")
    assert same is not None
    assert (same.etf, same.tier) == ("VOO", "same_index")
    assert index_twins.suggest_twin("VFIAX").etf == "VOO"  # type: ignore[union-attr]
    close = {s.fund: s for s in index_twins.all_suggestions() if s.tier == "close"}
    assert set(close) == {"FSKAX", "FZROX", "FNILX"}
    assert (close["FSKAX"].etf, close["FSKAX"].typical_daily_gap) == ("VTI", "0.00019")
    for fund in ("FZILX", "FSELX", "VOO", None, ""):
        assert index_twins.suggest_twin(fund) is None
    funds = [s.fund for s in index_twins.all_suggestions()]
    assert len(funds) == len(set(funds))  # one suggestion per fund


# -- twin divergence ---------------------------------------------------------------

D0 = date(2026, 3, 2)


def _series(values: list[str]) -> dict[date, Decimal]:
    return {D0 + timedelta(days=i): Decimal(v) for i, v in enumerate(values)}


def test_divergence_golden() -> None:
    # Fund +1.5 % then +0.5 %; twin +1 % then +1 %: the twin ran 0.5 pp BEHIND the
    # fund on day one (gap -0.005) and 0.5 pp AHEAD on day two (gap +0.005).
    fund = _series(["100", "101.5", "102.0075"])
    twin = _series(["500", "505", "510.05"])
    d = divergences(fund, twin)
    assert d is not None
    assert (d.last_prev_date, d.last_date) == (D0 + timedelta(days=1), D0 + timedelta(days=2))
    assert d.last_gap == Decimal("0.005")
    assert d.median_abs == Decimal("0.005")
    assert d.bias == Decimal(0)
    assert (d.sessions, d.window) == (2, 20)


def test_divergence_window_and_sign() -> None:
    # Three sessions with gaps -0.01, +0.02, +0.04 (twin return minus fund return).
    fund = _series(["100", "101", "101", "101"])
    twin = _series(["100", "100", "102", "106.08"])
    d = divergences(fund, twin, window=2)
    assert d is not None
    assert d.last_gap == Decimal("0.04")
    assert d.sessions == 2
    assert d.median_abs == Decimal("0.03")  # median of 0.02 and 0.04
    assert d.bias == Decimal("0.03")  # mean signed: both positive -> the twin ran high
    all3 = divergences(fund, twin, window=10)
    assert all3 is not None
    assert all3.sessions == 3
    assert all3.median_abs == Decimal("0.02")
    assert abs(all3.bias - Decimal("0.05") / 3) < Decimal("1e-20")


def test_divergence_skips_dividend_sessions() -> None:
    fund = _series(["100", "101", "90", "91"])  # a 10 % distribution on day 2
    twin = _series(["100", "101", "101", "102"])
    ex = D0 + timedelta(days=2)
    plain = divergences(fund, twin)
    assert plain is not None
    assert plain.sessions == 3
    clean = divergences(fund, twin, excluded={ex})
    assert clean is not None
    assert clean.sessions == 2
    assert ex != clean.last_date
    # The distribution day's huge gap no longer skews the bias.
    assert abs(clean.bias) < Decimal("0.02")
    assert plain.bias > Decimal("0.03")
    # Nothing left once every session is excluded; no shared returns at all -> None.
    assert divergences(fund, twin, excluded=set(fund)) is None
    assert divergences(fund, {}) is None
    assert divergences({D0: Decimal(1)}, {D0: Decimal(1)}) is None


close_series = st.lists(
    st.decimals(min_value="1", max_value="1000", places=4), min_size=2, max_size=40
)


@given(values=close_series, scale=st.decimals(min_value="0.5", max_value="20", places=3))
def test_a_perfect_twin_never_diverges(values: list[Decimal], scale: Decimal) -> None:
    fund = {D0 + timedelta(days=i): v for i, v in enumerate(values)}
    twin = {d: v * scale for d, v in fund.items()}
    d = divergences(fund, twin)
    assert d is not None
    assert abs(d.last_gap) < Decimal("1e-20")
    assert d.median_abs < Decimal("1e-20")
    assert abs(d.bias) < Decimal("1e-20")


def _keep_after_outlier_rejection(
    candidates: list[tuple[int, Decimal]],
) -> list[tuple[int, Decimal]]:
    """The documented rejection rule, restated here so the property pins it down.

    Sessions more than ``OUTLIER_SPREAD_FACTOR`` deviations from the median
    are distributions rather than tracking error; too small a sample or a zero spread
    leaves everything in place.
    """
    if len(candidates) < MIN_OUTLIER_SAMPLES:
        return candidates
    values = [g for _k, g in candidates]
    mid = statistics.median(values)
    deviations = [abs(v - mid) for v in values]
    spread = statistics.median(deviations) or sum(deviations) / len(deviations)
    if spread <= 0:
        return candidates
    limit = OUTLIER_SPREAD_FACTOR * spread
    furthest = sorted(
        range(len(candidates)), key=lambda i: abs(candidates[i][1] - mid), reverse=True
    )
    dropped = {
        i
        for i in furthest[: len(candidates) // MAX_OUTLIER_SHARE]
        if abs(candidates[i][1] - mid) > limit
    }
    return [c for i, c in enumerate(candidates) if i not in dropped]


@given(
    fund_values=close_series,
    twin_seed=st.lists(
        st.decimals(min_value="1", max_value="1000", places=4), min_size=40, max_size=40
    ),
    window=st.integers(min_value=1, max_value=30),
    skip=st.sets(st.integers(min_value=0, max_value=39), max_size=10),
)
def test_divergence_statistics_are_consistent(
    fund_values: list[Decimal], twin_seed: list[Decimal], window: int, skip: set[int]
) -> None:
    fund = {D0 + timedelta(days=i): v for i, v in enumerate(fund_values)}
    twin = {d: twin_seed[i] for i, d in enumerate(fund)}
    excluded = {D0 + timedelta(days=i) for i in skip}
    d = divergences(fund, twin, window=window, excluded=excluded)
    usable = [i for i in range(1, len(fund_values)) if i not in skip]
    if not usable:
        assert d is None
        return
    assert d is not None
    assert d.window == window
    assert d.last_date not in excluded
    candidates = [
        (k, twin_seed[k] / twin_seed[k - 1] - fund_values[k] / fund_values[k - 1])
        for k in usable[-window:]
    ]
    kept = _keep_after_outlier_rejection(candidates)
    assert d.sessions == len(kept)
    assert d.sessions <= min(window, len(usable))
    # The newest *kept* session, which is the newest usable one unless it was rejected.
    last, last_gap = kept[-1]
    assert d.last_date == D0 + timedelta(days=last)
    assert d.last_gap == last_gap  # sign: twin return minus fund return, as a fraction
    gaps = [g for _k, g in kept]
    assert d.median_abs == statistics.median(abs(g) for g in gaps)
    assert abs(d.bias - sum(gaps) / len(gaps)) < Decimal("1e-20")


def _flat_pair(sessions: int) -> tuple[list[str], list[str]]:
    """A fund and twin that both sit still: every gap is exactly zero."""
    return ["100"] * (sessions + 1), ["50"] * (sessions + 1)


def _tracking_pair(gaps: list[str]) -> tuple[dict[date, Decimal], dict[date, Decimal]]:
    """A flat fund and a twin whose each-session return is the matching ``gaps`` entry."""
    fund = ["100"] * (len(gaps) + 1)
    twin = [Decimal(50)]
    for g in gaps:
        twin.append(twin[-1] * (Decimal(1) + Decimal(g)))
    return _series(fund), {D0 + timedelta(days=i): v for i, v in enumerate(twin)}


def test_divergence_rejects_a_twin_distribution_day() -> None:
    """One ETF ex-dividend day must not pass as tracking error.

    The twin is never held, so its distributions can never reach ``excluded`` from the
    ledger. Ten sessions of ±0.02 pp noise plus one -0.35 % drop: without rejection the
    mean is dragged an order of magnitude past the real tracking error.
    """
    noise = ["0.0002", "-0.0002"] * 5
    fund, twin = _tracking_pair([*noise, "-0.0035"])
    d = divergences(fund, twin)
    assert d is not None
    # The distribution session is dropped: ten noise sessions remain...
    assert d.sessions == 10
    # ...so the bias stays at the noise level instead of ~-0.00032.
    assert abs(d.bias) < Decimal("1e-9")
    # ...and the newest usable session is a real one, not the distribution.
    assert abs(d.last_gap) == Decimal("0.0002")
    assert d.last_date == D0 + timedelta(days=10)


def test_divergence_keeps_everything_below_the_outlier_sample_floor() -> None:
    """Too few sessions to tell an outlier from noise: nothing is rejected."""
    fund, twin = _tracking_pair(["0.0002", "-0.0002", "0.0002", "-0.0035"])
    d = divergences(fund, twin)
    assert d is not None
    assert d.sessions == 4
    assert d.last_gap == Decimal("-0.0035")


def test_divergence_keeps_a_perfect_tracker() -> None:
    """A zero spread would make every session an outlier of itself: leave it alone."""
    fund_v, twin_v = _flat_pair(10)
    fund, twin = _series(fund_v), _series(twin_v)
    d = divergences(fund, twin)
    assert d is not None
    assert d.sessions == 10
    assert d.bias == Decimal(0)
    assert d.median_abs == Decimal(0)


@given(
    noise=st.lists(
        st.decimals(min_value="-0.0005", max_value="0.0005", places=6),
        min_size=12,
        max_size=20,
    ),
    shock=st.decimals(min_value="0.01", max_value="0.2", places=6),
)
def test_one_distribution_cannot_drag_the_bias(noise: list[Decimal], shock: Decimal) -> None:
    """Adding a single far-outlier session leaves ``bias`` where the noise alone put it."""
    mid = statistics.median(noise)
    devs = [abs(v - mid) for v in noise]
    spread = statistics.median(devs) or sum(devs) / len(devs)
    # The degenerate shapes have their own tests: an identical-gap sample, and a
    # two-peaked one whose sessions are real tracking error rather than contamination.
    assume(spread > 0)
    assume(not any(d > OUTLIER_SPREAD_FACTOR * spread for d in devs))
    clean_f, clean_t = _tracking_pair([str(v) for v in noise])
    clean = divergences(clean_f, clean_t, window=50)
    shocked_f, shocked_t = _tracking_pair([str(v) for v in noise] + [str(-shock)])
    shocked = divergences(shocked_f, shocked_t, window=50)
    assert clean is not None
    assert shocked is not None
    # Rejected, so the bias stays inside the noise band. Averaged in instead it would
    # move by shock/n, which is an order of magnitude past that band.
    assert abs(shocked.bias - clean.bias) < Decimal("0.0005")
