"""Hard rule: a USD figure is never a EUR figure converted back to dollars.

An all-USD ledger must give IDENTICAL USD figures under any EUR/USD history
(constant 1.10 vs wildly swinging 0.8-1.6). A EUR-native holding is the one
thing that legitimately converts, at the valuation instant's rate.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from api._seed import FIRST_DAY, seed_ledger
from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.models import ALL_METADATAS, Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.readmodels import allocations, periods, rebalance
from investment_dashboard.readmodels.calculator import build_inputs
from investment_dashboard.readmodels.projection import build_seed
from investment_dashboard.readmodels.queries.period_query import _native_usd_boundaries, aggregate
from investment_dashboard.repositories import (
    accounts_repo,
    fx_repo,
    instruments_repo,
    prices_repo,
)
from investment_dashboard.services import positions_service

D = Decimal

Rates = Callable[[date], Decimal]


def _constant(_d: date) -> Decimal:
    return D("1.10")


def _wild(d: date) -> Decimal:
    # Deterministic zig-zag between 0.8 and 1.6, different every day.
    return D("0.8") + D((d.toordinal() * 37) % 81) / D(100)


@contextmanager
def _fresh_session() -> Iterator[Session]:
    eng = create_engine(
        "sqlite:///:memory:", future=True, connect_args={"check_same_thread": False}
    )

    @event.listens_for(eng, "connect")
    def _fk_on(dbapi_conn, _record):  # type: ignore[no-untyped-def]
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    for md in ALL_METADATAS:
        md.create_all(eng)
    s = sessionmaker(bind=eng, autoflush=False, expire_on_commit=False)()
    try:
        yield s
    finally:
        s.close()
        eng.dispose()


def _set_rates(session: Session, rates: Rates) -> None:
    today = exchange_today()
    start = FIRST_DAY - timedelta(days=400)
    series = {start + timedelta(days=k): rates(start + timedelta(days=k)) for k in range(0, 800)}
    series = {d: r for d, r in series.items() if d <= today}
    fx_repo.upsert_rates(session, series, overwrite_manual=True)
    session.flush()


def _usd_figures(session: Session, ids: dict[str, int]) -> dict[str, Any]:
    """Every USD figure touched by the fix, as plain comparable data."""
    today = exchange_today()
    rows = aggregate(session, monthly=False, display_currency="USD", today=today)
    period = [
        (
            r.label,
            r.closing_value_usd,
            r.closing_value_display,
            r.opening_value_display,
            r.growth_pct_display,
            r.total_growth_compounded_usd,
            r.yearly_growth_usd,
        )
        for r in rows
    ]
    monthly_rows = aggregate(session, monthly=True, display_currency="EUR", today=today)
    monthly_usd = [(r.label, r.closing_value_usd, r.yearly_growth_usd) for r in monthly_rows]
    periods_body = periods.build_for_ccy(session, monthly=False, ccy="USD")

    alloc = allocations.build(session, ccy="USD")
    calc = build_inputs(session, ccy="USD")
    calc_view = {
        k: v for k, v in calc.items() if k not in {"fx_usd_per_eur", "projection_defaults"}
    }

    plan = rebalance.build_builder_plan(
        session,
        amount=D("1000"),
        ccy="USD",
        allow_fractional=False,
        allow_sell=False,
        mode="fund",
        fund_weights={ids["VTI"]: D("60"), ids["BND"]: D("40")},
    )
    summary = {k: v for k, v in plan["summary"].items() if not k.startswith("other_")}  # type: ignore[attr-defined]

    seed = build_seed(session, monthly=True, primary="USD", today=today)
    return {
        "period": period,
        "monthly_usd": monthly_usd,
        "periods_body": repr(periods_body),
        "alloc": alloc,
        "calc": calc_view,
        "plan_rows": plan["rows"],
        "plan_categories": plan["categories"],
        "plan_summary": summary,
        "seed": (seed.starting_usd, seed.avg_contribution_usd),
    }


def _scenario(rates: Rates) -> dict[str, Any]:
    with _fresh_session() as session:
        ids = seed_ledger(session)
        _set_rates(session, rates)
        return _usd_figures(session, ids)


def test_all_usd_ledger_is_rate_independent() -> None:
    constant = _scenario(_constant)
    wild = _scenario(_wild)
    for key in constant:
        assert constant[key] == wild[key], key
    # Sanity: the figures are real USD numbers, not blanks.
    assert D(constant["alloc"]["total_value"]) == D("5150")  # 15 x 250 + 20 x 70 = 5150
    assert D(constant["calc"]["total_value"]) == D("5150")
    assert constant["seed"][0] == D("5150")
    assert constant["period"], "period rows expected"


def test_all_usd_golden_values() -> None:
    with _fresh_session() as session:
        ids = seed_ledger(session)
        _set_rates(session, _wild)
        alloc = allocations.build(session, ccy="USD")
        by_cat = {b["label"]: D(b["value"]) for b in alloc["current_by_category"]}
        assert by_cat == {"US Stocks": D("3750"), "Bonds": D("1400")}
        # The calculator's USD cash/total never touch the rate either.
        calc = build_inputs(session, ccy="USD")
        assert D(calc["total_value"]) == D("5150")
        assert {i["symbol"]: D(i["current_value"]) for i in calc["instruments"]} == {
            "VTI": D("3750"),
            "BND": D("1400"),
        }
        plan = rebalance.build_builder_plan(
            session,
            amount=D("1000"),
            ccy="USD",
            allow_fractional=False,
            allow_sell=False,
            mode="fund",
            fund_weights={ids["VTI"]: D("50"), ids["BND"]: D("50")},
        )
        # Whole shares at the native USD close (BND 70): shares x 70 == add_value.
        for row in plan["rows"]:  # type: ignore[attr-defined]
            if row["symbol"] == "BND":
                assert D(row["current_price"]) == D("70")
                assert D(row["add_value"]) == D(row["add_shares"]) * D("70")


def _add_eur_holding(session: Session, price_then: str, price_now: str) -> None:
    acct = accounts_repo.create_account(
        session,
        broker="vanguard",
        account_label="EUR broker",
        native_currency="EUR",
        account_type="brokerage",
    )
    ins = instruments_repo.get_or_create(
        session, symbol="IWDA", asset_class="etf", native_currency="EUR"
    )
    today = exchange_today()
    prices_repo.upsert_closes(
        session,
        ins.id,
        {FIRST_DAY: D(price_then)} | {today - timedelta(days=k): D(price_now) for k in range(7)},
    )
    session.add_all(
        [
            Transaction(
                account_id=acct.id,
                date=FIRST_DAY,
                kind="deposit",
                source=TransactionSource.MANUAL,
                net_native=D("2000"),
                net_eur=D("2000"),
            ),
            Transaction(
                account_id=acct.id,
                date=date(2025, 1, 5),
                kind="buy",
                source=TransactionSource.MANUAL,
                net_native=D("-1000"),
                net_eur=D("-1000"),
                instrument_id=ins.id,
                quantity=D("10"),
                price_native=D("100"),
            ),
        ]
    )
    session.flush()


def test_eur_native_holding_converts_at_the_valuation_instant() -> None:
    today = exchange_today()
    with _fresh_session() as session:
        seed_ledger(session)
        _add_eur_holding(session, "100", "120")
        _set_rates(session, _constant)
        # A distinctive rate today, and on the first of the month / year.
        month_start = today.replace(day=1)
        year_start = today.replace(month=1, day=1)
        fx_repo.upsert_rates(
            session,
            {today: D("1.25"), month_start: D("1.40"), year_start: D("0.90")},
            overwrite_manual=True,
        )
        session.flush()

        # IWDA: 10 sh x 120 EUR = 1200 EUR -> 1500 USD at today's 1.25 (not 1.10).
        alloc = allocations.build(session, ccy="USD")
        assert D(alloc["total_value"]) == D("5150") + D("1500")
        calc = build_inputs(session, ccy="USD")
        by_symbol = {i["symbol"]: D(i["current_value"]) for i in calc["instruments"]}
        assert by_symbol["IWDA"] == D("1500")
        assert D(calc["total_value"]) == D("6650")

        # Boundary values convert the EUR holding at each boundary's own rate.
        year_pos = positions_service.compute_positions(session, as_of=year_start)
        usd_part = sum(
            (p.current_value_native for p in year_pos if p.instrument.native_currency == "USD"),
            start=D(0),
        )
        eur_part = sum(
            (p.current_value_native for p in year_pos if p.instrument.native_currency == "EUR"),
            start=D(0),
        )
        got = _native_usd_boundaries(session, [year_start])[year_start]
        assert got == usd_part + eur_part * D("0.90")


@pytest.mark.parametrize("rates", [_constant, _wild])
def test_usd_openings_equal_native_value(rates: Rates) -> None:
    today = exchange_today()
    year_start = today.replace(month=1, day=1)
    with _fresh_session() as session:
        seed_ledger(session)
        _set_rates(session, rates)
        native: dict[str, Decimal] = {}
        for p in positions_service.compute_positions(session, as_of=year_start):
            sym = p.instrument.symbol
            native[sym] = native.get(sym, D(0)) + p.current_value_native
        got = _native_usd_boundaries(session, [year_start])[year_start]
        assert got == sum(native.values(), start=D(0))
