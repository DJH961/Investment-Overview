"""Golden tests for THE day-move rule (see ``metrics_service.fx_revaluation``).

A day's move runs from the previous session's close (close prices x the 16:00 ET
close rate) to now (current prices x the LIVE rate) while the market is open; once it
shuts the whole day figure freezes at the close (the currency since then is shown beside
it, not in it); every view rolls over together at the 09:30 ET open; USD is native
dollars.

Book: one USD account, VTI 10 sh bought Fri 23 Oct 2026 at 100. Closes Mon 100,
Tue 110, Wed 121. ECB EUR/USD: 1.10 to Tue, 1.20 on Wed (the live rate). A captured
intraday sample at 15:58 ET on Wed (rate 1.15) is the Wednesday session-close rate.
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

D = Decimal
FRI, MON, TUE, WED = date(2026, 10, 23), date(2026, 10, 26), date(2026, 10, 27), date(2026, 10, 28)
ET = ZoneInfo("America/New_York")
TOL = D("0.01")


def _at(hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 10, 28, hour, minute, tzinfo=ET).astimezone(UTC)


def _seed(*, deposit_today: bool = False) -> None:
    with ledger_session_scope() as s:
        acct = accounts_repo.create_account(
            s,
            broker="fidelity",
            account_label="Main",
            native_currency="USD",
            account_type="brokerage",
        )
        inst = instruments_repo.get_or_create(s, symbol="VTI", asset_class="etf")
        prices_repo.upsert_closes(
            s, inst.id, {FRI: D("100"), MON: D("100"), TUE: D("110"), WED: D("121")}
        )
        fx_repo.upsert_rates(s, {FRI: D("1.10"), MON: D("1.10"), TUE: D("1.10"), WED: D("1.20")})
        legs = {"net_eur": D("-909.09"), "fx_rate_to_eur": D("1.10")}
        rows = [
            Transaction(
                account_id=acct.id,
                date=FRI,
                kind="deposit",
                source=TransactionSource.MANUAL,
                net_native=D("1000"),
                net_usd=D("1000"),
                net_eur=D("909.09"),
                fx_rate_to_eur=D("1.10"),
            ),
            Transaction(
                account_id=acct.id,
                date=FRI,
                kind="buy",
                source=TransactionSource.MANUAL,
                instrument_id=inst.id,
                quantity=D("10"),
                price_native=D("100"),
                net_native=D("-1000"),
                net_usd=D("-1000"),
                **legs,
            ),
        ]
        if deposit_today:
            rows += [
                Transaction(
                    account_id=acct.id,
                    date=WED,
                    kind="deposit",
                    source=TransactionSource.MANUAL,
                    net_native=D("1210"),
                    net_usd=D("1210"),
                    net_eur=D("1008.33"),
                    fx_rate_to_eur=D("1.20"),
                ),
                Transaction(
                    account_id=acct.id,
                    date=WED,
                    kind="buy",
                    source=TransactionSource.MANUAL,
                    instrument_id=inst.id,
                    quantity=D("10"),
                    price_native=D("121"),
                    net_native=D("-1210"),
                    net_usd=D("-1210"),
                    net_eur=D("-1008.33"),
                    fx_rate_to_eur=D("1.20"),
                ),
            ]
        s.add_all(rows)
        # Wednesday's session opened at EUR/USD 1.12 (sample at 09:35 ET = 13:35 UTC) ...
        intraday_repo.insert_sample(
            s, datetime(2026, 10, 28, 13, 35), D("1000"), fx_eur_usd=D("1.12")
        )
        # ... and closed at 1.15 (sample struck at 15:58 ET = 19:58 UTC).
        intraday_repo.insert_sample(
            s, datetime(2026, 10, 28, 19, 58), D("1000"), fx_eur_usd=D("1.15")
        )


def _holdings_move(s: Any, ccy: str, now: datetime) -> Decimal:
    payload = holdings_rm.build(s, ccy=ccy, as_of=WED, now=now)
    return sum((D(h["today_move"]) for h in payload["holdings"] if h["today_move"]), D(0))


def test_eur_market_open_hero_equals_sum_of_holdings(api_db: Path) -> None:
    """Wed 11:00 ET, EUR. Hand check: 10 x 121 / 1.20 - 10 x 110 / 1.10 = 1008.33 - 1000 = 8.33."""
    _seed()
    now = _at(11)
    with ledger_session_scope() as s:
        eur = build_overview(s, ccy="EUR", as_of=WED, now=now)
        rows = _holdings_move(s, "EUR", now)
    hero = D(eur["kpis"]["daily_move"])
    assert abs(hero - (D("1210") / D("1.20") - D("1100") / D("1.10"))) < TOL
    assert abs(hero - rows) < TOL


def test_eur_after_close_fx_move_hero_holdings_graph_and_split_agree(api_db: Path) -> None:
    """Wed 18:00 ET, open rate 1.12, close rate 1.15, live 1.20, EUR (day rule 2026-11-16).

    Total (frozen at the close) = 1210/1.15 - 1000 = 52.17 = sum of holdings = graph tip
    change; A = 1100/1.12 - 1000 = -17.86; day = total - A = 70.03; night D =
    1210/1.20 - 1210/1.15 = -43.84, beside the total and NOT in it.
    """
    _seed()
    now = _at(18)
    with ledger_session_scope() as s:
        eur = build_overview(s, ccy="EUR", as_of=WED, now=now)
        rows = _holdings_move(s, "EUR", now)
        graph = live_graphs.build_graph(s, range_key="1d", ccy="EUR", now=now, compare=False)
    hero = D(eur["kpis"]["daily_move"])
    ls = eur["last_session"]
    total = D("1210") / D("1.15") - D("1000")
    lead = D("1100") / D("1.12") - D("1000")
    assert abs(hero - total) < TOL
    assert abs(rows - hero) < TOL
    assert abs(D(ls["day_move"]) - total) < TOL
    assert abs(D(ls["move"]) - (total - lead)) < TOL
    assert abs(D(ls["overnight_currency"]) - (D("1210") / D("1.20") - D("1210") / D("1.15"))) < TOL
    ref, tip = D(graph["reference"]), D(graph["points"][-1]["v"])
    # The session line ENDS at the close (close prices x close rate): no overnight tail.
    assert abs((tip - ref) - total) < TOL
    # The live value is the separate "now" marker (incl. D); the growth is the frozen total.
    now_pt = graph["now_point"]
    assert abs((D(now_pt["v"]) - ref) - (total + D(ls["overnight_currency"]))) < TOL
    assert abs(D(now_pt["overnight_currency"]) - D(ls["overnight_currency"])) < TOL
    assert abs(D(graph["growth"]["pct"]) - D(eur["kpis"]["daily_growth_pct"])) < D("1e-9")


def test_usd_graph_change_equals_headline_with_fx_move_and_no_flows(api_db: Path) -> None:
    """USD is native dollars: 10 x 121 - 10 x 110 = +$110 (+10%), whatever EUR/USD did."""
    _seed()
    now = _at(18)
    with ledger_session_scope() as s:
        usd = build_overview(s, ccy="USD", as_of=WED, now=now)
        graph = live_graphs.build_graph(s, range_key="1d", ccy="USD", now=now, compare=False)
    assert D(usd["kpis"]["daily_move"]) == D("110")
    assert D(usd["kpis"]["daily_growth_pct"]) == D("0.1")
    assert D(graph["reference"]) == D("1100")
    assert D(graph["points"][-1]["v"]) - D(graph["reference"]) == D("110")
    assert D(graph["growth"]["pct"]) == D(usd["kpis"]["daily_growth_pct"])


def test_deposit_today_graph_change_and_headline_agree(api_db: Path) -> None:
    """A $1,210 deposit buys 10 more shares today: value 2,420 vs 1,100 before.

    Net of the flow: (2420 - 1100 - 1210) / (1100 + 1210) = 110 / 2310 = 4.76%, in the
    headline and in the graph (a deposit is never a gain).
    """
    _seed(deposit_today=True)
    now = _at(18)
    with ledger_session_scope() as s:
        usd = build_overview(s, ccy="USD", as_of=WED, now=now)
        graph = live_graphs.build_graph(s, range_key="1d", ccy="USD", now=now, compare=False)
    expected = D("110") / D("2310")
    assert abs(D(usd["kpis"]["daily_growth_pct"]) - expected) < D("1e-9")
    assert abs(D(graph["growth"]["pct"]) - expected) < D("1e-9")


def test_holdings_and_hero_roll_over_at_the_open_not_midnight(api_db: Path) -> None:
    """09:00 ET Wed both still show Tuesday's session (+$100 vs Monday); 09:31 both roll
    to Wednesday's (+$110 vs Tuesday)."""
    _seed()
    with ledger_session_scope() as s:
        before = build_overview(s, ccy="USD", as_of=WED, now=_at(9))
        before_rows = _holdings_move(s, "USD", _at(9))
        after = build_overview(s, ccy="USD", as_of=WED, now=_at(9, 31))
        after_rows = _holdings_move(s, "USD", _at(9, 31))
    assert before["kpis"]["daily_growth_as_of"] == TUE.isoformat()
    assert D(before["kpis"]["daily_move"]) == D("100")
    assert before_rows == D("100")
    assert after["kpis"]["daily_growth_as_of"] == WED.isoformat()
    assert D(after["kpis"]["daily_move"]) == D("110")
    assert after_rows == D("110")
