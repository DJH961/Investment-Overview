"""``/api/instruments``: list and edit instrument overrides."""

from __future__ import annotations

from fastapi.testclient import TestClient

from investment_dashboard.db import ledger_session_scope
from investment_dashboard.repositories import instruments_repo


def _seed() -> tuple[int, int]:
    with ledger_session_scope() as s:
        a = instruments_repo.get_or_create(s, symbol="AAA.B", name="Fund A", asset_class="etf")
        b = instruments_repo.get_or_create(s, symbol="BBB", asset_class="stock")
        return a.id, b.id


def test_list_and_edit(api_client: TestClient) -> None:
    a, _b = _seed()
    rows = {r["id"]: r for r in api_client.get("/api/instruments").json()}
    assert rows[a]["fetch_symbol"] == "AAA.B"
    assert rows[a]["pricing_mode"] == "auto"
    assert rows[a]["native_currency"] == "USD"

    resp = api_client.patch(
        f"/api/instruments/{a}",
        json={"name": "Nice name", "provider_symbol": "aaa-b", "expense_ratio": "0.0003"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert sorted(body["changed"]) == ["expense_ratio", "name", "provider_symbol"]
    assert body["redownload_suggested"] is True
    got = body["instrument"]
    assert got["name"] == "Nice name"
    assert got["ledger_name"] == "Fund A"
    assert got["fetch_symbol"] == "AAA-B"
    assert got["expense_ratio"] == "0.00030"

    frozen = api_client.patch(f"/api/instruments/{a}", json={"pricing_mode": "delisted"}).json()
    assert frozen["instrument"]["fetch_symbol"] is None
    assert frozen["redownload_suggested"] is False

    cleared = api_client.patch(f"/api/instruments/{a}", json={"name": None}).json()
    assert cleared["instrument"]["name"] == "Fund A"
    unchanged = api_client.patch(f"/api/instruments/{a}", json={"name": None}).json()
    assert unchanged["changed"] == []


def test_validation_is_all_or_nothing(api_client: TestClient) -> None:
    a, _b = _seed()
    resp = api_client.patch(
        f"/api/instruments/{a}",
        json={"name": "ok", "provider_symbol": "BBB", "expense_ratio": "5"},
    )
    assert resp.status_code == 422
    errors = resp.json()["errors"]
    assert set(errors) == {"provider_symbol", "expense_ratio"}
    assert api_client.get(f"/api/instruments/{a}").json()["name"] == "Fund A"
    assert api_client.patch(f"/api/instruments/{a}", json={"pricing_mode": "x"}).status_code == 422
    assert api_client.patch("/api/instruments/9999", json={"name": "x"}).status_code == 404


def _seed_funds() -> dict[str, int]:
    with ledger_session_scope() as s:
        ids = {}
        for sym in ("FXAIX", "FSKAX", "FSELX", "VOO"):
            klass = "etf" if sym == "VOO" else "mutual_fund"
            ids[sym] = instruments_repo.get_or_create(s, symbol=sym, asset_class=klass).id
        return ids


def test_twin_suggestions_list(api_client: TestClient) -> None:
    body = api_client.get("/api/instruments/twin-suggestions").json()
    assert body["FXAIX"] == {
        "etf": "VOO",
        "tier": "same_index",
        "index": "S&P 500",
        "typical_daily_gap": None,
    }
    assert body["VTSAX"]["etf"] == "VTI"
    assert body["VBMFX"]["etf"] == "BND"
    # Measured close twins: a different index, labelled as such.
    assert body["FSKAX"]["tier"] == "close"
    assert body["FSKAX"]["etf"] == "VTI"
    assert body["FNILX"]["etf"] == "VOO"
    # No identical-index ETF and no measured close twin.
    for fund in ("FZILX", "FSELX"):
        assert fund not in body
    close = {k for k, v in body.items() if v["tier"] == "close"}
    assert close == {"FSKAX", "FZROX", "FNILX"}


def test_twin_field_and_suggestion(api_client: TestClient) -> None:
    ids = _seed_funds()
    rows = {r["symbol"]: r for r in api_client.get("/api/instruments").json()}
    assert rows["FXAIX"]["intraday_twin"] is None
    assert rows["FXAIX"]["twin_suggestion"]["etf"] == "VOO"
    assert rows["FXAIX"]["twin_suggestion"]["tier"] == "same_index"
    assert rows["FSKAX"]["twin_suggestion"]["tier"] == "close"
    assert rows["FSELX"]["twin_suggestion"] is None
    assert rows["VOO"]["twin_suggestion"] is None  # ETFs get no twin

    # Nothing is applied automatically; set it by hand (lower-case is normalised).
    resp = api_client.patch(f"/api/instruments/{ids['FSELX']}", json={"intraday_twin": "xlk"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["changed"] == ["intraday_twin"]
    assert resp.json()["instrument"]["intraday_twin"] == "XLK"
    assert resp.json()["redownload_suggested"] is False

    own = api_client.patch(f"/api/instruments/{ids['FXAIX']}", json={"intraday_twin": "FXAIX"})
    assert own.status_code == 422
    assert "intraday_twin" in own.json()["errors"]
    bad = api_client.patch(f"/api/instruments/{ids['FXAIX']}", json={"intraday_twin": "no way"})
    assert bad.status_code == 422

    cleared = api_client.patch(f"/api/instruments/{ids['FSELX']}", json={"intraday_twin": None})
    assert cleared.json()["instrument"]["intraday_twin"] is None


def test_twin_daily_gap_needs_both_histories(api_client: TestClient) -> None:
    from datetime import date, timedelta
    from decimal import Decimal

    from investment_dashboard.db import cache_session_scope
    from investment_dashboard.repositories import prices_repo

    ids = _seed_funds()
    api_client.patch(f"/api/instruments/{ids['FXAIX']}", json={"intraday_twin": "VOO"})
    row = api_client.get(f"/api/instruments/{ids['FXAIX']}").json()
    assert row["twin_daily_gap"] is None  # no cached closes yet: omitted
    start = date(2026, 1, 1)
    fund, etf = {}, {}
    for i in range(30):
        d = start + timedelta(days=i)
        fund[d] = Decimal(100) * (Decimal("1.001") ** i)
        etf[d] = Decimal(500) * (Decimal("1.001") ** i) * (Decimal("1.0002") if i % 2 else 1)
    with cache_session_scope() as cache:
        prices_repo.upsert_closes(cache, ids["FXAIX"], fund)
        prices_repo.upsert_closes(cache, ids["VOO"], etf)
    gap = Decimal(api_client.get(f"/api/instruments/{ids['FXAIX']}").json()["twin_daily_gap"])
    assert Decimal("0.0001") < gap < Decimal("0.0003")
