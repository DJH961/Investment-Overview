"""``GET /api/holdings/{instrument_id}/peek`` on the shared seed ledger.

VTI: Brokerage bought 10 @ 200 on 5 Jan 2025, Roth 5 @ 210 on 7 Jan 2025; both lots
are long-term already (so nothing is "next"), and the last trade is the Roth buy.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.db import ledger_session_scope
from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.repositories import (
    accounts_repo,
    fx_repo,
    instruments_repo,
    intraday_repo,
    prices_repo,
    symbol_prices_repo,
)
from investment_dashboard.services import intraday_snapshots_service

from ._seed import seed_ledger


@pytest.fixture
def ids(api_db: object) -> dict[str, int]:
    with ledger_session_scope() as session:
        out = seed_ledger(session)
    return out


def test_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.get("/api/holdings/1/peek").status_code == 401
    assert anon_client.get("/api/holdings/peeks").status_code == 401


def test_unknown_instrument(api_client: TestClient, ids: dict[str, int]) -> None:
    assert api_client.get("/api/holdings/99999/peek").status_code == 404


def test_peeks_empty_ledger(api_client: TestClient, api_db: object) -> None:
    res = api_client.get("/api/holdings/peeks")
    assert res.status_code == 200, res.text
    assert res.json() == {"peeks": {}}


def test_peek_summarises_tranches_and_last_trade(
    api_client: TestClient, ids: dict[str, int]
) -> None:
    res = api_client.get(f"/api/holdings/{ids['VTI']}/peek")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["instrument_id"] == ids["VTI"]
    assert body["currency"] == "USD"
    assert body["tranches"] == {
        "open_count": 2,
        "next_long_term_on": None,
        "next_long_term_days": None,
    }
    trade = body["last_trade"]
    assert trade["date"] == "2025-01-07"
    assert trade["kind"] == "buy"
    assert Decimal(trade["quantity"]) == 5
    assert Decimal(trade["price_native"]) == 210
    # The week block is present for a listed ETF (points may be empty without stored bars).
    assert body["week"] is not None
    assert isinstance(body["week"]["points"], list)


def test_peeks_returns_all_held_and_matches_single_peek(
    api_client: TestClient, ids: dict[str, int]
) -> None:
    res = api_client.get("/api/holdings/peeks")
    assert res.status_code == 200, res.text
    peeks = res.json()["peeks"]
    assert set(peeks) == {str(ids["VTI"]), str(ids["BND"])}
    for iid in ids.values():
        single = api_client.get(f"/api/holdings/{iid}/peek")
        assert single.status_code == 200
        assert peeks[str(iid)] == single.json()


def test_peeks_matches_single_for_intraday_nav_dividends_and_closed(
    api_client: TestClient, api_db: object
) -> None:
    today = exchange_today()
    sessions = intraday_snapshots_service.recent_trading_sessions()
    prev_session = intraday_snapshots_service.previous_trading_session(sessions[0])
    recent_day = sessions[-2]
    with ledger_session_scope() as session:
        usd_acct = accounts_repo.create_account(
            session,
            broker="fidelity",
            account_label="USD",
            native_currency="USD",
            account_type="brokerage",
        )
        eur_acct = accounts_repo.create_account(
            session,
            broker="vanguard",
            account_label="EUR",
            native_currency="EUR",
            account_type="brokerage",
        )
        etf = instruments_repo.get_or_create(
            session, symbol="SPY", asset_class="etf", native_currency="USD"
        )
        euro_etf = instruments_repo.get_or_create(
            session, symbol="EUNL", asset_class="etf", native_currency="EUR"
        )
        nav_fund = instruments_repo.get_or_create(
            session, symbol="FXAIX", asset_class="mutual_fund", native_currency="USD"
        )
        closed = instruments_repo.get_or_create(
            session, symbol="SOLD", asset_class="stock", native_currency="USD"
        )
        for iid, base_px, end_px in (
            (etf.id, Decimal("500"), Decimal("515")),
            (euro_etf.id, Decimal("80"), Decimal("84")),
            (nav_fund.id, Decimal("180"), Decimal("182")),
            (closed.id, Decimal("40"), Decimal("45")),
        ):
            closes = {
                prev_session - timedelta(days=5): base_px,
                prev_session: base_px,
            }
            for idx, day in enumerate(sessions):
                closes[day] = base_px + (end_px - base_px) * Decimal(idx + 1) / Decimal(
                    len(sessions)
                )
            closes[today] = end_px
            prices_repo.upsert_closes(session, iid, closes)

        fx_repo.upsert_rates(
            session,
            {
                prev_session - timedelta(days=10): Decimal("1.10"),
                prev_session: Decimal("1.10"),
                recent_day: Decimal("1.12"),
                today: Decimal("1.15"),
            },
        )
        t_open = datetime.combine(sessions[0], datetime.min.time()) + timedelta(hours=15)
        t_recent = datetime.combine(recent_day, datetime.min.time()) + timedelta(hours=16)
        symbol_prices_repo.upsert_prices(
            session,
            "SPY",
            {t_open: Decimal("502"), t_recent: Decimal("512")},
            kind=symbol_prices_repo.KIND_HOLDING,
        )
        symbol_prices_repo.upsert_prices(
            session,
            "EUNL",
            {t_recent: Decimal("83")},
            kind=symbol_prices_repo.KIND_HOLDING,
        )
        intraday_repo.insert_sample(session, t_open, Decimal("1000"), fx_eur_usd=Decimal("1.11"))
        intraday_repo.insert_sample(session, t_recent, Decimal("1100"), fx_eur_usd=Decimal("1.13"))

        early = prev_session - timedelta(days=3)
        session.add_all(
            [
                Transaction(
                    account_id=usd_acct.id,
                    instrument_id=etf.id,
                    date=early,
                    kind="buy",
                    source=TransactionSource.MANUAL,
                    quantity=Decimal("10"),
                    price_native=Decimal("500"),
                    net_native=Decimal("-5000"),
                ),
                Transaction(
                    account_id=usd_acct.id,
                    instrument_id=etf.id,
                    date=recent_day,
                    kind="buy",
                    source=TransactionSource.MANUAL,
                    quantity=Decimal("2"),
                    price_native=Decimal("510"),
                    net_native=Decimal("-1020"),
                ),
                Transaction(
                    account_id=usd_acct.id,
                    instrument_id=etf.id,
                    date=recent_day,
                    kind="dividend_cash",
                    source=TransactionSource.MANUAL,
                    net_native=Decimal("25"),
                ),
                Transaction(
                    account_id=eur_acct.id,
                    instrument_id=euro_etf.id,
                    date=early,
                    kind="buy",
                    source=TransactionSource.MANUAL,
                    quantity=Decimal("15"),
                    price_native=Decimal("80"),
                    net_native=Decimal("-1200"),
                ),
                Transaction(
                    account_id=eur_acct.id,
                    instrument_id=euro_etf.id,
                    date=recent_day,
                    kind="dividend_cash",
                    source=TransactionSource.MANUAL,
                    net_native=Decimal("12"),
                ),
                Transaction(
                    account_id=eur_acct.id,
                    instrument_id=euro_etf.id,
                    date=recent_day,
                    kind="dividend_reinvest",
                    source=TransactionSource.MANUAL,
                    quantity=Decimal("0.15"),
                    price_native=Decimal("80"),
                    net_native=Decimal("-12"),
                ),
                Transaction(
                    account_id=usd_acct.id,
                    instrument_id=nav_fund.id,
                    date=early,
                    kind="buy",
                    source=TransactionSource.MANUAL,
                    quantity=Decimal("5"),
                    price_native=Decimal("180"),
                    net_native=Decimal("-900"),
                ),
                Transaction(
                    account_id=usd_acct.id,
                    instrument_id=closed.id,
                    date=early,
                    kind="buy",
                    source=TransactionSource.MANUAL,
                    quantity=Decimal("3"),
                    price_native=Decimal("40"),
                    net_native=Decimal("-120"),
                ),
                Transaction(
                    account_id=usd_acct.id,
                    instrument_id=closed.id,
                    date=prev_session,
                    kind="sell",
                    source=TransactionSource.MANUAL,
                    quantity=Decimal("-3"),
                    price_native=Decimal("45"),
                    net_native=Decimal("135"),
                ),
            ]
        )
        session.flush()
        held_ids = [etf.id, euro_etf.id, nav_fund.id]
        closed_id = closed.id

    res = api_client.get("/api/holdings/peeks")
    assert res.status_code == 200, res.text
    peeks = res.json()["peeks"]
    assert str(closed_id) not in peeks
    assert set(peeks) == {str(iid) for iid in held_ids}
    assert peeks[str(nav_fund.id)]["week"] is None
    assert len(peeks[str(etf.id)]["week"]["points"]) >= 1
    assert peeks[str(etf.id)]["week"]["return_usd"] is not None
    assert peeks[str(etf.id)]["week"]["return_eur"] is not None
    for iid in held_ids:
        single = api_client.get(f"/api/holdings/{iid}/peek")
        assert single.status_code == 200
        assert peeks[str(iid)] == single.json()
