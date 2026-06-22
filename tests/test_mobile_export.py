"""Tests for the v3.0 live-web mobile export."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.readmodels.mobile_export import build_mobile_export
from investment_dashboard.repositories import accounts_repo, fx_repo, instruments_repo, prices_repo

AS_OF = date(2024, 6, 15)


def _seed_mobile_portfolio(session: Session) -> None:
    brokerage = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Fidelity Brokerage",
        native_currency="USD",
        account_type="brokerage",
    )
    savings = accounts_repo.create_account(
        session,
        broker="savings_bank",
        account_label="Tagesgeld",
        native_currency="EUR",
        account_type="savings",
    )
    vti = instruments_repo.get_or_create(
        session,
        symbol="VTI",
        name="Vanguard Total Stock Market ETF",
        asset_class="etf",
        native_currency="USD",
    )
    fxaix = instruments_repo.get_or_create(
        session,
        symbol="FXAIX",
        name="Fidelity 500 Index",
        asset_class="mutual_fund",
        native_currency="USD",
    )
    savings_line = instruments_repo.get_or_create(
        session,
        symbol="TG-CASH",
        name="Synthetic savings cash line",
        asset_class="savings",
        native_currency="EUR",
    )
    prices_repo.upsert_closes(
        session,
        vti.id,
        {
            date(2024, 1, 5): Decimal("100.00"),
            date(2024, 6, 1): Decimal("110.00"),
            AS_OF: Decimal("120.00"),
        },
    )
    prices_repo.upsert_closes(
        session,
        fxaix.id,
        {
            date(2024, 2, 1): Decimal("150.00"),
            date(2024, 6, 1): Decimal("155.00"),
            AS_OF: Decimal("160.00"),
        },
    )
    prices_repo.upsert_closes(
        session,
        savings_line.id,
        {
            date(2024, 3, 1): Decimal("500.00"),
            date(2024, 6, 1): Decimal("500.00"),
            AS_OF: Decimal("500.00"),
        },
    )
    fx_repo.upsert_rates(
        session,
        {
            date(2024, 1, 1): Decimal("1.10"),
            date(2024, 1, 5): Decimal("1.10"),
            date(2024, 2, 1): Decimal("1.10"),
            date(2024, 6, 1): Decimal("1.10"),
            AS_OF: Decimal("1.10"),
        },
    )
    session.add_all(
        [
            Transaction(
                account_id=brokerage.id,
                date=date(2024, 1, 5),
                kind="buy",
                instrument_id=vti.id,
                quantity=Decimal("10"),
                price_native=Decimal("100"),
                net_native=Decimal("-1000"),
                net_eur=Decimal("-909.090909"),
                net_usd=Decimal("-1000"),
                source=TransactionSource.MANUAL,
            ),
            Transaction(
                account_id=brokerage.id,
                date=date(2024, 2, 1),
                kind="buy",
                instrument_id=fxaix.id,
                quantity=Decimal("2"),
                price_native=Decimal("150"),
                net_native=Decimal("-300"),
                net_eur=Decimal("-272.727273"),
                net_usd=Decimal("-300"),
                source=TransactionSource.MANUAL,
            ),
            Transaction(
                account_id=savings.id,
                date=date(2024, 1, 2),
                kind="deposit",
                net_native=Decimal("1500.00"),
                net_eur=Decimal("1500.00"),
                net_usd=Decimal("1650.00"),
                source=TransactionSource.MANUAL,
            ),
            Transaction(
                account_id=savings.id,
                date=date(2024, 3, 1),
                kind="buy",
                instrument_id=savings_line.id,
                quantity=Decimal("1"),
                price_native=Decimal("500"),
                net_native=Decimal("-500"),
                net_eur=Decimal("-500"),
                net_usd=Decimal("-550"),
                source=TransactionSource.MANUAL,
            ),
            Transaction(
                account_id=savings.id,
                date=date(2024, 6, 10),
                kind="interest",
                net_native=Decimal("10.00"),
                net_eur=Decimal("10.00"),
                net_usd=Decimal("11.00"),
                source=TransactionSource.MANUAL,
            ),
        ]
    )
    session.flush()


def _assert_decimal_string_or_null(value: Any) -> None:
    assert value is None or isinstance(value, str)
    if value is not None:
        Decimal(value)


def test_mobile_export_shape_and_default_sensitivity(session: Session) -> None:
    _seed_mobile_portfolio(session)

    export = build_mobile_export(session, as_of=AS_OF)

    assert set(export) == {
        "meta",
        "holdings",
        "portfolio_cashflows",
        "cash",
        "period_openings",
        "monthly",
        "yearly",
        "analytics",
        "deposits",
    }
    assert "transactions" not in export
    assert export["meta"]["fx_pivot"] == "EUR"
    assert "base_currency" not in export["meta"]
    assert export["meta"]["display_currency"] == "EUR"
    assert export["meta"]["fx_rate_eur_usd"] == "1.10000000"
    assert export["portfolio_cashflows"]


def test_mobile_export_holdings_cash_and_transactions(session: Session) -> None:
    _seed_mobile_portfolio(session)

    export = build_mobile_export(session, as_of=AS_OF, include_transactions=True)

    assert "transactions" in export
    required = {
        "symbol",
        "name",
        "asset_class",
        "broker",
        "account",
        "native_currency",
        "shares",
        "cost_basis_native",
        "cumulative_dividends_cash_native",
        "price_symbol",
        "price_type",
        "last_known_price_native",
        "cashflows",
    }
    by_symbol = {row["symbol"]: row for row in export["holdings"]}
    assert {"VTI", "FXAIX", "TG-CASH"} <= set(by_symbol)
    for holding in by_symbol.values():
        assert required <= set(holding)
        for key in (
            "shares",
            "cost_basis_native",
            "cumulative_dividends_cash_native",
            "last_known_price_native",
        ):
            _assert_decimal_string_or_null(holding[key])
        for flow in holding["cashflows"]:
            _assert_decimal_string_or_null(flow["amount"])
    assert by_symbol["VTI"]["price_type"] == "market"
    assert by_symbol["FXAIX"]["price_type"] == "nav"
    assert by_symbol["TG-CASH"]["price_type"] == "nav"
    # Each priced holding carries the trading day its exported price came from,
    # so the web can show when the value was last updated (not the export date).
    assert by_symbol["VTI"]["last_price_date"] == AS_OF.isoformat()
    assert by_symbol["FXAIX"]["last_price_date"] == AS_OF.isoformat()
    assert export["cash"] == [
        {
            "account_label": "Tagesgeld",
            "broker": "savings_bank",
            "native_currency": "EUR",
            "balance_native": "1010.000000",
        }
    ]


def test_mobile_export_period_openings(session: Session) -> None:
    _seed_mobile_portfolio(session)

    export = build_mobile_export(session, as_of=AS_OF)
    openings = export["period_openings"]

    _assert_decimal_string_or_null(openings["month_start_value_eur"])
    _assert_decimal_string_or_null(openings["year_start_value_eur"])
    assert {"VTI", "FXAIX", "TG-CASH"} <= set(openings["holdings"])
    for row in openings["holdings"].values():
        _assert_decimal_string_or_null(row["month_start_value_eur"])
        _assert_decimal_string_or_null(row["year_start_value_eur"])


def test_mobile_export_periods_carry_per_date_usd_regardless_of_display_currency(
    session: Session,
) -> None:
    """Period rows must carry per-trade-date USD figures even though the desktop
    display currency is EUR, so the web companion (which works in EUR as its FX
    pivot) can show correct USD contributions/values without rescaling by
    today's spot."""
    _seed_mobile_portfolio(session)

    export = build_mobile_export(session, as_of=AS_OF)
    # The desktop is EUR (default), but the periods are exported with USD detail.
    assert export["meta"]["display_currency"] == "EUR"
    for section in ("monthly", "yearly"):
        rows = export[section]["rows"]
        assert rows, section
        for row in rows:
            assert row["display_currency"] == "USD"
            _assert_decimal_string_or_null(row["contributions_eur"])
            _assert_decimal_string_or_null(row["contributions_display"])
            _assert_decimal_string_or_null(row["closing_value_display"])
    # The 2024 yearly bucket has a 1500 EUR deposit booked at 1.10 → 1650 USD;
    # the USD figure must come from per-date FX, not today's spot on the EUR sum.
    yearly = {r["label"]: r for r in export["yearly"]["rows"]}
    assert yearly["2024"]["contributions_eur"] == "1500.000000"
    assert yearly["2024"]["contributions_display"] == "1650.000000"
