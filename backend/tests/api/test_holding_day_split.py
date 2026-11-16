"""Per-holding session / overnight split of the day move (golden, hand-worked).

Book (fake symbols): 10 VTI (USD account) closing Mon 100, Tue 110; 10 EEE (EUR
account, EUR-native) closing Mon 50, Tue 55. EUR/USD 1.10 through Tue (the close
rate), 1.20 live on Wed. Wed 08:00 ET: the market is shut, the session is Tue.

EUR view (per holding, never converted):
  VTI  prev 1000/1.10 = 909.09, at close 1100/1.10 = 1000, now 1100/1.20 = 916.67
       -> session +90.91, overnight -83.33
  EEE  EUR-native: prev 500, close 550, now 550 -> session +50, overnight 0
USD view:
  VTI  USD-native: session +100, overnight 0 (no FX in dollars)
  EEE  prev 550, at close 605, now 660 -> session +55, overnight +55
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from investment_dashboard.db import ledger_session_scope
from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.readmodels import holdings as holdings_rm
from investment_dashboard.readmodels.overview import build_overview
from investment_dashboard.repositories import accounts_repo, fx_repo, instruments_repo, prices_repo
from investment_dashboard.services import intraday_snapshots_service, scheduler

D = Decimal
FRI, MON, TUE, WED = date(2026, 10, 23), date(2026, 10, 26), date(2026, 10, 27), date(2026, 10, 28)
ET = ZoneInfo("America/New_York")
CENT = D("0.011")


def _at(hour: int) -> datetime:
    return datetime(2026, 10, 28, hour, 0, tzinfo=ET).astimezone(UTC)


def _seed() -> dict[str, int]:
    ids: dict[str, int] = {}
    with ledger_session_scope() as s:
        for label, ccy, symbol, price0, price1 in (
            ("USD main", "USD", "VTI", "100", "110"),
            ("EUR main", "EUR", "EEE", "50", "55"),
        ):
            acct = accounts_repo.create_account(
                s,
                broker="fidelity",
                account_label=label,
                native_currency=ccy,
                account_type="brokerage",
            )
            inst = instruments_repo.get_or_create(
                s, symbol=symbol, asset_class="etf", native_currency=ccy
            )
            ids[symbol] = inst.id
            prices_repo.upsert_closes(
                s, inst.id, {FRI: D(price0), MON: D(price0), TUE: D(price1), WED: D(price1)}
            )
            cost = D(price0) * 10
            s.add_all(
                [
                    Transaction(
                        account_id=acct.id,
                        date=FRI,
                        kind="deposit",
                        source=TransactionSource.MANUAL,
                        net_native=cost,
                    ),
                    Transaction(
                        account_id=acct.id,
                        date=FRI,
                        kind="buy",
                        source=TransactionSource.MANUAL,
                        instrument_id=inst.id,
                        quantity=D("10"),
                        price_native=D(price0),
                        net_native=-cost,
                    ),
                ]
            )
        fx_repo.upsert_rates(s, {FRI: D("1.10"), MON: D("1.10"), TUE: D("1.10"), WED: D("1.20")})
    return ids


def _rows(ccy: str, now: datetime) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    with ledger_session_scope() as s:
        rows = holdings_rm.build(s, ccy=ccy, as_of=WED, now=now)["holdings"]
        last = build_overview(s, ccy=ccy, as_of=WED, now=now)["last_session"]
    return {r["symbol"]: r for r in rows}, last


def _near(a: Any, b: str, tol: Decimal = CENT) -> bool:
    return abs(D(a) - D(b)) < tol


def test_eur_view_splits_the_usd_holding_and_hides_the_eur_one(api_db: Path) -> None:
    _seed()
    rows, _last = _rows("EUR", _at(8))
    vti, eee = rows["VTI"], rows["EEE"]
    assert _near(vti["day_session"], "90.91")
    assert _near(vti["day_overnight"], "-83.33")
    assert abs(D(vti["day_session_pct"]) - D("0.1")) < D("1e-9")
    assert abs(D(vti["day_overnight_pct"]) - (D("-83.3333333") / D("909.0909091"))) < D("1e-6")
    # An EUR-native holding has no currency leg in EUR: nothing to explain.
    assert (eee["day_session"], eee["day_overnight"]) == (None, None)
    assert (eee["day_session_pct"], eee["day_overnight_pct"]) == (None, None)


def test_usd_view_overnight_is_zero_for_usd_holdings(api_db: Path) -> None:
    _seed()
    rows, _last = _rows("USD", _at(8))
    vti, eee = rows["VTI"], rows["EEE"]
    assert (vti["day_session"], vti["day_overnight"]) == (None, None)
    assert _near(eee["day_session"], "55")
    assert _near(eee["day_overnight"], "55")


def test_parts_add_up_per_holding_and_across_the_book(api_db: Path) -> None:
    """Day rule 2026-11-16, market shut: today_move is the frozen total (day + A) and the
    night D is NOT in it. No session open rate was captured here, so A = 0 and the day
    part equals today_move; the sums equal the hero's last_session figures."""
    _seed()
    for ccy in ("EUR", "USD"):
        rows, last = _rows(ccy, _at(8))
        session_sum = D(0)
        overnight_sum = D(0)
        for r in rows.values():
            move = D(r["today_move"])
            if r["day_overnight"] is None:
                session_sum += move  # no currency move: the whole day move is the session
                continue
            assert D(r["day_session"]) == move
            assert abs(D(r["day_session_pct"]) - D(r["today_pct"])) < D("1e-9")
            session_sum += D(r["day_session"])
            overnight_sum += D(r["day_overnight"])
        assert abs(session_sum - D(last["move"])) < D("0.03"), ccy
        assert abs(session_sum - D(last["day_move"])) < D("0.03"), ccy
        assert abs(overnight_sum - D(last["overnight_currency"])) < D("0.03"), ccy


def test_no_split_while_open_without_an_open_rate(api_db: Path) -> None:
    """No session sample yet (no open rate): nothing to split, nothing shown."""
    _seed()
    for ccy in ("EUR", "USD"):
        rows, last = _rows(ccy, _at(11))
        assert last is None
        for r in rows.values():
            assert (r["day_session"], r["day_overnight"]) == (None, None)
            assert (r["day_session_pct"], r["day_overnight_pct"]) == (None, None)


def _open_rate(monkeypatch: pytest.MonkeyPatch, rate: str = "1.15") -> None:
    monkeypatch.setattr(intraday_snapshots_service, "session_open_fx", lambda *_a, **_k: D(rate))


def test_open_market_overnight_is_last_nights_move_only(
    api_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Wed 11:00 ET, market open. EUR/USD: Tue close 1.10, Wed open 1.15, live 1.20; prices flat.

    EUR view VTI (USD holding): prev 1000, previous-close book at the open rate
    1100/1.15 = 956.52 -> overnight -43.48 (last night only); now 1100/1.20 = 916.67, so
    the session (intraday FX, since the open) is -39.86 and session + overnight = day move
    -83.33. EUR-native EEE: no currency leg, flat prices -> nothing. USD view: VTI nothing;
    EEE prev 605, at the open rate 632.50, now 660 -> overnight +27.50, session +27.50.
    """
    _open_rate(monkeypatch)
    _seed()
    eur_rows, eur_last = _rows("EUR", _at(11))
    usd_rows, usd_last = _rows("USD", _at(11))
    vti = eur_rows["VTI"]
    assert _near(vti["day_overnight"], "-43.48")
    assert _near(vti["day_session"], "-39.86")
    assert D(vti["day_session"]) + D(vti["day_overnight"]) == D(vti["today_move"])
    assert (eur_rows["EEE"]["day_session"], eur_rows["EEE"]["day_overnight"]) == (None, None)
    assert (usd_rows["VTI"]["day_session"], usd_rows["VTI"]["day_overnight"]) == (None, None)
    eee = usd_rows["EEE"]
    assert _near(eee["day_overnight"], "27.5")
    assert _near(eee["day_session"], "27.5")
    # Portfolio: the same parts, flagged as the open-market cut; sums match the rows.
    assert eur_last["market_open"] is True
    assert _near(eur_last["overnight_currency"], "-43.48")
    assert _near(eur_last["move"], "-39.86")
    assert _near(usd_last["overnight_currency"], "27.5")
    assert _near(usd_last["move"], "27.5")
    for ccy, rows, last in (("EUR", eur_rows, eur_last), ("USD", usd_rows, usd_last)):
        session_sum = overnight_sum = D(0)
        for r in rows.values():
            if r["day_overnight"] is None:
                session_sum += D(r["today_move"])
                continue
            session_sum += D(r["day_session"])
            overnight_sum += D(r["day_overnight"])
        assert abs(session_sum - D(last["move"])) < D("0.03"), ccy
        assert abs(overnight_sum - D(last["overnight_currency"])) < D("0.03"), ccy
        assert abs(D(last["move"]) + D(last["overnight_currency"]) - D(last["day_move"])) < D(
            "1e-9"
        )


def test_open_market_tick_matches_the_rows(api_db: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _open_rate(monkeypatch)
    ids = _seed()
    now = _at(11)
    with ledger_session_scope() as s:
        symbols, _cats = scheduler._tick_day_moves(s, WED, D("1.20"), now=now)
    vti = symbols[str(ids["VTI"])]
    assert _near(vti["day_overnight_eur"], "-43.48")
    assert _near(vti["day_session_eur"], "-39.86")
    assert vti["day_overnight_usd"] is None
    assert _near(symbols[str(ids["EEE"])]["day_overnight_usd"], "27.5")


def test_tick_carries_the_same_split(api_db: Path) -> None:
    ids = _seed()
    now = _at(8)
    with ledger_session_scope() as s:
        symbols, _cats = scheduler._tick_day_moves(s, WED, D("1.20"), now=now)
        rows = holdings_rm.build(s, ccy="EUR", as_of=WED, now=now)["holdings"]
    vti = symbols[str(ids["VTI"])]
    row = next(r for r in rows if r["symbol"] == "VTI")
    assert _near(vti["day_session_eur"], row["day_session"])
    assert _near(vti["day_overnight_eur"], row["day_overnight"])
    assert vti["day_overnight_usd"] is None  # USD holding, USD view: nothing moved
    eee = symbols[str(ids["EEE"])]
    assert eee["day_overnight_eur"] is None
    assert _near(eee["day_overnight_usd"], "55")
