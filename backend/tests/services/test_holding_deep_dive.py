"""7.1 holding deep-dive: per-holding intraday prices, daily values, history, twin.

Synthetic ledgers only (in-memory DB), no network.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.domain.market_hours import is_trading_day
from investment_dashboard.errors import ValidationError
from investment_dashboard.models import Transaction
from investment_dashboard.readmodels import holding_detail
from investment_dashboard.repositories import (
    accounts_repo,
    fx_repo,
    instrument_overrides_repo,
    instruments_repo,
    intraday_repo,
    prices_repo,
    splits_repo,
    symbol_prices_repo,
)
from investment_dashboard.services import (
    holding_values_service,
    positions_service,
    snapshots_service,
    symbol_prices_service,
)
from investment_dashboard.services import intraday_snapshots_service as iss

D = Decimal
MON = date(2024, 6, 3)
_NOW = datetime(2024, 6, 3, 20, 0, tzinfo=UTC)


def _txn(session: Session, account_id: int, instrument_id: int, on: date, kind: str, **kw) -> None:  # type: ignore[no-untyped-def]
    session.add(
        Transaction(
            account_id=account_id,
            instrument_id=instrument_id,
            date=on,
            kind=kind,
            source="manual",
            **kw,
        )
    )


def _account(session: Session, label: str, ccy: str) -> int:
    return accounts_repo.create_account(
        session,
        broker="vanguard",
        account_label=label,
        native_currency=ccy,
        account_type="brokerage",
    ).id


# -- Σ per-holding intraday == intraday_value at every instant ----------------------------


def test_holding_prices_sum_to_the_portfolio_sample_at_every_instant(session: Session) -> None:
    acct = _account(session, "USD", "USD")
    shares = {"AAA": D("10"), "BBB": D("4")}
    for sym, qty in shares.items():
        instr = instruments_repo.get_or_create(session, symbol=sym, native_currency="USD")
        _txn(
            session,
            acct,
            instr.id,
            MON,
            "buy",
            quantity=qty,
            price_native=D("100"),
            net_native=-qty * D("100"),
        )
        prices_repo.upsert_closes(session, instr.id, {MON: D("100")})
    fx_repo.upsert_rates(session, {MON: D("1.10"), date.today(): D("1.10")})
    session.flush()
    bars = {
        "AAA": {datetime(2024, 6, 3, 13, 30): D("99"), datetime(2024, 6, 3, 14, 0): D("103")},
        "BBB": {datetime(2024, 6, 3, 13, 30): D("101"), datetime(2024, 6, 3, 14, 30): D("97")},
    }

    def fetch(symbols, day, *, interval):  # type: ignore[no-untyped-def]
        return {s: dict(bars[s]) for s in symbols}

    written = iss.reconstruct_last_session(session, now=_NOW, fetcher=fetch)
    session.flush()
    assert written >= 3
    start, end = datetime(2024, 6, 3), datetime(2024, 6, 4)
    samples = intraday_repo.list_in_range(session, start, end)
    stored = symbol_prices_service.prices(
        session, shares, start, end, kind=symbol_prices_service.KIND_HOLDING
    )
    by_instant: dict[datetime, Decimal] = {}
    for p in stored:
        by_instant[p.captured_at] = (
            by_instant.get(p.captured_at, D(0)) + shares[p.symbol] * p.price_native
        )
    assert {s.captured_at for s in samples} == set(by_instant)
    for s in samples:
        assert abs(by_instant[s.captured_at] - s.market_value_usd) < D("0.0001")
    # Twin rows of the same table are untouched by holding writes.
    assert symbol_prices_repo.distinct_symbols(session) == []


# -- holding_daily_values: Σ value_native == the native book ------------------------------


def _seed_book(session: Session) -> tuple[int, int, int]:
    """Two accounts, a ledger split, a feed split, a partial sell, a reinvested dividend."""
    usd = _account(session, "USD", "USD")
    eur = _account(session, "EUR", "EUR")
    a = instruments_repo.get_or_create(session, symbol="SPLT", native_currency="USD")
    b = instruments_repo.get_or_create(session, symbol="FEED", native_currency="USD")
    c = instruments_repo.get_or_create(session, symbol="EURO", native_currency="EUR")
    _txn(
        session,
        usd,
        a.id,
        date(2024, 1, 2),
        "buy",
        quantity=D("10"),
        price_native=D("100"),
        net_native=D("-1001"),
        fees_native=D("1"),
    )
    # Ledger split 2:1 on 2024-02-01 (no feed split data for SPLT: ledger fallback).
    _txn(session, usd, a.id, date(2024, 2, 1), "split", quantity=D("10"))
    _txn(
        session,
        usd,
        a.id,
        date(2024, 3, 1),
        "sell",
        quantity=D("-5"),
        price_native=D("60"),
        net_native=D("300"),
    )
    # FEED in both accounts; the feed knows a 3:1 split on 2024-02-15.
    _txn(
        session,
        usd,
        b.id,
        date(2024, 1, 3),
        "buy",
        quantity=D("2"),
        price_native=D("300"),
        net_native=D("-600"),
    )
    _txn(
        session,
        eur,
        b.id,
        date(2024, 1, 4),
        "buy",
        quantity=D("1"),
        price_native=D("300"),
        net_native=D("-280"),
    )
    _txn(session, usd, b.id, date(2024, 2, 15), "split", quantity=D("4"))
    # A reinvested dividend pair on EURO.
    _txn(
        session,
        eur,
        c.id,
        date(2024, 1, 2),
        "buy",
        quantity=D("20"),
        price_native=D("50"),
        net_native=D("-1000"),
    )
    _txn(session, eur, c.id, date(2024, 2, 20), "dividend_cash", net_native=D("10"))
    _txn(
        session,
        eur,
        c.id,
        date(2024, 2, 20),
        "dividend_reinvest",
        quantity=D("0.2"),
        price_native=D("50"),
        net_native=D("-10"),
    )
    prices_repo.upsert_closes(
        session,
        a.id,
        {date(2024, 1, 2): D("50"), date(2024, 2, 5): D("55"), date(2024, 3, 4): D("61")},
    )
    prices_repo.upsert_closes(
        session, b.id, {date(2024, 1, 3): D("100"), date(2024, 3, 1): D("105")}
    )
    prices_repo.upsert_closes(
        session, c.id, {date(2024, 1, 2): D("50"), date(2024, 2, 20): D("50")}
    )
    splits_repo.upsert_splits(session, b.id, {date(2024, 2, 15): D("3")})
    fx_repo.upsert_rates(session, {date(2024, 1, 2): D("1.10")})
    session.flush()
    return a.id, b.id, c.id


def test_sum_of_holding_values_equals_the_native_book(session: Session) -> None:
    _seed_book(session)
    start, end = date(2024, 1, 2), date(2024, 3, 15)
    rows = holding_values_service.holding_values(session, start, end)
    session.flush()
    got: dict[tuple[date, str], Decimal] = {}
    for r in rows:
        got[(r.date, r.currency)] = got.get((r.date, r.currency), D(0)) + r.value_native
    day = start
    checked = 0
    while day <= end:
        if is_trading_day(day):
            want: dict[str, Decimal] = {}
            for p in positions_service.compute_positions(session, as_of=day):
                ccy = p.account.native_currency.upper()
                want[ccy] = want.get(ccy, D(0)) + p.current_value_native
            for ccy, value in want.items():
                assert abs(got.get((day, ccy), D(0)) - value) < D("0.0001"), (day, ccy)
                checked += 1
        day += timedelta(days=1)
    assert checked > 50
    # Stored, so a second read is a lookup and returns the same rows.
    assert holding_values_service.holding_values(session, start, end) == rows


def test_flows_dividends_and_invalidation(session: Session) -> None:
    a, _b, c = _seed_book(session)
    rows = holding_values_service.holding_values(
        session, date(2024, 1, 1), date(2024, 3, 15), [a, c]
    )
    flow = {(r.date, r.instrument_id): r.net_flow_native for r in rows if r.net_flow_native}
    assert flow == {
        (date(2024, 1, 2), a): D("1001"),
        (date(2024, 3, 1), a): D("-300"),
        (date(2024, 1, 2), c): D("1000"),
    }
    div = [(r.date, r.dividends_native) for r in rows if r.dividends_native]
    assert div == [(date(2024, 2, 20), D("10.0"))]  # the reinvested pair counted once
    divs = holding_values_service.holding_dividends(session, date(2024, 1, 1), date(2024, 12, 31))
    assert [(d.date, d.amount_native, d.currency) for d in divs] == [
        (date(2024, 2, 20), D("10.0"), "EUR")
    ]
    # A backdated trade drops that instrument's rows from its date; a read rebuilds them.
    acct = rows[0].account_id
    _txn(
        session,
        acct,
        a,
        date(2024, 2, 5),
        "buy",
        quantity=D("1"),
        price_native=D("55"),
        net_native=D("-55"),
    )
    session.flush()
    holding_values_service.invalidate_instrument_from(session, a, date(2024, 2, 5))
    after = holding_values_service.holding_values(session, date(2024, 2, 6), date(2024, 2, 6), [a])
    assert [r.quantity for r in after] == [D("21")]
    # A price change goes through the snapshot invalidation: every instrument from its date.
    snapshots_service.invalidate_from(session, date(2024, 3, 1))
    session.flush()
    assert holding_values_service.holding_values(session, date(2024, 3, 4), date(2024, 3, 4), [a])


# -- history: golden values on a small ledger ---------------------------------------------


def _seed_simple(session: Session) -> int:
    acct = _account(session, "USD", "USD")
    instr = instruments_repo.get_or_create(session, symbol="GOLD", native_currency="USD")
    _txn(
        session,
        acct,
        instr.id,
        MON,
        "buy",
        quantity=D("10"),
        price_native=D("100"),
        net_native=D("-1000"),
    )
    prices_repo.upsert_closes(session, instr.id, {MON: D("100"), date(2024, 6, 4): D("110")})
    fx_repo.upsert_rates(session, {MON: D("1.25")})
    session.flush()
    return instr.id


def test_history_price_mode_keeps_the_old_shape(session: Session) -> None:
    iid = _seed_simple(session)
    body = holding_detail.build_history(session, iid, range_key="all")
    assert body is not None
    assert [(p["t"], D(p["v"])) for p in body["points"]] == [
        ("2024-06-03", D("100")),
        ("2024-06-04", D("110")),
    ]
    assert body["mode"] == "price"
    assert body["x_mode"] == "date"
    assert all(p["value_eur"] is None for p in body["points"])
    assert D(body["avg_price_native"]) == D("100")
    assert [
        (t["t"], t["kind"], D(t["quantity"]), D(t["price_native"])) for t in body["trades"]
    ] == [("2024-06-03", "buy", D("10"), D("100"))]


def test_history_value_mode_golden(session: Session) -> None:
    iid = _seed_simple(session)
    body = holding_detail.build_history(session, iid, range_key="all", mode="value")
    assert body is not None
    first, second = body["points"][:2]
    assert (first["t"], D(first["value_native"]), D(first["value_usd"]), D(first["value_eur"])) == (
        "2024-06-03",
        D("1000"),
        D("1000"),
        D("800"),
    )
    assert (D(second["value_usd"]), D(second["value_eur"])) == (D("1100"), D("880"))
    assert (D(first["invested_usd"]), D(first["invested_eur"])) == (D("1000"), D("800"))
    period = body["period"]
    # Bought 1000 USD (800 EUR at 1.25); now worth 1100 USD / 880 EUR: +100 / +80.
    assert D(period["change_usd"]) == D("100")
    assert D(period["change_eur"]) == D("80")
    assert D(period["bought_usd"]) == D("1000")
    # Modified Dietz from the day before the first buy: the buy weighs (end - buy) / span.
    today = date.today()
    weight = D((today - MON).days) / D((today - (MON - timedelta(days=1))).days)
    assert abs(D(period["return_usd"]) - D(100) / (D(1000) * weight)) < D("0.0001")
    assert abs(D(period["return_eur"]) - D(80) / (D(800) * weight)) < D("0.0001")


def test_history_nav_fund_has_no_intraday_range(session: Session) -> None:
    acct = _account(session, "USD", "USD")
    fund = instruments_repo.get_or_create(
        session, symbol="FUND", asset_class="mutual_fund", native_currency="USD"
    )
    _txn(
        session,
        acct,
        fund.id,
        MON,
        "buy",
        quantity=D("1"),
        price_native=D("10"),
        net_native=D("-10"),
    )
    session.flush()
    with pytest.raises(ValidationError):
        holding_detail.build_history(session, fund.id, range_key="1d", now=_NOW)
    assert holding_detail.build_history(session, fund.id, range_key="1y") is not None


def test_history_1d_value_reads_holding_prices(session: Session) -> None:
    iid = _seed_simple(session)
    at = datetime(2024, 6, 3, 15, 0)
    symbol_prices_repo.upsert_prices(session, "GOLD", {at: D("102")}, kind="holding")
    intraday_repo.insert_sample(session, at, D("816"), fx_eur_usd=D("1.25"))
    session.flush()
    body = holding_detail.build_history(session, iid, range_key="1d", mode="value", now=_NOW)
    assert body is not None
    assert body["x_mode"] == "time"
    assert len(body["sessions"]) == 1
    (point,) = body["points"]
    assert point["t"] == "2024-06-03T15:00:00+00:00"
    assert (D(point["value_usd"]), D(point["value_eur"])) == (D("1020"), D("816"))


# -- twin ---------------------------------------------------------------------------------


def test_twin_view_shapes(session: Session) -> None:
    acct = _account(session, "USD", "USD")
    fund = instruments_repo.get_or_create(
        session, symbol="FUND", asset_class="mutual_fund", native_currency="USD"
    )
    _txn(
        session,
        acct,
        fund.id,
        date(2024, 5, 1),
        "buy",
        quantity=D("5"),
        price_native=D("200"),
        net_native=D("-1000"),
    )
    days = [date(2024, 5, 27 + i) for i in range(1, 5)] + [MON]  # Tue..Fri + Mon
    navs = {d: D("200") + i for i, d in enumerate(days)}
    prices_repo.upsert_closes(session, fund.id, navs)
    instrument_overrides_repo.upsert(session, fund.id, intraday_twin="TWN")
    rows = {iss._session_close_utc(d): D("100") + D(i) / 2 for i, d in enumerate(days)}
    rows[datetime(2024, 6, 3, 15, 0)] = D("102")
    symbol_prices_repo.upsert_prices(session, "TWN", rows)
    session.flush()

    day = holding_detail.build_twin(session, fund.id, range_key="1d", now=_NOW)
    assert day is not None
    assert (day["twin_symbol"], day["twin_reason"], day["x_mode"]) == ("TWN", "manual", "time")
    assert day["estimate_points"]  # prev NAV x twin / prev twin close
    prev_nav, prev_twin = navs[date(2024, 5, 31)], D("101.5")
    first = day["estimate_points"][0]
    assert D(first["price_native"]) == prev_nav * D("102") / prev_twin
    assert day["rebased"] is None
    assert day["twin_now"]["captured_at"].startswith("2024-06-03T20:00")
    assert len(day["recent"]) <= 5
    assert day["recent"]

    month = holding_detail.build_twin(session, fund.id, range_key="1m", now=_NOW)
    assert month is not None
    assert month["x_mode"] == "date"
    assert month["estimate_points"] == []
    assert month["rebased"][0]["fund_pct"] == "0"
    last = month["rebased"][-1]
    assert D(last["gap_pp"]) == (D(last["twin_pct"]) - D(last["fund_pct"])) * 100

    other = instruments_repo.get_or_create(session, symbol="NOTWIN", native_currency="USD")
    session.flush()
    assert holding_detail.build_twin(session, other.id, range_key="1d", now=_NOW) is None
