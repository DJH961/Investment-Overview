"""Tests for v2.2 FX-aware ``aggregate(display_currency=...)``."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.repositories import accounts_repo, fx_repo, snapshots_repo
from investment_dashboard.ui.pages._period_query import aggregate, to_table_rows


def _seed_two_jan_deposits(session: Session) -> None:
    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Fidelity",
        native_currency="USD",
        account_type="brokerage",
    )
    session.add_all(
        [
            Transaction(
                account_id=acct.id,
                date=date(2024, 1, 10),
                kind="deposit",
                net_eur=Decimal("1000"),
                source=TransactionSource.MANUAL,
            ),
            Transaction(
                account_id=acct.id,
                date=date(2024, 2, 10),
                kind="deposit",
                net_eur=Decimal("1000"),
                source=TransactionSource.MANUAL,
            ),
        ]
    )
    session.flush()


def test_display_currency_eur_keeps_display_fields_unpopulated(session: Session) -> None:
    _seed_two_jan_deposits(session)
    rows = aggregate(session, monthly=True, with_closing_value=False, display_currency="EUR")
    # EUR is the storage currency — no separate display series is generated.
    assert all(r.contributions_display is None for r in rows)
    assert all(r.display_currency == "" for r in rows)


def test_display_currency_with_no_fx_history_falls_back_silently(
    session: Session,
) -> None:
    """USD requested but no FX series loaded → display fields stay None.

    The renderer's spot-rate fallback in ``to_table_rows`` handles this
    case, so the page still shows something rather than zeros.
    """
    _seed_two_jan_deposits(session)
    rows = aggregate(session, monthly=True, with_closing_value=False, display_currency="USD")
    assert all(r.contributions_display is None for r in rows)


def test_display_currency_usd_uses_per_trade_date_fx(session: Session) -> None:
    """Two deposits, two different EUR→USD rates — buckets reflect that."""
    _seed_two_jan_deposits(session)
    fx_repo.upsert_rates(
        session,
        {
            date(2024, 1, 10): Decimal("1.10"),  # €1000 → $1100
            date(2024, 2, 10): Decimal("1.20"),  # €1000 → $1200
        },
        base="EUR",
        quote="USD",
    )
    session.flush()

    rows = aggregate(session, monthly=True, with_closing_value=False, display_currency="USD")
    by_label = {r.label: r for r in rows}
    assert by_label["2024-01"].contributions_display == Decimal("1100.00")
    assert by_label["2024-02"].contributions_display == Decimal("1200.00")
    # EUR ledger values are unchanged — both display surfaces coexist.
    assert by_label["2024-01"].contributions == Decimal("1000")
    assert by_label["2024-02"].contributions == Decimal("1000")
    assert by_label["2024-01"].display_currency == "USD"


def test_to_table_rows_prefers_display_fields_over_spot_multiplication(
    session: Session,
) -> None:
    """When the FX-aware path populated display fields, render those.

    Crucially: ignore the ``fx_rate`` (today's spot) the caller passes
    in — that would re-scale the already-correct per-trade-date numbers.
    """
    _seed_two_jan_deposits(session)
    fx_repo.upsert_rates(
        session,
        {
            date(2024, 1, 10): Decimal("1.10"),
            date(2024, 2, 10): Decimal("1.20"),
        },
        base="EUR",
        quote="USD",
    )
    session.flush()

    rows = aggregate(session, monthly=True, with_closing_value=False, display_currency="USD")
    # Pass a wildly different spot rate to prove the renderer does NOT
    # use it for the primary column.
    rendered = to_table_rows(rows, currency="USD", fx_rate=Decimal("99"))
    by_label = {r["label"]: r for r in rendered}
    assert by_label["2024-01"]["contributions"] == "1,100.00"
    assert by_label["2024-02"]["contributions"] == "1,200.00"


def test_growth_pct_computed_in_display_currency(session: Session) -> None:
    """Modified Dietz uses display-currency opening/closing & cashflow.

    FX-only price action: portfolio holds €1000 of cash worth $1100 on
    Jan 1 and $1200 on Jan 31 (EUR/USD rose 9.1%). With a Jan-15
    deposit of €500 ($550), USD growth ≠ 0 even though EUR growth is.
    """
    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Fidelity",
        native_currency="USD",
        account_type="brokerage",
    )
    session.add(
        Transaction(
            account_id=acct.id,
            date=date(2024, 1, 15),
            kind="deposit",
            net_eur=Decimal("500"),
            source=TransactionSource.MANUAL,
        )
    )
    # EUR balances: dec-31-2023 €1000, jan-31-2024 €1500 (no return).
    snapshots_repo.upsert_snapshot(session, date(2023, 12, 31), Decimal("1000"))
    snapshots_repo.upsert_snapshot(session, date(2024, 1, 31), Decimal("1500"))
    fx_repo.upsert_rates(
        session,
        {
            date(2023, 12, 31): Decimal("1.10"),
            date(2024, 1, 15): Decimal("1.15"),
            date(2024, 1, 31): Decimal("1.20"),
        },
        base="EUR",
        quote="USD",
    )
    session.flush()

    rows = aggregate(session, monthly=True, today=date(2024, 2, 1), display_currency="USD")
    jan = next(r for r in rows if r.label == "2024-01")
    # EUR growth: (1500 - 1000 - 500) / (1000 + 250) == 0 exactly.
    assert jan.growth_pct == Decimal(0)
    # USD growth: opening $1100, closing $1800, deposit $575.
    # Modified Dietz: (1800 - 1100 - 575) / (1100 + 575/2) ≈ 0.0901
    assert jan.growth_pct_display is not None
    assert jan.growth_pct_display > Decimal("0.08")
    assert jan.growth_pct_display < Decimal("0.10")
