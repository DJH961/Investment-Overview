"""Golden tests for the day rule of 2026-11-16 (see ``metrics_service.fx_revaluation``).

Notation for Tuesday 27 Oct 2026, EUR view. Baseline = Monday's close prices x Monday's
16:00 ET close rate. A = last night's currency move (Mon close -> Tue 09:30 open rate, on
the previous-close book); B = Tuesday's price move; C = the currency's move during market
hours (open -> close / now); D = tonight's currency move (Tue close -> now, close book).

  market open  : Total = A+B+C (live), day = B+C, night = A
  market shut  : Total = A+B+C FROZEN at the close (close prices x the close rate minus
                 the baseline), day = B+C, night = D (live, beside the total, NOT in it)

Book (USD account, no flows in the session): VTI 10 sh (Mon 1000, Tue 1010) and BND 20 sh
(Mon 500, Tue 505): $10,000 + $10,000 = $20,000 on Monday, $20,200 on Tuesday (+1 %).
EUR/USD: Monday close 1.10, Tuesday 09:35 ET sample (the open) 1.12, Tuesday close 1.13,
then live 1.15 and later 1.20. Wednesday opens at 1.15.

Hand numbers (EUR):
  baseline          = 20000 / 1.10                  = 18181.82
  A                 = 20000 / 1.12 - 20000 / 1.10   =  -324.68
  B                 = (20200 - 20000) / 1.12        =   178.57
  Total at the close= 20200 / 1.13 - 18181.82       =  -305.71   (= A + B + C)
  C                 = 20200 / 1.13 - 20200 / 1.12   =  -159.61
  day (B+C)         = Total - A                     =    18.96
  D at 1.15         = 20200 / 1.15 - 20200 / 1.13   =  -310.89
  D at 1.20         = 20200 / 1.20 - 20200 / 1.13   = -1042.77
Check: A + B + C = -324.68 + 178.57 - 159.61 = -305.72 (rounding) = Total.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from investment_dashboard.db import ledger_session_scope
from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.readmodels import holdings as holdings_rm
from investment_dashboard.readmodels import live_graphs
from investment_dashboard.readmodels.overview import build_overview
from investment_dashboard.repositories import (
    accounts_repo,
    fx_repo,
    instruments_repo,
    intraday_repo,
    prices_repo,
)
from investment_dashboard.services import scheduler

D = Decimal
FRI, MON, TUE, WED = date(2026, 10, 23), date(2026, 10, 26), date(2026, 10, 27), date(2026, 10, 28)
ET = ZoneInfo("America/New_York")
TOL = D("0.011")

R_MON, R_OPEN, R_CLOSE = D("1.10"), D("1.12"), D("1.13")

BASELINE = D("20000") / R_MON  # 18181.82
A = D("20000") / R_OPEN - BASELINE  # -324.68 (last night's currency move)
TOTAL_AT_CLOSE = D("20200") / R_CLOSE - BASELINE  # -305.71 = A + B + C
DAY = TOTAL_AT_CLOSE - A  # 18.96 = B + C


def _at(day: int, hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 10, day, hour, minute, tzinfo=ET).astimezone(UTC)


def _d(live: Decimal) -> Decimal:
    """Tonight's currency move D: the close book revalued from the close rate to ``live``."""
    return D("20200") / live - D("20200") / R_CLOSE


def _seed() -> dict[str, int]:
    ids: dict[str, int] = {}
    with ledger_session_scope() as s:
        acct = accounts_repo.create_account(
            s,
            broker="fidelity",
            account_label="Main",
            native_currency="USD",
            account_type="brokerage",
        )
        s.add(
            Transaction(
                account_id=acct.id,
                date=FRI,
                kind="deposit",
                source=TransactionSource.MANUAL,
                net_native=D("20000"),
            )
        )
        for symbol, shares, px_mon, px_tue in (
            ("VTI", "10", "1000", "1010"),
            ("BND", "20", "500", "505"),
        ):
            inst = instruments_repo.get_or_create(s, symbol=symbol, asset_class="etf")
            ids[symbol] = inst.id
            prices_repo.upsert_closes(
                s,
                inst.id,
                {FRI: D(px_mon), MON: D(px_mon), TUE: D(px_tue), WED: D(px_tue)},
            )
            s.add(
                Transaction(
                    account_id=acct.id,
                    date=FRI,
                    kind="buy",
                    source=TransactionSource.MANUAL,
                    instrument_id=inst.id,
                    quantity=D(shares),
                    price_native=D(px_mon),
                    net_native=-D(shares) * D(px_mon),
                )
            )
        fx_repo.upsert_rates(s, {FRI: R_MON, MON: R_MON, TUE: R_CLOSE, WED: D("1.15")})
        # Tuesday's session opened at 1.12 (09:35 ET) and closed at 1.13 (15:58 ET).
        # (EDT: 13:35 UTC and 19:58 UTC, stored naive-UTC.)
        # Market component of the book: $20,000 at the open, $20,200 at the close.
        intraday_repo.insert_sample(
            s,
            datetime(2026, 10, 27, 13, 35),
            D("20000") / R_OPEN,
            fx_eur_usd=R_OPEN,
            market_value_usd=D("20000"),
        )
        intraday_repo.insert_sample(
            s,
            datetime(2026, 10, 27, 19, 58),
            D("20200") / R_CLOSE,
            fx_eur_usd=R_CLOSE,
            market_value_usd=D("20200"),
        )
    return ids


def _live(rate: Decimal, on: date = TUE) -> None:
    with ledger_session_scope() as s:
        fx_repo.upsert_rates(s, {on: rate})


def _view(ccy: str, now: datetime, as_of: date = TUE) -> dict[str, Any]:
    with ledger_session_scope() as s:
        return build_overview(s, ccy=ccy, as_of=as_of, now=now)


def _rows(ccy: str, now: datetime, as_of: date = TUE) -> list[dict[str, Any]]:
    with ledger_session_scope() as s:
        return holdings_rm.build(s, ccy=ccy, as_of=as_of, now=now)["holdings"]


def _sum(rows: list[dict[str, Any]], key: str) -> Decimal:
    return sum((D(r[key]) for r in rows if r[key] is not None), D(0))


def test_market_open_total_is_live_day_is_b_plus_c_night_is_a(api_db: Path) -> None:
    """Tue 14:00 ET, live 1.13: Total = 20200/1.13 - 20000/1.10 = -305.71 (= A+B+C),
    night = A = -324.68, day = B + C = Total - A = 18.96."""
    _seed()
    _live(R_CLOSE)
    now = _at(27, 14)
    eur = _view("EUR", now)
    rows = _rows("EUR", now)
    ls = eur["last_session"]
    assert ls["market_open"] is True
    assert abs(D(eur["kpis"]["daily_move"]) - TOTAL_AT_CLOSE) < TOL
    assert abs(D(ls["day_move"]) - TOTAL_AT_CLOSE) < TOL
    assert abs(D(ls["overnight_currency"]) - A) < TOL
    assert abs(D(ls["move"]) - DAY) < TOL
    assert abs(D(ls["move"]) + D(ls["overnight_currency"]) - D(ls["day_move"])) < TOL
    # Percentages share the baseline base: day% + night% = total%.
    assert abs(D(ls["move_pct"]) + D(ls["overnight_pct"]) - D(eur["kpis"]["daily_growth_pct"])) < D(
        "1e-9"
    )
    assert abs(D(eur["kpis"]["daily_growth_pct"]) - TOTAL_AT_CLOSE / BASELINE) < D("1e-9")
    # Holdings add up to the portfolio for the total and both parts.
    assert abs(_sum(rows, "today_move") - TOTAL_AT_CLOSE) < D("0.03")
    assert abs(_sum(rows, "day_session") - DAY) < D("0.03")
    assert abs(_sum(rows, "day_overnight") - A) < D("0.03")


def test_after_close_total_is_frozen_while_night_follows_the_live_rate(api_db: Path) -> None:
    """Tue 23:00 ET: the Total stays -305.71 as the live rate goes 1.13 -> 1.15 -> 1.20;
    day = B + C = 18.96 and night = D moves: 0, -310.89, ..."""
    _seed()
    now = _at(27, 23)
    totals: list[Decimal] = []
    for live in (R_CLOSE, D("1.15"), D("1.20")):
        _live(live)
        eur = _view("EUR", now)
        rows = _rows("EUR", now)
        ls = eur["last_session"]
        assert ls["market_open"] is False
        totals.append(D(eur["kpis"]["daily_move"]))
        assert abs(D(eur["kpis"]["daily_move"]) - TOTAL_AT_CLOSE) < TOL, live
        assert abs(D(ls["day_move"]) - TOTAL_AT_CLOSE) < TOL, live
        assert abs(D(eur["kpis"]["daily_growth_pct"]) - TOTAL_AT_CLOSE / BASELINE) < D("1e-9")
        assert abs(D(ls["move"]) - DAY) < TOL, live
        assert abs(D(ls["overnight_currency"]) - _d(live)) < TOL, live
        # The live value (and only it) moves with the rate: close book + night.
        assert abs(D(ls["value_now"]) - D("20200") / live) < TOL, live
        # Holdings: today_move = Total, day = B+C, night = D (the tick sees the same).
        assert abs(_sum(rows, "today_move") - TOTAL_AT_CLOSE) < D("0.03"), live
        if live == R_CLOSE:
            # The currency did not move since the close: no split to show on the rows.
            assert all(r["day_overnight"] is None for r in rows)
            continue
        assert abs(_sum(rows, "day_session") - DAY) < D("0.03"), live
        assert abs(_sum(rows, "day_overnight") - _d(live)) < D("0.03"), live
    assert max(totals) - min(totals) < D("1e-9")
    # Hand check of the two golden nights.
    assert abs(_d(D("1.15")) - D("-310.89")) < D("0.01")


def test_after_close_graph_growth_is_the_frozen_total_and_the_marker_is_live(
    api_db: Path,
) -> None:
    _seed()
    _live(D("1.20"))
    # The graph values "now" at the wall-clock date's rate (the test clock is in the past),
    # so the later date carries the same live rate.
    _live(D("1.20"), on=WED)
    now = _at(27, 23)
    eur = _view("EUR", now)
    with ledger_session_scope() as s:
        graph = live_graphs.build_graph(s, range_key="1d", ccy="EUR", now=now, compare=False)
    assert abs(D(graph["growth"]["pct"]) - D(eur["kpis"]["daily_growth_pct"])) < D("1e-9")
    # The "Now" marker is the live value (incl. D); only the growth is frozen.
    pt = graph["now_point"]
    assert abs(D(pt["v"]) - D("20200") / D("1.20")) < TOL
    assert abs(D(pt["overnight_currency"]) - _d(D("1.20"))) < TOL


def test_tick_matches_the_rows_open_and_shut(api_db: Path) -> None:
    ids = _seed()
    for now, live in ((_at(27, 14), R_CLOSE), (_at(27, 23), D("1.15"))):
        _live(live)
        rows = {r["symbol"]: r for r in _rows("EUR", now)}
        with ledger_session_scope() as s:
            symbols, _cats = scheduler._tick_day_moves(s, TUE, live, now=now)
        for symbol, iid in ids.items():
            tick, row = symbols[str(iid)], rows[symbol]
            assert abs(D(tick["day_move_eur"]) - D(row["today_move"])) < TOL
            assert abs(D(tick["day_session_eur"]) - D(row["day_session"])) < TOL
            assert abs(D(tick["day_overnight_eur"]) - D(row["day_overnight"])) < TOL


def test_usd_view_is_native_and_never_moves_with_the_rate(api_db: Path) -> None:
    """USD: +$200 (+1 %) open or shut, whatever the rate does; no split is shown."""
    _seed()
    for now, live in ((_at(27, 14), R_CLOSE), (_at(27, 23), R_CLOSE), (_at(27, 23), D("1.20"))):
        _live(live)
        usd = _view("USD", now)
        assert D(usd["kpis"]["daily_move"]) == D("200")
        assert D(usd["kpis"]["daily_growth_pct"]) == D("0.01")
        assert D(usd["day_split"]["currency_move"]) == D("0")
        rows = _rows("USD", now)
        assert all(r["day_overnight"] is None for r in rows)
        assert _sum(rows, "today_move") == D("200")


def test_rollover_the_nights_d_becomes_the_new_days_a(api_db: Path) -> None:
    """Wed 09:31 ET: the new session's night figure is last night's D (1.13 -> Wed open 1.15)."""
    _seed()
    with ledger_session_scope() as s:
        # Wednesday's open sample (09:31 ET) at 1.15.
        intraday_repo.insert_sample(
            s,
            datetime(2026, 10, 28, 13, 30, 30),
            D("20200") / D("1.15"),
            fx_eur_usd=D("1.15"),
            market_value_usd=D("20200"),
        )
    now = _at(28, 9, 31)
    eur = _view("EUR", now, as_of=WED)
    ls = eur["last_session"]
    assert ls["market_open"] is True
    assert eur["kpis"]["daily_growth_as_of"] == WED.isoformat()
    assert abs(D(ls["overnight_currency"]) - _d(D("1.15"))) < TOL
    assert abs(D(eur["kpis"]["daily_move"]) - _d(D("1.15"))) < TOL  # prices flat: Total = A
    assert abs(D(ls["move"])) < TOL
