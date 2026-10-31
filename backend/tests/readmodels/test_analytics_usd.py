"""Analytics USD figures are built from USD cashflows (currency rule).

Hand-checked scenario (account is USD native; EUR->USD rate falls 1.25 -> 0.80):

* d0 deposit USD 1000 at 1.25  -> net_eur 800,  net_usd 1000
* d1 deposit USD 1000 at 0.80  -> net_eur 1250, net_usd 1000
* EUR snapshots: 800, 2050, 2050  (USD marks: 1000, 1640, 1640)

EUR TWR: d1 start = 800 + 1250 = 2050 -> 2050/2050 - 1 = 0.
USD TWR: d1 start = 1000 + 1000 = 2000 -> 1640/2000 - 1 = -0.18.
(The old code fed EUR flows against USD values: 1640/2250 - 1 = -0.2711.)
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest

from investment_dashboard.models import Account, Transaction, TransactionKind
from investment_dashboard.readmodels.queries.analytics_query import build_bundle
from investment_dashboard.repositories import fx_repo, snapshots_repo
from investment_dashboard.services import metrics_service

D0 = date(2026, 3, 1)
D1 = D0 + timedelta(days=1)
D2 = D0 + timedelta(days=2)


@pytest.fixture(autouse=True)
def _offline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "investment_dashboard.adapters.yfinance_client.fetch_latest_close", lambda _s: None
    )
    # Terminal EUR portfolio value 2050 (no positions needed for the XIRR check).
    monkeypatch.setattr(
        metrics_service._ValuationCache, "total_value", lambda self, on: Decimal(2050)
    )


@pytest.fixture
def seeded(session):  # type: ignore[no-untyped-def]
    acct = Account(
        broker="vanguard", account_label="USD", account_type="brokerage", native_currency="USD"
    )
    session.add(acct)
    session.flush()
    for day, eur in ((D0, "800"), (D1, "1250")):
        session.add(
            Transaction(
                account_id=acct.id,
                date=day,
                kind=TransactionKind.DEPOSIT.value,
                net_native=Decimal(1000),
                net_eur=Decimal(eur),
                net_usd=Decimal(1000),
                source="manual",
            )
        )
    for day, val in ((D0, 800), (D1, 2050), (D2, 2050)):
        snapshots_repo.upsert_snapshot(session, day, Decimal(val))
    fx_repo.upsert_rates(session, {D0: Decimal("1.25"), D1: Decimal("0.80"), D2: Decimal("0.80")})
    session.flush()
    return session


def test_usd_twr_and_contributions_use_usd_cashflows(seeded) -> None:  # type: ignore[no-untyped-def]
    usd = build_bundle(seeded, currency="USD", lookback_days=2, as_of=D2)
    assert [p.portfolio_value for p in usd.curve] == [
        Decimal(1000),
        Decimal("1640.00"),
        Decimal("1640.00"),
    ]
    assert [p.cumulative_contributions for p in usd.curve] == [1000, 2000, 2000]
    assert usd.twr == Decimal("-0.18")


def test_eur_figures_unchanged(seeded) -> None:  # type: ignore[no-untyped-def]
    eur = build_bundle(seeded, currency="EUR", lookback_days=2, as_of=D2)
    assert [p.cumulative_contributions for p in eur.curve] == [800, 2050, 2050]
    assert eur.twr == Decimal(0)


def test_usd_xirr_differs_from_eur_when_fx_moves(seeded) -> None:  # type: ignore[no-untyped-def]
    eur = build_bundle(seeded, currency="EUR", lookback_days=2, as_of=D2)
    usd = build_bundle(seeded, currency="USD", lookback_days=2, as_of=D2)
    assert eur.metrics.xirr is not None and usd.metrics.xirr_usd is not None
    assert eur.xirr == eur.metrics.xirr
    assert usd.xirr == usd.metrics.xirr_usd
    assert usd.xirr != eur.xirr
    # EUR: 800 + 1250 in, 2050 out -> ~0. USD: 2000 in, 1640 out -> clearly negative.
    assert abs(eur.xirr) < Decimal("0.01")
    assert usd.xirr < Decimal("-0.5")
