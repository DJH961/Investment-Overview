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


def test_to_table_rows_emits_numeric_companions_for_one_currency_columns(
    session: Session,
) -> None:
    """v2.9.1 — the monthly/yearly tables bind one currency at a time to the
    ``{field}_{ccy}_num`` / ``{field}_{ccy}_signed`` numeric companions."""
    _seed(session)
    rows = aggregate(session, monthly=True, with_closing_value=False)
    rendered = to_table_rows(rows, currency="EUR", fx_rate=Decimal("1.2"))
    r = rendered[0]
    # Money companions exist in both currencies and are floats (or None).
    for field in ("contributions", "dividends", "interest", "net_flow", "closing_value"):
        for ccy in ("eur", "usd"):
            key = f"{field}_{ccy}_num"
            assert key in r
            assert r[key] is None or isinstance(r[key], float)
    # EUR contributions numeric companion matches the EUR bucket (500).
    assert r["contributions_eur_num"] == 500.0
    # Signed ratio companions exist for period + total growth, per currency.
    for field in ("growth_pct", "total_growth"):
        for ccy in ("eur", "usd"):
            assert f"{field}_{ccy}_signed" in r


def test_money_and_pct_columns_bind_to_display_currency() -> None:
    """The column builders target the selected currency's numeric field."""
    from investment_dashboard.ui.pages._period_query import money_column, pct_column

    mc = money_column("Closing value", "closing_value", "USD")
    assert mc["field"] == "closing_value_usd_num"
    assert "valueFormatter" in mc

    pc = pct_column("Total Growth", "total_growth", "EUR")
    assert pc["field"] == "total_growth_eur_signed"
    assert "cellClassRules" in pc


def test_daily_chained_twr_compounds_interior_snapshots(session: Session) -> None:
    """§3.2.12 — when daily snapshots exist *inside* a period, the growth %
    chains each sub-period's return instead of a single Modified-Dietz over
    the whole period (which would average intra-period market swings away)."""
    from investment_dashboard.repositories import snapshots_repo

    acct = accounts_repo.create_account(
        session,
        broker="savings_bank",
        account_label="Direct Savings",
        native_currency="EUR",
        account_type="savings",
    )
    session.add(
        Transaction(
            account_id=acct.id,
            date=date(2024, 1, 15),
            kind="deposit",
            net_eur=Decimal("200"),
            net_native=Decimal("200"),
            source=TransactionSource.MANUAL,
        )
    )
    # Daily portfolio values: open 1000 → +10% by Jan 10 → flat through the
    # Jan-15 deposit → +1.538% tail to close at 1320.
    snapshots_repo.upsert_snapshot(session, date(2023, 12, 31), Decimal("1000"))
    snapshots_repo.upsert_snapshot(session, date(2024, 1, 10), Decimal("1100"))
    snapshots_repo.upsert_snapshot(session, date(2024, 1, 20), Decimal("1300"))
    snapshots_repo.upsert_snapshot(session, date(2024, 1, 31), Decimal("1320"))
    session.flush()

    rows = aggregate(session, monthly=True, today=date(2024, 2, 5))
    jan = next(r for r in rows if r.label == "2024-01")
    # Chained: (1.10)·(1.0)·(1320/1300) − 1 ≈ 0.116923.
    assert jan.growth_pct is not None
    assert abs(jan.growth_pct - Decimal("0.116923")) < Decimal("0.0001")
    # A naive single-period Modified-Dietz would report ≈ 0.10909 — confirm
    # the chained figure is materially different (intra-period swing kept).
    assert jan.growth_pct > Decimal("0.115")


def test_withdrawal_reduces_period_contributions(session: Session) -> None:
    """A withdrawal must net *down* the period's contributions.

    The signed net leg (negative for withdrawals) is added once, matching
    metrics_service. Subtracting it would flip the sign and inflate both the
    contribution figure and the period growth %.
    """
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
                date=date(2024, 1, 5),
                kind="deposit",
                net_eur=Decimal("1000"),
                net_native=Decimal("1100"),
                source=TransactionSource.MANUAL,
            ),
            Transaction(
                account_id=acct.id,
                date=date(2024, 1, 20),
                kind="withdrawal",
                net_eur=Decimal("-400"),
                net_native=Decimal("-440"),
                source=TransactionSource.MANUAL,
            ),
        ]
    )
    session.flush()
    rows = aggregate(session, monthly=True, with_closing_value=False)
    jan = next(r for r in rows if r.label == "2024-01")
    assert jan.contributions == Decimal("600")  # 1000 − 400
    assert jan.net_flow == Decimal("600")


def test_dividends_count_reinvested_value_and_unpaired_cash(session: Session) -> None:
    """Dividend income = reinvested value + un-reinvested cash, counted once.

    A reinvested dividend arrives as a paired cash + reinvest row; only the
    reinvested value is counted (the cash leg is skipped). A settlement-fund
    interest reinvestment carries a zero cash leg, so its value must come from
    quantity × price. An un-reinvested cash dividend counts its cash.
    """
    acct = accounts_repo.create_account(
        session,
        broker="vanguard",
        account_label="Vanguard",
        native_currency="USD",
        account_type="brokerage",
    )
    from investment_dashboard.repositories import instruments_repo

    vti = instruments_repo.get_or_create(session, symbol="VTI", name="VTI")
    vmfxx = instruments_repo.get_or_create(session, symbol="VMFXX", name="VMFXX")
    session.add_all(
        [
            # Reinvested VTI dividend: cash leg (skipped) + reinvest leg (counted).
            Transaction(
                account_id=acct.id,
                instrument_id=vti.id,
                date=date(2024, 3, 10),
                kind="dividend_cash",
                net_native=Decimal("20"),
                net_eur=Decimal("18"),
                net_usd=Decimal("20"),
                source=TransactionSource.MANUAL,
            ),
            Transaction(
                account_id=acct.id,
                instrument_id=vti.id,
                date=date(2024, 3, 10),
                kind="dividend_reinvest",
                quantity=Decimal("0.1"),
                price_native=Decimal("200"),
                net_native=Decimal("-20"),
                net_eur=Decimal("-18"),
                net_usd=Decimal("-20"),
                source=TransactionSource.MANUAL,
            ),
            # VMFXX interest reinvested with a zero cash leg.
            Transaction(
                account_id=acct.id,
                instrument_id=vmfxx.id,
                date=date(2024, 3, 31),
                kind="dividend_reinvest",
                quantity=Decimal("5"),
                price_native=Decimal("1"),
                net_native=Decimal("0"),
                net_eur=Decimal("0"),
                net_usd=Decimal("0"),
                source=TransactionSource.MANUAL,
            ),
            # Un-reinvested cash dividend (the rare early case).
            Transaction(
                account_id=acct.id,
                instrument_id=vti.id,
                date=date(2024, 4, 5),
                kind="dividend_cash",
                net_native=Decimal("7"),
                net_eur=Decimal("6"),
                net_usd=Decimal("7"),
                source=TransactionSource.MANUAL,
            ),
        ]
    )
    session.flush()
    from investment_dashboard.repositories import fx_repo

    fx_repo.upsert_rates(
        session,
        {
            date(2024, 3, 10): Decimal("1"),
            date(2024, 3, 31): Decimal("1"),
            date(2024, 4, 5): Decimal("1"),
        },
        base="EUR",
        quote="USD",
    )
    session.flush()
    rows = aggregate(session, monthly=False, with_closing_value=False, display_currency="USD")
    rendered = to_table_rows(rows, currency="USD", fx_rate=Decimal("1"))
    usd = next(r for r in rendered if r["label"] == "2024")
    # USD income = 20 (VTI reinvest) + 5 (VMFXX) + 7 (cash) = 32; the paired
    # cash leg of the reinvested VTI dividend (20) is NOT double-counted.
    assert usd["dividends_usd_num"] == 32.0
