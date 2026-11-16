"""Golden ledger for the Risk page: funded benchmark, TWR and long windows.

Two deposits (a small one, then a huge one on a SATURDAY) into a benchmark that is
flat at 100 and then steps to 110. "Same money into the index" must hold 10 shares
from day one plus 500 more bought at the Saturday's forward-filled close, i.e.
510 x 110 = 56 100 on the last day. The portfolio ends at 53 550 (+5 % on the day).
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest

from investment_dashboard.models import (
    Account,
    Instrument,
    PriceHistory,
    Transaction,
    TransactionKind,
)
from investment_dashboard.readmodels.analytics import _summary_fields
from investment_dashboard.readmodels.queries.analytics_query import build_bundle
from investment_dashboard.repositories import fx_repo, snapshots_repo

D0 = date(2026, 3, 2)  # Monday: first deposit 1 000
BIG = date(2026, 4, 4)  # Saturday: huge deposit 50 000
STEP = date(2026, 4, 6)  # Monday: benchmark 100 -> 110
AS_OF = date(2026, 5, 1)  # Friday: portfolio +5 % on the day


@pytest.fixture(autouse=True)
def _offline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "investment_dashboard.adapters.yfinance_client.fetch_latest_close", lambda _s: None
    )


@pytest.fixture
def golden(session):  # type: ignore[no-untyped-def]
    acct = Account(
        broker="vanguard", account_label="B", account_type="brokerage", native_currency="EUR"
    )
    bench = Instrument(symbol="VT", asset_class="etf", native_currency="USD")
    session.add_all([acct, bench])
    session.flush()
    for day, amount in ((D0, 1000), (BIG, 50000)):
        session.add(
            Transaction(
                account_id=acct.id,
                date=day,
                kind=TransactionKind.DEPOSIT.value,
                net_native=Decimal(amount),
                net_eur=Decimal(amount),
                source="manual",
            )
        )
    d = D0 - timedelta(days=10)
    while d <= AS_OF:
        if d < D0:
            value = Decimal(0)
        elif d < BIG:
            value = Decimal(1000)
        elif d < AS_OF:
            value = Decimal(51000)
        else:
            value = Decimal(53550)
        snapshots_repo.upsert_snapshot(session, d, value)
        if d >= D0 and d.weekday() < 5:
            session.add(
                PriceHistory(
                    instrument_id=bench.id,
                    date=d,
                    close_native=Decimal(110) if d >= STEP else Decimal(100),
                    source="benchmark",
                )
            )
        d += timedelta(days=1)
    fx_repo.upsert_rates(session, {D0: Decimal("1.00")})
    session.flush()
    return session


def test_all_range_funded_benchmark_counts_every_deposit(golden) -> None:  # type: ignore[no-untyped-def]
    b = build_bundle(golden, currency="EUR", lookback_days=(AS_OF - D0).days + 5, as_of=AS_OF)
    assert b.start == D0  # starts on the first invested day, not before
    assert b.benchmark_is_funded
    by_day = {p.date: p for p in b.curve}
    # The Saturday deposit lands on the Saturday, at the Friday close of 100.
    assert by_day[BIG].benchmark_value == Decimal(51000)
    assert by_day[AS_OF].benchmark_value == Decimal(56100)
    s = _summary_fields(b)
    assert Decimal(s["benchmark_diff"]) == Decimal(53550 - 56100)
    assert abs(Decimal(s["benchmark_diff_pct"]) - Decimal(-2550) / Decimal(56100)) < Decimal("1e-9")


def test_twr_all_time_is_chained_growth_and_flows_are_not_growth(golden) -> None:  # type: ignore[no-untyped-def]
    b = build_bundle(golden, currency="EUR", lookback_days=(AS_OF - D0).days, as_of=AS_OF)
    assert b.twr is not None
    assert abs(b.twr - Decimal("0.05")) < Decimal("1e-12")
    assert b.cagr is not None
    assert abs(b.cagr - Decimal("0.05")) < Decimal("1e-9")  # span < 1y: not annualised
    assert b.max_drawdown == 0


@pytest.mark.parametrize("lookback", [365, 1095, 1825])
def test_long_windows_equal_all_and_stay_finite(golden, lookback: int) -> None:  # type: ignore[no-untyped-def]
    all_b = build_bundle(golden, currency="EUR", lookback_days=(AS_OF - D0).days, as_of=AS_OF)
    b = build_bundle(golden, currency="EUR", lookback_days=lookback, as_of=AS_OF)
    for name in ("twr", "cagr", "volatility", "max_drawdown", "var_95", "ulcer"):
        got, want = getattr(b, name), getattr(all_b, name)
        assert got == want, name
        assert got is None or got.is_finite(), name
    assert b.start == D0
    assert _summary_fields(b)["benchmark_diff"] == _summary_fields(all_b)["benchmark_diff"]
    assert Decimal(_summary_fields(b)["benchmark_diff"]) == Decimal(-2550)
    assert abs(Decimal(_summary_fields(b)["benchmark_diff_pct"])) < 1
