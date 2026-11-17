"""Golden ledger for the Risk engine: staged deposits, uninvested cash, a sweep fund.

Two USD brokerage accounts. ``F`` has no money-market sweep (a deposit waits as
plain cash until it is invested; the snapshot value does not count that cash,
B-017). ``V`` sweeps every cash move through the money-market fund ``VMFXX``
($1.00 NAV): a deposit buys VMFXX, a fund purchase sells it. One fund ``FUND`` is
also the benchmark, so "the same money into the index" is easy to work out.
EUR->USD is 1.25 until 31 May 2023 and 1.10 from Thu 1 Jun 2023.

==========  ===========================================  ======================
date        what                                         book after (USD)
==========  ===========================================  ======================
Wed 22 Mar  F: deposit 10,000 (cash)                     10,000 (cash)
Fri 24 Mar  V: deposit 10,000 -> VMFXX                   20,000
Mon 27 Mar  V: buy 100 FUND @100 from VMFXX              20,000
Tue 28 Mar  V: deposit 10,000 -> VMFXX                   30,000
Thu 30 Mar  F: buy 100 FUND @100 from cash               30,000
Mon  3 Apr  FUND 100 -> 110 (200 sh: +2,000)             32,000
Fri 28 Apr  VMFXX pays 50 (reinvested)                   32,050
Mon  1 May  V: deposit 5,000 -> VMFXX                    37,050
Tue  2 May  V: buy 136.36363636 FUND @110 from VMFXX     37,050 (VMFXX 50)
Thu  1 Jun  FUND 110 -> 121 (+3,700); EUR/USD 1.25->1.10 40,750
==========  ===========================================  ======================

Hand-worked values (flows at the start of their day, uninvested cash counted).

TWR, "All" (from 22 Mar) and 1Y to Thu 28 Mar 2024 (from Wed 29 Mar 2023: not a
deposit day; the 30 Mar buy, the 1 May deposit and the 2 May sweep are inside):

* USD = 32,000/30,000 x 32,050/32,000 x 40,750/37,050 - 1
  = 16/15 x 641/640 x 815/741 - 1 = +17.5022 %.
* EUR: the same up to 31 May (one rate), then (40,750/1.10)/(37,050/1.25):
  16/15 x 641/640 x 815/741 x 25/22 - 1 = +33.5252 %.
* Before the fix ("All", USD): F's 10,000 was not in the value, so the window
  started on 24 Mar (the 22 Mar deposit fell before it and was dropped) and the
  30 Mar buy read as a +50 % day: 1.5 x 1.175022 - 1 = +76.25 % (EUR +100.29 %).
  This is the owner's pattern: TWR +262 % ~= 2 x (1 + 81 %) - 1, one dropped
  first deposit read back as a +100 % day.

Funded benchmark (same money into FUND on the same days), end of window:

* USD: 300 sh at 100 (22, 24, 28 Mar) + 5,000/110 on 1 May = 345.4545 sh x 121
  = 41,800 vs the portfolio's 40,750: -1,050, TRAILING. EUR: 41,800/1.10 =
  38,000 vs 37,045.45: -954.55. The Overview's XIRR verdict says trailing too.
  Before (USD): base 10,000 on 24 Mar, the 22 Mar deposit lost: 245.4545 x 121 =
  29,700, "+11,050 beating", the owner's "benchmark below contributions".

Risk figures run on trading-day returns (one benchmark close to the next).
Only three days move: 3 Apr (x1 = 1/15, benchmark +10 %), 28 Apr (x2 =
50/32,000, benchmark 0) and 1 Jun (x3 = 3,700/37,050, benchmark +10 %; EUR:
x3 = 815/741 x 25/22 - 1 and benchmark (121/1.10)/(110/1.25) - 1 = +25 %).
With n trading-day pairs, OLS beta = (0.1 (x1 + x3) - 0.2 (x1 + x2 + x3)/n) /
(0.02 - 0.04/n) = 0.832 in USD and 0.955 in EUR for "All" (n = 72). Before the fix the last n
calendar-day returns were paired with the last n trading-day returns (different
days): beta came out near zero, and weekend zeros were annualised with 252.

Contribution table, flows over (start, end], P&L = End - Start - Net added:

==============  ==========  ==========  ==========  ==========
"All", USD      Start       End         Net added   P&L
==============  ==========  ==========  ==========  ==========
Cash (F)        10,000      0           -10,000     0
VMFXX           0           50          +50 - 50    +50
FUND            0           40,700      35,000      5,700
Total           10,000      40,750      25,000      5,750
==============  ==========  ==========  ==========  ==========

(VMFXX on "All": +10,000 (24 Mar) - 10,000 (27 Mar) + 10,000 (28 Mar) + 5,000
(1 May) - 15,000 (2 May) = 0 added; P&L = 50, the income it earned.) Window
from 24 Mar (a sweep day): Cash 10,000 -> 0, added -10,000; VMFXX 10,000 -> 50,
added -10,000, P&L +50 (before: the start-day leg counted again, -9,950, the
owner's -9,834.81); FUND +5,700; total 20,000 -> 40,750, added 15,000 (the
deposits after the start), P&L 5,750. In EUR (24 Mar window): Cash 8,000 -> 0,
-8,000, 0; VMFXX 8,000 -> 45.45, -8,000, +45.45 (income 40 at 1.25 plus its
revaluation to 1.10); FUND 0 -> 37,000, 28,000, +9,000; total 16,000 ->
37,045.45, added 12,000, P&L 9,045.45. 1Y (from 29 Mar), USD: Cash 10,000 -> 0,
-10,000, 0; VMFXX 10,000 -> 50, -10,000, +50; FUND 10,000 -> 40,700, 25,000,
+5,700; total 30,000 -> 40,750, added 5,000, P&L 5,750.

TWR vs the Overview's "Total growth": Total growth is money-weighted,
(1 + XIRR) ^ years - 1, from the same cashflows; TWR ignores the size and timing
of the deposits. They differ by design (here the 1 May money missed the 3 Apr
gain); the reconciliation below checks each against its own definition.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest

from investment_dashboard.domain.returns import (
    Cashflow,
    total_growth_pct_compounded,
    xirr,
    years_between,
)
from investment_dashboard.models import Account, Instrument, PriceHistory, Transaction
from investment_dashboard.readmodels.analytics import _summary_fields
from investment_dashboard.readmodels.queries.analytics_query import CASH_ROW_ID, build_bundle
from investment_dashboard.readmodels.queries.overview_query import compute_market_verdict
from investment_dashboard.repositories import fx_repo
from investment_dashboard.services import metrics_service, snapshots_service

D = Decimal
FIRST = date(2023, 3, 22)
FX_STEP = date(2023, 6, 1)
ALL_AS_OF = date(2023, 6, 30)
Y1_AS_OF = date(2024, 3, 28)  # 365 days back = Wed 29 Mar 2023, not a deposit day
TWR_USD = D(16) / 15 * D(641) / 640 * D(815) / 741 - 1
TWR_EUR = (TWR_USD + 1) * D(25) / 22 - 1
EPS = D("1e-9")
CENT = D("0.01")


def _rate(day: date) -> Decimal:
    return D("1.25") if day < FX_STEP else D("1.10")


def _at_end(ccy: str) -> Decimal:
    """Divisor that turns an end-of-window USD figure into EUR."""
    return D(1) if ccy == "USD" else D("1.10")


def _early(ccy: str) -> Decimal:
    """Divisor for a figure booked before the FX step (1.25)."""
    return D(1) if ccy == "USD" else D("1.25")


@pytest.fixture(autouse=True)
def _offline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "investment_dashboard.adapters.yfinance_client.fetch_latest_close", lambda _s: None
    )


def _fund_price(day: date) -> Decimal:
    if day < date(2023, 4, 3):
        return D(100)
    if day < FX_STEP:
        return D(110)
    return D(121)


@pytest.fixture
def golden(session):  # type: ignore[no-untyped-def]
    f = Account(
        broker="fidelity", account_label="F", account_type="brokerage", native_currency="USD"
    )
    v = Account(
        broker="vanguard", account_label="V", account_type="brokerage", native_currency="USD"
    )
    mm = Instrument(
        symbol="VMFXX",
        asset_class="mutual_fund",
        native_currency="USD",
        name="Vanguard Federal Money Market Fund",
    )
    fund = Instrument(symbol="FUND", asset_class="etf", native_currency="USD")
    bench = Instrument(symbol="VT", asset_class="etf", native_currency="USD")
    session.add_all([f, v, mm, fund, bench])
    session.flush()
    d = FIRST - timedelta(days=7)
    while d <= Y1_AS_OF:
        if d.weekday() < 5:
            p = _fund_price(d)
            session.add(PriceHistory(instrument_id=fund.id, date=d, close_native=p, source="t"))
            session.add(
                PriceHistory(instrument_id=bench.id, date=d, close_native=p, source="benchmark")
            )
        d += timedelta(days=1)

    def tx(acct, day, kind, instr=None, qty=None, px=None, net=None):  # type: ignore[no-untyped-def]
        session.add(
            Transaction(
                account_id=acct.id,
                date=day,
                kind=kind,
                instrument_id=instr.id if instr is not None else None,
                quantity=qty,
                price_native=px,
                net_native=net,
                source="manual",
            )
        )

    def sweep_in(day, amount):  # type: ignore[no-untyped-def]
        tx(v, day, "deposit", net=D(amount))
        tx(v, day, "buy", mm, D(amount), D(1), -D(amount))

    def buy_from_sweep(day, amount):  # type: ignore[no-untyped-def]
        px = _fund_price(day)
        tx(v, day, "buy", fund, (D(amount) / px).quantize(D("0.00000001")), px, -D(amount))
        tx(v, day, "sell", mm, -D(amount), D(1), D(amount))

    tx(f, FIRST, "deposit", net=D(10000))
    sweep_in(date(2023, 3, 24), 10000)
    buy_from_sweep(date(2023, 3, 27), 10000)
    sweep_in(date(2023, 3, 28), 10000)
    tx(f, date(2023, 3, 30), "buy", fund, D(100), D(100), D(-10000))
    tx(v, date(2023, 4, 28), "dividend_reinvest", mm, D(50), D(1), D(0))
    sweep_in(date(2023, 5, 1), 5000)
    buy_from_sweep(date(2023, 5, 2), 15000)
    fx_repo.upsert_rates(session, {FIRST - timedelta(days=7): D("1.25"), FX_STEP: D("1.10")})
    session.flush()
    snapshots_service.warm_range(session, FIRST - timedelta(days=3), Y1_AS_OF)
    session.flush()
    return session


def _all(session, ccy: str, *, as_of: date = ALL_AS_OF):  # type: ignore[no-untyped-def]
    """The Risk page's "All": ``lookback_days`` from the first transaction."""
    return build_bundle(session, currency=ccy, lookback_days=(as_of - FIRST).days, as_of=as_of)


def _twr(ccy: str) -> Decimal:
    return TWR_USD if ccy == "USD" else TWR_EUR


def _hand_beta(ccy: str, n: int) -> float:
    x1 = 1 / 15
    x2 = 50 / 32000
    if ccy == "USD":
        x3, b3 = 3700 / 37050, 0.1
    else:
        x3, b3 = 815 / 741 * 25 / 22 - 1, 121 / 1.10 / (110 / 1.25) - 1
    b1 = 0.1
    cov = b1 * x1 + b3 * x3 - (x1 + x2 + x3) * (b1 + b3) / n
    var = b1**2 + b3**2 - (b1 + b3) ** 2 / n
    return cov / var


@pytest.mark.parametrize("ccy", ["USD", "EUR"])
def test_all_twr_counts_uninvested_cash_and_the_first_deposit(golden, ccy: str) -> None:  # type: ignore[no-untyped-def]
    b = _all(golden, ccy)
    assert b.start == FIRST  # the cash-only first day is the first invested day
    assert b.twr is not None
    assert abs(b.twr - _twr(ccy)) < EPS  # before the fix: +76.25 % (USD)
    assert abs((b.cagr or D(0)) - _twr(ccy)) < EPS  # under a year: not annualised
    assert b.max_drawdown == 0
    assert abs(b.curve[0].portfolio_value - D(10000) / _early(ccy)) < CENT
    assert abs(b.curve[-1].portfolio_value - D(40750) / _at_end(ccy)) < CENT


@pytest.mark.parametrize("ccy", ["USD", "EUR"])
def test_1y_window_starting_between_a_deposit_and_its_buy(golden, ccy: str) -> None:  # type: ignore[no-untyped-def]
    b = build_bundle(golden, currency=ccy, lookback_days=365, as_of=Y1_AS_OF)
    assert b.start == date(2023, 3, 29)
    assert abs(b.curve[0].portfolio_value - D(30000) / _early(ccy)) < CENT
    assert b.twr is not None
    assert abs(b.twr - _twr(ccy)) < EPS
    assert b.cagr is not None
    assert abs(b.cagr - _twr(ccy)) < D("1e-6")  # exactly one year: CAGR == TWR
    # The funded benchmark meets the same end value as on "All".
    s = _summary_fields(b)
    assert abs(D(s["benchmark_last_value"]) - D(41800) / _at_end(ccy)) < CENT


@pytest.mark.parametrize("ccy", ["USD", "EUR"])
def test_beta_pairs_the_same_trading_days(golden, ccy: str) -> None:  # type: ignore[no-untyped-def]
    b = _all(golden, ccy)
    closes = [d for d in (FIRST + timedelta(days=i) for i in range(101)) if d <= ALL_AS_OF]
    n = sum(1 for d in closes if d.weekday() < 5) - 1
    assert n == 72
    assert b.beta is not None
    assert abs(float(b.beta) - _hand_beta(ccy, n)) < 1e-9
    assert 0.8 < float(b.beta) < 1  # before the fix: about 0
    # Volatility: the three moves among n trading-day returns, sample sd x sqrt(252)
    # (USD 22.31 %, EUR 48.20 %: the 1 Jun FX step is a real EUR move).
    x1, x2 = 1 / 15, 50 / 32000
    x3 = 3700 / 37050 if ccy == "USD" else 815 / 741 * 25 / 22 - 1
    xs = [x1, x2, x3] + [0.0] * (n - 3)
    mean = sum(xs) / n
    vol = (sum((x - mean) ** 2 for x in xs) / (n - 1)) ** 0.5 * 252**0.5
    assert b.volatility is not None
    assert abs(float(b.volatility) - vol) < 1e-9


@pytest.mark.parametrize("ccy", ["USD", "EUR"])
def test_funded_benchmark_agrees_with_the_overview_verdict(golden, ccy: str) -> None:  # type: ignore[no-untyped-def]
    b = _all(golden, ccy)
    s = _summary_fields(b)
    assert abs(D(s["benchmark_last_value"]) - D(41800) / _at_end(ccy)) < CENT
    assert abs(D(s["benchmark_diff"]) - D(-1050) / _at_end(ccy)) < CENT  # before: +11,050
    m = metrics_service.compute_portfolio_metrics(golden, as_of=ALL_AS_OF)
    xirr_ccy = m.xirr_usd if ccy == "USD" else m.xirr
    verdict = compute_market_verdict(
        golden,
        portfolio_xirr=xirr_ccy,
        years=years_between(FIRST, ALL_AS_OF),
        as_of=ALL_AS_OF,
        currency=ccy,
    )
    assert verdict.beating is False
    assert verdict.portfolio_return is not None
    assert verdict.benchmark_return is not None
    assert verdict.portfolio_return < verdict.benchmark_return


@pytest.mark.parametrize("ccy", ["USD", "EUR"])
def test_risk_all_reconciles_with_the_overview(golden, ccy: str) -> None:  # type: ignore[no-untyped-def]
    """Independent check: Risk "All" against the Overview's own path and by hand.

    XIRR: the Overview's figure equals an XIRR worked from the ledger's deposits
    (each at its own date's rate) and the end value, and the Risk page shows
    that same figure. Total growth = (1 + XIRR) ^ years - 1 (money-weighted);
    TWR is the chained daily index; both are checked against their definitions.
    """
    b = _all(golden, ccy)
    m = metrics_service.compute_portfolio_metrics(golden, as_of=ALL_AS_OF)
    overview_xirr = m.xirr_usd if ccy == "USD" else m.xirr
    deposits = [
        (FIRST, 10000),
        (date(2023, 3, 24), 10000),
        (date(2023, 3, 28), 10000),
        (date(2023, 5, 1), 5000),
    ]
    flows = [Cashflow(date=d, amount=-D(a) / _early(ccy)) for d, a in deposits]
    end_value = D(40750) / _at_end(ccy)
    hand_xirr = xirr(flows, as_of=ALL_AS_OF, terminal_value=end_value)
    assert hand_xirr is not None
    assert overview_xirr is not None
    assert abs(overview_xirr - hand_xirr) < D("1e-6")
    assert b.xirr == overview_xirr
    # The curve's end value and money added are the Overview's.
    assert abs(b.curve[-1].portfolio_value - end_value) < CENT
    assert abs(b.curve[-1].cumulative_contributions - D(35000) / _early(ccy)) < CENT
    growth = m.total_growth_compounded_usd if ccy == "USD" else m.total_growth_compounded_eur
    years = years_between(FIRST, ALL_AS_OF)
    assert growth is not None
    assert abs(growth - (total_growth_pct_compounded(overview_xirr, years) or D(0))) < D("1e-9")
    # TWR is not Total growth: here the late 1 May money missed the 3 Apr gain.
    assert b.twr is not None
    assert abs(b.twr - _twr(ccy)) < EPS
    assert b.twr != growth


@pytest.mark.parametrize(
    ("ccy", "start", "rows", "total"),
    [
        # (symbol: start, end, net added, P&L); total: start, end, net added, P&L
        (
            "USD",
            FIRST,
            {
                "Cash": ("10000", "0", "-10000", "0"),
                "VMFXX": ("0", "50", "0", "50"),
                "FUND": ("0", "40700", "35000", "5700"),
            },
            ("10000", "40750", "25000", "5750"),
        ),
        (
            "USD",
            date(2023, 3, 24),
            {
                "Cash": ("10000", "0", "-10000", "0"),
                "VMFXX": ("10000", "50", "-10000", "50"),  # before: P&L -9,950
                "FUND": ("0", "40700", "35000", "5700"),
            },
            ("20000", "40750", "15000", "5750"),
        ),
        (
            "EUR",
            date(2023, 3, 24),
            {
                "Cash": ("8000", "0", "-8000", "0"),
                "VMFXX": ("8000", "45.4545", "-8000", "45.4545"),
                "FUND": ("0", "37000", "28000", "9000"),
            },
            ("16000", "37045.4545", "12000", "9045.4545"),
        ),
    ],
)
def test_contribution_table_rows_and_footer(golden, ccy, start, rows, total) -> None:  # type: ignore[no-untyped-def]
    b = build_bundle(golden, currency=ccy, lookback_days=(ALL_AS_OF - start).days, as_of=ALL_AS_OF)
    got = {r.symbol: r for r in b.attribution}
    assert set(got) == set(rows)
    assert got["Cash"].instrument_id == CASH_ROW_ID
    for sym, (s, e, n, p) in rows.items():
        r = got[sym]
        assert abs(r.start_value - D(s)) < CENT, sym
        assert abs(r.end_value - D(e)) < CENT, sym
        assert abs(r.net_contribution - D(n)) < CENT, sym
        assert abs(r.absolute_pnl - D(p)) < CENT, sym
        assert abs(r.absolute_pnl - (r.end_value - r.start_value - r.net_contribution)) < EPS
    t = _summary_fields(b)["attribution_total"]
    for key, want in zip(
        ("start_value", "end_value", "net_contribution", "absolute_pnl"), total, strict=True
    ):
        assert abs(D(t[key]) - D(want)) < CENT, key
    # The footer is the curve: same start and end value, same money added.
    assert abs(D(t["start_value"]) - b.curve[0].portfolio_value) < CENT
    assert abs(D(t["end_value"]) - b.curve[-1].portfolio_value) < CENT
    added = b.curve[-1].cumulative_contributions - b.curve[0].cumulative_contributions
    assert abs(D(t["net_contribution"]) - added) < CENT


def test_1y_contribution_table(golden) -> None:  # type: ignore[no-untyped-def]
    b = build_bundle(golden, currency="USD", lookback_days=365, as_of=Y1_AS_OF)
    got = {
        r.symbol: (r.start_value, r.end_value, r.net_contribution, r.absolute_pnl)
        for r in b.attribution
    }
    want = {
        "Cash": (10000, 0, -10000, 0),
        "VMFXX": (10000, 50, -10000, 50),
        "FUND": (10000, 40700, 25000, 5700),
    }
    assert set(got) == set(want)
    for sym, values in want.items():
        for g, w in zip(got[sym], values, strict=True):
            assert abs(g - D(w)) < CENT, sym


def test_a_cold_cache_starts_a_background_fill(
    session,
    snapshot_fill_calls,  # type: ignore[no-untyped-def]
) -> None:
    """Uncached days older than the recompute tail are filled off the request thread."""
    acct = Account(
        broker="vanguard", account_label="A", account_type="brokerage", native_currency="USD"
    )
    session.add(acct)
    session.flush()
    session.add(
        Transaction(
            account_id=acct.id,
            date=date(2023, 1, 2),
            kind="deposit",
            net_native=D(1),
            source="manual",
        )
    )
    session.flush()
    as_of = date(2023, 6, 30)
    build_bundle(session, currency="USD", lookback_days=180, as_of=as_of)
    assert snapshot_fill_calls == [(as_of - timedelta(days=180), as_of)]
