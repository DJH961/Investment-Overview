"""Second-pass audit: the "full history" curve keeps the funded benchmark line.

Before, ``build_for_ccy(full_curve=True)`` rebuilt the curve from raw index closes (a
share price, not a value in the reporting currency), so the benchmark line changed
meaning when the full range was selected while the payload still said "funded".
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from typing import Any

import pytest

from investment_dashboard.models import Account, Transaction, TransactionKind
from investment_dashboard.readmodels import analytics
from investment_dashboard.services import benchmark_service, metrics_service


@pytest.fixture(autouse=True)
def _offline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "investment_dashboard.adapters.yfinance_client.fetch_latest_close", lambda _s: None
    )
    monkeypatch.setattr(
        metrics_service._ValuationCache, "total_value", lambda self, on: Decimal(1000)
    )


def test_full_curve_is_built_with_the_funded_benchmark(
    session: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    acct = Account(
        broker="vanguard", account_label="USD", account_type="brokerage", native_currency="USD"
    )
    session.add(acct)
    session.flush()
    long_ago = date.today() - timedelta(days=900)
    session.add(
        Transaction(
            account_id=acct.id,
            date=long_ago,
            kind=TransactionKind.DEPOSIT.value,
            net_native=Decimal(1000),
            net_eur=Decimal(900),
            net_usd=Decimal(1000),
            source="manual",
        )
    )
    session.flush()

    funded = {long_ago: Decimal(1000)}
    monkeypatch.setattr(
        benchmark_service, "simulate_benchmark_value_series", lambda *_a, **_k: funded
    )
    seen: dict[str, Any] = {}

    def fake_build_curve(*_a: Any, **kwargs: Any) -> list[Any]:
        seen.update(kwargs)
        return []

    monkeypatch.setattr(analytics, "build_curve", fake_build_curve)

    analytics.build_for_ccy(session, ccy="USD", lookback_days=7, full_curve=True)

    assert seen["benchmark_values"] == funded
