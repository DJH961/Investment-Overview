"""B-008: holding EUR figures and dividend income derive from net_native + own-date FX.

Hand-worked golden. USD brokerage, EUR/USD (USD per EUR) 1.25 on every day.
Rows carry deliberately WRONG frozen legs (as if frozen at a different spot);
they must be ignored.

* Buy 10 FAKE1 @ $100 on 1 Oct 2026: net_native = -1000 USD.
  EUR leg = -1000 / 1.25 = -800 (frozen net_eur says -900: ignored).
  USD leg = -1000.
* Cash dividend $50 on 15 Oct 2026 (FAKE1): EUR = 50 / 1.25 = 40 (frozen says 45),
  USD = 50.
* Holding cost basis: EUR 800, USD 1,000.

Figures that move for a real ledger: holding-level EUR cost basis, XIRR/growth
and dividend income wherever a row's frozen EUR leg differs from
net_native / that date's rate (rows frozen at a live spot or a stale rate).
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.domain import dividends
from investment_dashboard.models import Transaction
from investment_dashboard.readmodels.queries.overview_query import compute_instrument_metrics
from investment_dashboard.repositories import accounts_repo, fx_repo, instruments_repo, prices_repo
from investment_dashboard.services import metrics_service, positions_service

D = Decimal
RATE = D("1.25")
BUY_DAY, DIV_DAY, TODAY = date(2026, 10, 1), date(2026, 10, 15), date(2026, 11, 4)


def _book(session: Session, *, rates: bool = True) -> int:
    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="USD Brokerage",
        native_currency="USD",
        account_type="brokerage",
    )
    fake = instruments_repo.get_or_create(session, symbol="FAKE1", asset_class="etf")
    session.add_all(
        [
            Transaction(
                account_id=acct.id,
                instrument_id=fake.id,
                date=BUY_DAY,
                kind="buy",
                quantity=D("10"),
                price_native=D("100"),
                net_native=D("-1000"),
                net_eur=D("-900"),
                net_usd=D("-1000"),
                source="manual",
            ),
            Transaction(
                account_id=acct.id,
                instrument_id=fake.id,
                date=DIV_DAY,
                kind="dividend_cash",
                net_native=D("50"),
                net_eur=D("45"),
                net_usd=D("50"),
                source="manual",
            ),
        ]
    )
    prices_repo.upsert_closes(session, fake.id, {BUY_DAY: D("100"), TODAY: D("100")})
    if rates:
        fx_repo.upsert_rates(session, {BUY_DAY: RATE, DIV_DAY: RATE, TODAY: RATE})
    session.flush()
    return fake.id


def test_instrument_cashflows_use_own_date_rate(session: Session) -> None:
    fake = _book(session)
    eur, usd = metrics_service.build_instrument_cashflows(session, as_of=TODAY)
    assert [(c.date, c.amount) for c in eur[fake]] == [(BUY_DAY, D("-800")), (DIV_DAY, D("40"))]
    assert [(c.date, c.amount) for c in usd[fake]] == [(BUY_DAY, D("-1000")), (DIV_DAY, D("50"))]


def test_holding_cost_basis_ignores_frozen_legs(session: Session) -> None:
    fake = _book(session)
    positions = positions_service.compute_positions(session, as_of=TODAY)
    im = compute_instrument_metrics(session, positions, as_of=TODAY)[fake]
    assert im.cost_basis_eur == D("800")
    assert im.cost_basis_usd == D("1000")


def test_no_rate_never_uses_todays_spot(session: Session) -> None:
    """No FX on file: the USD leg is exact; the EUR leg is never today's spot.

    (``cashflows.txn_eur_amount`` keeps the frozen leg as its documented last
    resort when no rate exists; that is not the spot.)
    """
    fake = _book(session, rates=False)
    eur, usd = metrics_service.build_instrument_cashflows(session, as_of=TODAY)
    assert [c.amount for c in usd[fake]] == [D("-1000"), D("50")]
    assert all(c.amount != D("-1000") / RATE for c in eur.get(fake, []))


def test_income_dual_cash_dividend_ignores_frozen_legs() -> None:
    from types import SimpleNamespace
    from typing import Any, cast

    cash = cast(
        "Transaction",
        cast(
            "Any",
            SimpleNamespace(
                kind="dividend_cash",
                account_id=1,
                instrument_id=10,
                date=DIV_DAY,
                quantity=None,
                price_native=None,
                net_native=D("50"),
                net_eur=D("45"),
                net_usd=D("49"),
                account=SimpleNamespace(native_currency="USD"),
            ),
        ),
    )
    keys = dividends.reinvest_keys([cash])
    eur, usd = dividends.income_dual(cash, keys, eur_to_usd={DIV_DAY: RATE})
    assert eur == D("40")  # 50 / 1.25, not the frozen 45
    assert usd == D("50")  # net_native, not the frozen 49
    # No rate on file: EUR is unknown (None), never the frozen leg or a spot.
    eur2, usd2 = dividends.income_dual(cash, keys, eur_to_usd={})
    assert eur2 is None
    assert usd2 == D("50")
