"""Golden ledger for the Risk engine: staged deposits, uninvested cash, a sweep fund.

Two USD brokerage accounts. ``F`` has no money-market sweep (a deposit waits as
plain cash until it is invested; the snapshot value does not count that cash,
B-017). ``V`` sweeps every cash move through the money-market fund ``VMFXX``
($1.00 NAV): a deposit buys VMFXX, a fund purchase sells it.

Ledger (one fund ``FUND`` that is also the benchmark, so "same money into the
index" is easy to work out):

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
Tue  2 May  V: buy 136.363636 FUND @110 from VMFXX       37,050 (VMFXX 50)
Thu  1 Jun  FUND 110 -> 121 (336.36 sh: +3,700)          40,750
==========  ===========================================  ======================

Hand-worked values (flows in at the start of their day, cash counted):

* TWR = (32,000/30,000) x (32,050/32,000) x (40,750/37,050) - 1
  = 16/15 x 641/640 x 815/741 - 1 = 0.175022...  The same for "All" (from 22 Mar)
  and for a 1Y window ending 28 Mar 2024 (from 29 Mar 2023, not a deposit day,
  with the 30 Mar buy, the 1 May deposit and the 2 May sweep inside it).
  Before the fix the engine did not count F's cash: "All" started on 24 Mar (the
  22 Mar deposit fell before the first valued day and was dropped) and the 30 Mar
  buy read as +50 %: TWR = 1.5 x 1.175022 - 1 = 0.7625.
* Funded benchmark: 300 sh bought at 100 (22, 24, 28 Mar) + 5,000/110 on 1 May =
  345.4545 sh x 121 = 41,800. Portfolio 40,750, so -1,050: TRAILING (the
  Overview's XIRR verdict says the same). Before: base 10,000 on 24 Mar, 22 Mar
  deposit lost: 245.4545 x 121 = 29,700, "+11,050 beating".
* Contribution table for a window starting on 24 Mar (a sweep day): VMFXX starts
  at 10,000 after that day's leg, ends at 50; flows after the start day are
  -10,000 (27 Mar) +10,000 (28 Mar) +5,000 (1 May) -15,000 (2 May) = -10,000;
  P&L = 50 - 10,000 + 10,000 = +50 (the income it earned). Before: the start-day
  leg was counted again as a flow: -9,950. FUND: 0 -> 40,700 with 35,000 in:
  +5,700. Rows sum to 5,750 = End 40,750 - Start 10,000 - Net added 25,000.
* EUR at a constant 1.25 USD per EUR: every value is the USD one / 1.25, so every
  return equals the USD one; money figures are the USD ones / 1.25.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest

from investment_dashboard.domain.returns import years_between
from investment_dashboard.models import Account, Instrument, PriceHistory, Transaction
from investment_dashboard.readmodels.analytics import _summary_fields
from investment_dashboard.readmodels.queries.analytics_query import build_bundle
from investment_dashboard.readmodels.queries.overview_query import compute_market_verdict
from investment_dashboard.repositories import fx_repo
from investment_dashboard.services import metrics_service, snapshots_service

D = Decimal
FIRST = date(2023, 3, 22)
ALL_AS_OF = date(2023, 6, 30)
Y1_AS_OF = date(2024, 3, 28)  # 365 days back = Wed 29 Mar 2023, not a deposit day
TWR = D(16) / 15 * D(641) / 640 * D(815) / 741 - 1
EPS = D("1e-9")


@pytest.fixture(autouse=True)
def _offline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "investment_dashboard.adapters.yfinance_client.fetch_latest_close", lambda _s: None
    )


def _fund_price(day: date) -> Decimal:
    if day < date(2023, 4, 3):
        return D(100)
    if day < date(2023, 6, 1):
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
    fx_repo.upsert_rates(session, {FIRST - timedelta(days=7): D("1.25")})
    session.flush()
    snapshots_service.warm_range(session, FIRST - timedelta(days=3), Y1_AS_OF)
    session.flush()
    return session


def _all(session, ccy: str):  # type: ignore[no-untyped-def]
    return build_bundle(
        session, currency=ccy, lookback_days=(ALL_AS_OF - FIRST).days + 30, as_of=ALL_AS_OF
    )


@pytest.mark.parametrize("ccy", ["USD", "EUR"])
def test_all_twr_counts_uninvested_cash_and_the_first_deposit(golden, ccy: str) -> None:  # type: ignore[no-untyped-def]
    b = _all(golden, ccy)
    assert b.start == FIRST  # the cash-only first day is the first invested day
    assert b.twr is not None
    assert abs(b.twr - TWR) < EPS  # before the fix: 0.7625
    assert abs((b.cagr or D(0)) - TWR) < EPS  # under a year: not annualised
    assert b.max_drawdown == 0
    scale = D(1) if ccy == "USD" else D(1) / D("1.25")
    assert abs(b.curve[-1].portfolio_value - D(40750) * scale) < D("0.01")


@pytest.mark.parametrize("ccy", ["USD", "EUR"])
def test_1y_window_starting_between_a_deposit_and_its_buy(golden, ccy: str) -> None:  # type: ignore[no-untyped-def]
    b = build_bundle(golden, currency=ccy, lookback_days=365, as_of=Y1_AS_OF)
    assert b.start == date(2023, 3, 29)
    scale = D(1) if ccy == "USD" else D(1) / D("1.25")
    assert abs(b.curve[0].portfolio_value - D(30000) * scale) < D("0.01")
    assert b.twr is not None
    assert abs(b.twr - TWR) < EPS  # before the fix: 0.7625
    assert b.cagr is not None
    assert abs(b.cagr - TWR) < D("1e-6")  # exactly one year: CAGR == TWR
    # Daily returns: only the three real moves; no deposit or buy shows up.
    assert b.volatility is not None
    assert b.volatility < D("0.2")


@pytest.mark.parametrize("ccy", ["USD", "EUR"])
def test_funded_benchmark_agrees_with_the_overview_verdict(golden, ccy: str) -> None:  # type: ignore[no-untyped-def]
    b = _all(golden, ccy)
    s = _summary_fields(b)
    scale = D(1) if ccy == "USD" else D(1) / D("1.25")
    assert abs(D(s["benchmark_last_value"]) - D(41800) * scale) < D("0.01")
    assert abs(D(s["benchmark_diff"]) - D(-1050) * scale) < D("0.01")  # before: +11,050
    # Independent cross-check: the Overview's own path (XIRR of the same cashflows
    # vs the simulated benchmark XIRR) must say "trailing" too.
    m = metrics_service.compute_portfolio_metrics(golden, as_of=ALL_AS_OF)
    xirr = m.xirr_usd if ccy == "USD" else m.xirr
    assert b.xirr == xirr
    verdict = compute_market_verdict(
        golden,
        portfolio_xirr=xirr,
        years=years_between(FIRST, ALL_AS_OF),
        as_of=ALL_AS_OF,
        currency=ccy,
    )
    assert verdict.beating is False
    assert D(s["benchmark_diff"]) < 0
    assert verdict.portfolio_return is not None
    assert verdict.benchmark_return is not None
    assert verdict.portfolio_return < verdict.benchmark_return


@pytest.mark.parametrize("ccy", ["USD", "EUR"])
def test_sweep_fund_row_is_its_income_not_the_money_moved(golden, ccy: str) -> None:  # type: ignore[no-untyped-def]
    as_of = ALL_AS_OF
    b = build_bundle(
        golden, currency=ccy, lookback_days=(as_of - date(2023, 3, 24)).days, as_of=as_of
    )
    scale = D(1) if ccy == "USD" else D(1) / D("1.25")
    rows = {r.symbol: r for r in b.attribution}
    assert abs(rows["VMFXX"].absolute_pnl - D(50) * scale) < D("0.01")  # before: -9,950
    assert abs(rows["FUND"].absolute_pnl - D(5700) * scale) < D("0.01")
    total = sum((r.absolute_pnl for r in b.attribution), D(0))
    start = sum((r.start_value for r in b.attribution), D(0))
    end = sum((r.end_value for r in b.attribution), D(0))
    added = sum((r.net_contribution for r in b.attribution), D(0))
    assert abs(total - (end - start - added)) < D("0.01")
    assert abs(total - D(5750) * scale) < D("0.01")
