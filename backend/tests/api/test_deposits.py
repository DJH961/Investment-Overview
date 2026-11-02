"""``/api/deposits`` route."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from fastapi.testclient import TestClient
from hypothesis import given
from hypothesis import strategies as st

from investment_dashboard.db import ledger_session_scope
from investment_dashboard.models import Account, Transaction, TransactionKind
from investment_dashboard.readmodels import deposits as deposits_rm
from investment_dashboard.readmodels.queries.deposits_query import DepositRecord


def test_deposits_per_ccy(api_client: TestClient, api_db) -> None:  # type: ignore[no-untyped-def]
    with ledger_session_scope() as s:
        acct = Account(
            broker="vanguard", account_label="A", account_type="brokerage", native_currency="USD"
        )
        s.add(acct)
        s.flush()
        s.add(
            Transaction(
                account_id=acct.id,
                date=date(2025, 3, 10),
                kind=TransactionKind.DEPOSIT.value,
                net_native=Decimal(1000),
                net_eur=Decimal(800),
                net_usd=Decimal(1000),
                source="manual",
            )
        )
    eur = api_client.get("/api/deposits?ccy=EUR").json()
    usd = api_client.get("/api/deposits?ccy=USD").json()
    assert Decimal(eur["summary"]["total_contrib"]) == Decimal(800)
    assert Decimal(usd["summary"]["total_contrib"]) == Decimal(1000)
    assert Decimal(eur["rows"][0]["amount"]) == Decimal(800)
    assert Decimal(usd["rows"][0]["amount"]) == Decimal(1000)
    assert usd["rows"][0]["currency"] == "USD"


def test_deposits_account_filter(api_client: TestClient, api_db) -> None:  # type: ignore[no-untyped-def]
    assert api_client.get("/api/deposits?account_id=999").json()["rows"] == []
    assert api_client.get("/api/deposits?account_id=0").status_code == 422


def test_deposit_rows_show_conversion_batches_and_ecb_fallback(
    api_client: TestClient,
    api_db,  # type: ignore[no-untyped-def]
) -> None:
    from investment_dashboard.models.fx_conversion import FxConversion

    with ledger_session_scope() as s:
        acct = Account(
            broker="vanguard", account_label="A", account_type="brokerage", native_currency="USD"
        )
        s.add(acct)
        s.flush()
        for d, usd in ((date(2025, 3, 10), 1000), (date(2025, 4, 10), 500)):
            s.add(
                Transaction(
                    account_id=acct.id,
                    date=d,
                    kind=TransactionKind.DEPOSIT.value,
                    net_native=Decimal(usd),
                    net_eur=Decimal(usd) * Decimal("0.8"),
                    net_usd=Decimal(usd),
                    source="manual",
                )
            )
        s.add(
            FxConversion(
                date=date(2025, 3, 1),
                eur_sent=Decimal(800),
                usd_received=Decimal(1000),
                fees_eur=None,
                note=None,
            )
        )
    rows = {r["date"]: r for r in api_client.get("/api/deposits?ccy=EUR").json()["rows"]}
    first, second = rows["2025-03-10"], rows["2025-04-10"]
    assert first["rate_source"] == "conversions"
    assert Decimal(first["effective_rate"]) == Decimal("1.25")
    assert [b["date"] for b in first["conversion_batches"]] == ["2025-03-01"]
    assert second["rate_source"] == "ecb"
    assert second["conversion_batches"] == []
    diag = api_client.get("/api/diagnostics").json()
    check = next(c for c in diag["checks"] if c["id"] == "ecb_fallback_deposits")
    assert check["count"] == 1
    assert check["severity"] == "warning"


def test_deposit_rows_without_conversions_claim_no_source(
    api_client: TestClient,
    api_db,  # type: ignore[no-untyped-def]
) -> None:
    assert api_client.get("/api/deposits").json()["rows"] == []
    check = next(
        c
        for c in api_client.get("/api/diagnostics").json()["checks"]
        if c["id"] == "ecb_fallback_deposits"
    )
    assert check["count"] == 0
    assert check["severity"] == "ok"


def _txn(acct_id: int, day: date, kind: str, native: str, eur: str, **extra: object) -> Transaction:
    return Transaction(
        account_id=acct_id,
        date=day,
        kind=kind,
        net_native=Decimal(native),
        net_usd=Decimal(native),
        net_eur=Decimal(eur),
        source="manual",
        **extra,  # type: ignore[arg-type]
    )


def _ledger() -> int:
    with ledger_session_scope() as s:
        a = Account(
            broker="vanguard", account_label="A", account_type="brokerage", native_currency="USD"
        )
        b = Account(
            broker="vanguard", account_label="B", account_type="brokerage", native_currency="USD"
        )
        s.add_all([a, b])
        s.flush()
        s.add_all(
            [
                _txn(a.id, date(2024, 12, 1), "deposit", "500", "400"),
                _txn(a.id, date(2025, 3, 10), "deposit", "1000", "800"),
                _txn(b.id, date(2025, 3, 20), "withdrawal", "-200", "-160"),
                _txn(b.id, date(2025, 4, 1), "transfer_in", "300", "240"),
            ]
        )
        return int(a.id)


def test_deposits_by_year_and_second_currency(api_client: TestClient, api_db) -> None:  # type: ignore[no-untyped-def]
    _ledger()
    body = api_client.get("/api/deposits?ccy=EUR").json()
    assert body["other_ccy"] == "USD"
    years = {y["year"]: y for y in body["by_year"]}
    assert [y["year"] for y in body["by_year"]] == [2025, 2024]
    assert Decimal(years[2025]["total"]) == 800 - 160 + 240
    assert Decimal(years[2025]["total_other"]) == 1000 - 200 + 300
    assert years[2025]["count"] == 3
    assert Decimal(years[2024]["total"]) == 400
    assert body["years"] == [2025, 2024]
    assert sum(Decimal(y["total"]) for y in body["by_year"]) == Decimal(
        body["summary"]["total_contrib"]
    )
    assert Decimal(body["summary_other"]["total_contrib"]) == 1600
    row = next(r for r in body["rows"] if r["date"] == "2025-03-10")
    assert Decimal(row["amount"]) == 800
    assert Decimal(row["amount_other"]) == 1000
    usd = api_client.get("/api/deposits?ccy=USD").json()
    assert Decimal(usd["by_year"][0]["total"]) == 1100
    assert Decimal(usd["by_year"][0]["total_other"]) == 880


def test_deposits_filters(api_client: TestClient, api_db) -> None:  # type: ignore[no-untyped-def]
    a_id = _ledger()
    kinds = lambda q: sorted(r["kind"] for r in api_client.get(f"/api/deposits?{q}").json()["rows"])  # noqa: E731
    assert kinds("kind=deposit") == ["deposit", "deposit"]
    assert kinds("kind=withdrawal") == ["withdrawal"]
    assert kinds("kind=transfer") == ["transfer_in"]
    assert len(kinds("year=2024")) == 1
    assert len(kinds(f"account_id={a_id}")) == 2
    assert kinds("year=2025&kind=deposit") == ["deposit"]
    filtered = api_client.get("/api/deposits?ccy=EUR&year=2024").json()
    assert [y["year"] for y in filtered["by_year"]] == [2024]
    assert filtered["years"] == [2025, 2024]  # option list is not narrowed
    assert api_client.get("/api/deposits?kind=bogus").status_code == 422


@given(
    st.lists(
        st.tuples(
            st.integers(2015, 2026),
            st.one_of(st.none(), st.decimals(-10_000, 10_000, places=2)),
            st.one_of(st.none(), st.decimals(-10_000, 10_000, places=2)),
        ),
        max_size=30,
    )
)
def test_by_year_sums_to_total(items: list) -> None:  # type: ignore[type-arg]
    records = [
        DepositRecord(
            id=i,
            date=date(y, 6, 1),
            account_label="A",
            native_currency="USD",
            kind="deposit",
            amount_native=Decimal(0),
            amount_eur=eur,
            amount_usd=usd,
            description="",
        )
        for i, (y, eur, usd) in enumerate(items)
    ]
    for ccy, other in (("EUR", "USD"), ("USD", "EUR")):
        rows = deposits_rm._by_year(records, ccy, other)
        pick = (lambda r: r.amount_usd) if ccy == "USD" else (lambda r: r.amount_eur)
        assert sum((Decimal(r["total"]) for r in rows), Decimal(0)) == sum(
            (pick(r) or Decimal(0) for r in records), Decimal(0)
        )
        assert sum(r["count"] for r in rows) == len(records)


def test_dividends_golden(api_client: TestClient, api_db) -> None:  # type: ignore[no-untyped-def]
    from datetime import timedelta

    from investment_dashboard.domain.market_hours import exchange_today
    from investment_dashboard.repositories import fx_repo, instruments_repo

    today = exchange_today()
    recent, old = today - timedelta(days=30), today - timedelta(days=800)
    with ledger_session_scope() as s:
        acct = Account(
            broker="vanguard", account_label="A", account_type="brokerage", native_currency="USD"
        )
        s.add(acct)
        vti = instruments_repo.get_or_create(s, symbol="VTI", asset_class="etf")
        bnd = instruments_repo.get_or_create(s, symbol="BND", asset_class="etf")
        s.flush()
        fx_repo.upsert_rates(s, {old: Decimal("1.00"), recent: Decimal("1.25")})
        s.add_all(
            [
                # Cash-only old dividend: frozen legs, outside the TTM window.
                _txn(acct.id, old, "dividend_cash", "40", "40", instrument_id=bnd.id),
                # Reinvested pair 30 days ago: counted once, via the reinvest row.
                _txn(acct.id, recent, "dividend_cash", "10", "8", instrument_id=vti.id),
                Transaction(
                    account_id=acct.id,
                    date=recent,
                    kind="dividend_reinvest",
                    instrument_id=vti.id,
                    quantity=Decimal("0.04"),
                    price_native=Decimal(250),
                    net_native=Decimal(-10),
                    source="manual",
                ),
                _txn(acct.id, recent, "interest", "5", "4"),
            ]
        )
    eur = api_client.get("/api/deposits/dividends?ccy=EUR").json()
    usd = api_client.get("/api/deposits/dividends?ccy=USD").json()
    # 40 USD at 1.00 = 40 EUR (old) + 10 USD at the 1.25 recent rate = 8 EUR.
    assert Decimal(eur["lifetime_total"]) == 48
    assert Decimal(eur["ttm_total"]) == 8
    assert Decimal(usd["lifetime_total"]) == 50
    assert Decimal(usd["ttm_total"]) == 10
    assert Decimal(eur["lifetime_total_other"]) == 50
    kinds = sorted(r["kind"] for r in eur["rows"])
    assert kinds == ["cash", "interest", "reinvest"]  # paired cash leg not listed
    years = {y["year"]: y for y in eur["by_year"]}
    assert Decimal(years[recent.year]["interest"]) == 4
    assert Decimal(years[recent.year]["dividends"]) == (8 if old.year != recent.year else 48)
    by_holding = {h["symbol"]: h for h in eur["by_holding"]}
    assert Decimal(by_holding["VTI"]["lifetime"]) == 8
    assert Decimal(by_holding["VTI"]["ttm"]) == 8
    assert Decimal(by_holding["BND"]["ttm"]) == 0
    assert [h["symbol"] for h in eur["by_holding"]] == ["BND", "VTI"]
    assert eur["yield_ttm"] is None or Decimal(eur["yield_ttm"]) >= 0


def test_dividends_empty(api_client: TestClient, api_db) -> None:  # type: ignore[no-untyped-def]
    body = api_client.get("/api/deposits/dividends").json()
    assert body["rows"] == []
    assert body["by_holding"] == []
    assert body["yield_ttm"] is None
    assert Decimal(body["ttm_total"]) == 0
