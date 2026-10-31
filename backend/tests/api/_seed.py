"""Tiny shared ledger for the B1 read-API and read-model tests.

Two USD brokerage accounts (VTI is held in BOTH, to prove the holdings rows are
not double counted), one bond fund, EUR->USD 1.10 at the first trade and 1.20
today. Closing values: VTI 15 sh x 250 = 3750, BND 20 sh x 70 = 1400 (USD).
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.repositories import (
    accounts_repo,
    fx_repo,
    instrument_overrides_repo,
    instruments_repo,
    prices_repo,
)

D = Decimal
RATE_THEN = D("1.10")
RATE_NOW = D("1.20")
FIRST_DAY = date(2025, 1, 2)


def _legs(usd: str) -> dict[str, Decimal]:
    amount = D(usd)
    return {
        "net_native": amount,
        "net_usd": amount,
        "net_eur": (amount / RATE_THEN).quantize(D("0.01")),
        "fx_rate_to_eur": RATE_THEN,
    }


def seed_ledger(session: Session) -> dict[str, int]:
    """Insert the fixture ledger; returns ``{symbol: instrument_id}``."""
    main = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Brokerage",
        native_currency="USD",
        account_type="brokerage",
    )
    roth = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Roth",
        native_currency="USD",
        account_type="brokerage",
    )
    vti = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
    bnd = instruments_repo.get_or_create(session, symbol="BND", asset_class="etf")
    instrument_overrides_repo.set_category(session, vti.id, "US Stocks")
    instrument_overrides_repo.set_category(session, bnd.id, "Bonds")

    today = exchange_today()
    for iid, then, now in ((vti.id, "200", "250"), (bnd.id, "75", "70")):
        closes = {FIRST_DAY: D(then), today - timedelta(days=1): D(now), today: D(now)}
        prices_repo.upsert_closes(session, iid, closes)
    fx_repo.upsert_rates(session, {FIRST_DAY - timedelta(days=1): RATE_THEN, today: RATE_NOW})

    def _txn(account_id: int, day: date, kind: str, usd: str, **extra: object) -> Transaction:
        return Transaction(
            account_id=account_id,
            date=day,
            kind=kind,
            source=TransactionSource.MANUAL,
            **_legs(usd),
            **extra,
        )

    session.add_all(
        [
            _txn(main.id, FIRST_DAY, "deposit", "4000"),
            _txn(
                main.id,
                date(2025, 1, 5),
                "buy",
                "-2000",
                instrument_id=vti.id,
                quantity=D("10"),
                price_native=D("200"),
            ),
            _txn(
                main.id,
                date(2025, 1, 6),
                "buy",
                "-1500",
                instrument_id=bnd.id,
                quantity=D("20"),
                price_native=D("75"),
            ),
            _txn(roth.id, FIRST_DAY, "deposit", "1050"),
            _txn(
                roth.id,
                date(2025, 1, 7),
                "buy",
                "-1050",
                instrument_id=vti.id,
                quantity=D("5"),
                price_native=D("210"),
            ),
        ]
    )
    session.flush()
    return {"VTI": vti.id, "BND": bnd.id}
