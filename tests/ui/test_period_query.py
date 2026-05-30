"""Tests for the period (monthly/yearly) aggregation helper."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.repositories import accounts_repo
from investment_dashboard.ui.pages._period_query import aggregate, to_table_rows


def _seed(session: Session) -> None:
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
                date=date(2024, 1, 15),
                kind="deposit",
                net_eur=Decimal("500"),
                source=TransactionSource.MANUAL,
            ),
            Transaction(
                account_id=acct.id,
                date=date(2024, 1, 20),
                kind="dividend_cash",
                net_eur=Decimal("12"),
                source=TransactionSource.MANUAL,
            ),
            Transaction(
                account_id=acct.id,
                date=date(2024, 2, 1),
                kind="deposit",
                net_eur=Decimal("300"),
                source=TransactionSource.MANUAL,
            ),
            Transaction(
                account_id=acct.id,
                date=date(2025, 3, 1),
                kind="interest",
                net_eur=Decimal("8"),
                source=TransactionSource.MANUAL,
            ),
        ]
    )
    session.flush()


def test_monthly_buckets(session: Session) -> None:
    _seed(session)
    rows = aggregate(session, monthly=True)
    labels = [r.label for r in rows]
    assert labels == ["2024-01", "2024-02", "2025-03"]
    jan = rows[0]
    assert jan.contributions == Decimal("500")
    assert jan.dividends == Decimal("12")
    assert jan.net_flow == Decimal("512")


def test_yearly_buckets(session: Session) -> None:
    _seed(session)
    rows = aggregate(session, monthly=False)
    assert [r.label for r in rows] == ["2024", "2025"]
    assert rows[0].contributions == Decimal("800")
    assert rows[1].interest == Decimal("8")


def test_aggregate_without_closing_value_is_zero(session: Session) -> None:
    _seed(session)
    rows = aggregate(session, monthly=False, with_closing_value=False)
    assert all(r.closing_value_eur == Decimal(0) for r in rows)


def test_aggregate_with_closing_value_invokes_positions_service(session: Session) -> None:
    """Closing balance is the cash-only portfolio value when no positions exist.

    With only cash-flow rows in the ledger (deposit/interest, no buys),
    ``total_portfolio_value`` should be zero for every period because
    there are no savings/cash accounts to roll up. The point is that the
    field is populated (not raising) by ``aggregate``.
    """
    _seed(session)
    rows = aggregate(session, monthly=False, today=date(2025, 12, 31))
    assert [r.closing_value_eur for r in rows] == [Decimal(0), Decimal(0)]


def test_to_table_rows_includes_eur_and_usd_columns(session: Session) -> None:
    _seed(session)
    rows = aggregate(session, monthly=True, with_closing_value=False)
    rendered = to_table_rows(rows, currency="USD", fx_rate=Decimal("1.2"))
    assert rendered[0]["contributions"] == "600.00"
    assert rendered[0]["contributions_eur"] == "500.00"
    assert rendered[0]["contributions_usd"] == "600.00"
    assert rendered[0]["net_flow_eur"] == "512.00"
    assert rendered[0]["net_flow_usd"] == "614.40"


def test_to_table_rows_includes_dual_total_growth_columns(session: Session) -> None:
    """v2.5 — every month/year row must carry cumulative Total
    Growth in both EUR and USD (the two headline columns)."""
    _seed(session)
    rows = aggregate(session, monthly=True, with_closing_value=False)
    rendered = to_table_rows(rows, currency="USD", fx_rate=Decimal("1.2"))
    for r in rendered:
        assert "total_growth_eur" in r
        assert "total_growth_usd" in r
        # Either a formatted "x %" or the em-dash when not computable.
        assert r["total_growth_eur"].endswith("%") or r["total_growth_eur"] == "—"
        assert r["total_growth_usd"].endswith("%") or r["total_growth_usd"] == "—"


def test_fill_gaps_pads_contiguous_calendar_months(session: Session) -> None:
    _seed(session)
    rows = aggregate(session, monthly=True, with_closing_value=False, fill_gaps=True)
    labels = [r.label for r in rows]
    # Padded from January of the first active year (2024) through the
    # last active month (2025-03), every month present and contiguous.
    assert labels[0] == "2024-01"
    assert labels[-1] == "2025-03"
    assert len(labels) == 15  # 12 (2024) + 3 (2025)
    # A padded month carries zeroed cashflows.
    feb_2025 = next(r for r in rows if r.label == "2025-02")
    assert feb_2025.contributions == Decimal("0")
    assert feb_2025.net_flow == Decimal("0")
