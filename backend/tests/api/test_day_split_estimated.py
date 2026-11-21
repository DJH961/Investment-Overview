"""Golden test: while the market is open with an ETF-twin estimate, ☀/☾ split the ESTIMATED book.

Owner's report (2026-11-17, EUR view, open): headline -1.53 % (estimated book) but
☀ -0.98 % + ☾ +0.12 % = -0.86 %, the official book. The split must describe the
book the headline shows, everywhere (hero/graph/KPI ``last_session``, holdings rows,
tick); after the close the rule is unchanged (see ``test_twin_visibility``).

USD brokerage, no cash: FUNDX 10 sh (NAV 200 on Fri 31 May 2024, Monday's NAV not
posted) with the ETF twin TWN (Fri close 100, 102 at 13:00 ET Mon -> estimate 204),
and ACME 10 sh flat at 100. EUR/USD: Friday close 1.10, Monday's open sample 1.12,
live 1.13. Now: Mon 3 Jun 13:30 ET (open).

Hand numbers (EUR):
  baseline (prev close)  = 3000 / 1.10                    = 2727.27
  A  (night, ☾)          = 3000 / 1.12 - 3000 / 1.10      =  -48.70
  official Total         = 3000 / 1.13 - 2727.27          =  -72.41
  official ☀ (B+C)       = -72.41 + 48.70                 =  -23.70
  estimate adjustment    = 10 x (204 - 200) / 1.13        =   35.40
  estimated Total        = -72.41 + 35.40                 =  -37.01  (-1.357 %)
  estimated ☀            = -23.70 + 35.40                 =   11.70  (+0.429 %)
  ☾ unchanged            =                                   -48.70  (-1.786 %)
  Check: 11.70 - 48.70 = -37.00 (cents) = estimated Total.
Rows: FUNDX prev 2000/1.10 = 1818.18, at the open 2000/1.12 = 1785.71, now
2040/1.13 = 1805.31: ☾ -32.47, ☀ +19.60 (sum -12.87 = its ≈ estimated move).
ACME (official): ☾ -16.23, ☀ -7.90. Rows sum: ☾ -48.70, ☀ 11.70.
Before the fix: ☀ -23.70 (-0.869 %) + ☾ -48.70 = -72.41, the official book, while
the headline said -37.01; the FUNDX row had no split at all.
USD: no currency move, so no ☾ and no row split; ☀ = the estimated +40.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path

import pytest

from investment_dashboard.db import cache_write_session, ledger_session_scope
from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.readmodels import holdings
from investment_dashboard.readmodels.overview import build_overview
from investment_dashboard.repositories import (
    accounts_repo,
    fx_repo,
    instrument_overrides_repo,
    instruments_repo,
    intraday_repo,
    prices_repo,
    symbol_prices_repo,
)
from investment_dashboard.services import scheduler

D = Decimal
FRI, MON = date(2024, 5, 31), date(2024, 6, 3)
DURING = datetime(2024, 6, 3, 17, 30, tzinfo=UTC)  # 13:30 ET Monday, market open
R_PREV, R_OPEN, R_LIVE = D("1.10"), D("1.12"), D("1.13")
TOL = D("0.011")

BASELINE = D(3000) / R_PREV
A = D(3000) / R_OPEN - BASELINE
OFFICIAL_TOTAL = D(3000) / R_LIVE - BASELINE
ADJ = D(40) / R_LIVE
EST_TOTAL = OFFICIAL_TOTAL + ADJ
EST_SESSION = OFFICIAL_TOTAL - A + ADJ
FUND_NIGHT = D(2000) / R_OPEN - D(2000) / R_PREV
FUND_SESSION = D(2040) / R_LIVE - D(2000) / R_OPEN


@pytest.fixture
def seeded(api_db: Path) -> dict[str, int]:
    with ledger_session_scope() as s:
        acct = accounts_repo.create_account(
            s,
            broker="fidelity",
            account_label="Main",
            native_currency="USD",
            account_type="brokerage",
        )
        fund = instruments_repo.get_or_create(
            s, symbol="FUNDX", asset_class="mutual_fund", native_currency="USD"
        )
        etf = instruments_repo.get_or_create(
            s, symbol="ACME", asset_class="etf", native_currency="USD"
        )
        prices_repo.upsert_closes(s, fund.id, {FRI: D("200")})
        prices_repo.upsert_closes(s, etf.id, {FRI: D("100"), MON: D("100")})
        fx_repo.upsert_rates(s, {FRI: R_PREV, MON: R_LIVE})
        instrument_overrides_repo.upsert(s, fund.id, intraday_twin="TWN")
        s.add(
            Transaction(
                account_id=acct.id,
                date=FRI,
                kind="deposit",
                source=TransactionSource.MANUAL,
                net_native=D("3000"),
            )
        )
        for inst, qty, px in ((fund, "10", "200"), (etf, "10", "100")):
            s.add(
                Transaction(
                    account_id=acct.id,
                    date=FRI,
                    kind="buy",
                    source=TransactionSource.MANUAL,
                    instrument_id=inst.id,
                    quantity=D(qty),
                    price_native=D(px),
                    net_native=-D(qty) * D(px),
                )
            )
        # Monday's session opened at 1.12 (09:35 ET = 13:35 UTC, stored naive UTC).
        intraday_repo.insert_sample(
            s,
            datetime(2024, 6, 3, 13, 35),
            D(3000) / R_OPEN,
            fx_eur_usd=R_OPEN,
            market_value_usd=D(3000),
        )
        s.flush()
        with cache_write_session(s) as cache:
            symbol_prices_repo.upsert_prices(
                cache,
                "TWN",
                {
                    datetime(2024, 5, 31, 20, 0): D("100"),
                    datetime(2024, 6, 3, 13, 30): D("100"),
                    datetime(2024, 6, 3, 17, 0): D("102"),
                },
            )
        return {"FUNDX": fund.id, "ACME": etf.id}


def test_open_split_describes_the_estimated_book(seeded: dict[str, int]) -> None:
    with ledger_session_scope() as s:
        eur = build_overview(s, ccy="EUR", as_of=MON, now=DURING)
    est = eur["kpis"]["estimate"]
    ls = eur["last_session"]
    assert ls["market_open"] is True
    assert abs(D(est["adjustment"]) - ADJ) < D("1e-9")
    assert abs(D(est["daily_move"]) - EST_TOTAL) < TOL
    # ☀ is the estimated session, ☾ is A unchanged; they add up to the headline.
    assert abs(D(ls["move"]) - EST_SESSION) < TOL  # before: official -23.70
    assert abs(D(ls["overnight_currency"]) - A) < TOL
    assert abs(D(ls["day_move"]) - D(est["daily_move"])) < TOL
    assert abs(D(ls["move_pct"]) + D(ls["overnight_pct"]) - D(est["daily_growth_pct"])) < D("1e-9")
    assert abs(D(ls["move_pct"]) - EST_SESSION / BASELINE) < D("1e-9")
    assert ls["estimated_funds"] == ["FUNDX"]
    # The "price + currency" block agrees with the same headline.
    assert abs(D(eur["day_split"]["price_move"]) - EST_TOTAL) < TOL
    assert eur["day_split"]["estimated"] is True


def test_rows_and_tick_split_the_estimated_fund(seeded: dict[str, int]) -> None:
    with ledger_session_scope() as s:
        rows = {
            r["symbol"]: r for r in holdings.build(s, ccy="EUR", as_of=MON, now=DURING)["holdings"]
        }
        symbols, _ = scheduler._tick_day_moves(s, MON, R_LIVE, now=DURING)
    fund = rows["FUNDX"]
    assert abs(D(fund["day_overnight"]) - FUND_NIGHT) < TOL  # -32.47
    assert abs(D(fund["day_session"]) - FUND_SESSION) < TOL  # +19.60 (before: no split)
    assert (
        abs(D(fund["day_session"]) + D(fund["day_overnight"]) - D(fund["twin"]["est_today_move"]))
        < TOL
    )
    # Every row's ☀ and ☾ add up to the portfolio's estimated split.
    session = sum((D(r["day_session"]) for r in rows.values()), D(0))
    night = sum((D(r["day_overnight"]) for r in rows.values()), D(0))
    assert abs(session - EST_SESSION) < D("0.03")
    assert abs(night - A) < D("0.03")
    # The tick carries the same figures as the refetch.
    for sym, iid in seeded.items():
        tick, row = symbols[str(iid)], rows[sym]
        assert abs(D(tick["day_session_eur"]) - D(row["day_session"])) < TOL, sym
        assert abs(D(tick["day_overnight_eur"]) - D(row["day_overnight"])) < TOL, sym


def test_usd_view_puts_the_whole_estimate_in_the_session(seeded: dict[str, int]) -> None:
    with ledger_session_scope() as s:
        usd = build_overview(s, ccy="USD", as_of=MON, now=DURING)
        rows = holdings.build(s, ccy="USD", as_of=MON, now=DURING)["holdings"]
    ls = usd["last_session"]
    assert D(usd["kpis"]["estimate"]["daily_move"]) == D(40)
    assert D(ls["overnight_currency"]) == 0
    assert D(ls["move"]) == D(40)
    assert all(r["day_overnight"] is None for r in rows)
