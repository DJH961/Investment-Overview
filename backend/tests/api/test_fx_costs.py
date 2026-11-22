# ruff: noqa: PT018
"""``GET /api/fx-conversions/costs``: what converting costs you (golden ledger C1-C3).

The arithmetic is worked by hand in ``tests/domain/test_fx_spread.py``.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from fastapi.testclient import TestClient

from investment_dashboard.db import ledger_session_scope
from investment_dashboard.models import FxHistory

FIXINGS = {date(2026, 1, 5): "1.10", date(2026, 2, 2): "1.25", date(2026, 3, 9): "1.00"}
GOLDEN = [
    ("2026-01-05", "1000", "1100", "2", "wise"),
    ("2026-02-02", "900", "1000", "0", "revolut"),
    ("2026-03-09", "1850", "2000", "3", "wise"),
]


def _seed(client: TestClient) -> None:
    with ledger_session_scope() as s:
        for d, r in FIXINGS.items():
            s.add(FxHistory(date=d, base="EUR", quote="USD", rate=Decimal(r)))
    for d, eur, usd, fees, prov in GOLDEN:
        body = {"date": d, "eur_sent": eur, "usd_received": usd, "fees_eur": fees, "provider": prov}
        assert client.post("/api/fx-conversions", json=body).status_code == 201


def test_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.get("/api/fx-conversions/costs").status_code == 401


def test_empty(api_client: TestClient) -> None:
    got = api_client.get("/api/fx-conversions/costs?range=all").json()
    for side in (got["EUR"], got["USD"]):
        assert side["summary"]["count"] == 0
        assert side["rows"] == [] and side["cumulative"] == []
        assert side["best"] is None and side["cheaper_provider"] is None


def test_golden_both_currencies(api_client: TestClient) -> None:
    _seed(api_client)
    got = api_client.get("/api/fx-conversions/costs?range=all").json()
    eur, usd = got["EUR"], got["USD"]
    s = eur["summary"]
    assert s["count"] == 3
    assert (Decimal(s["converted"]), Decimal(s["fees"])) == (3750, 5)
    assert (Decimal(s["spread"]), Decimal(s["cost"])) == (-50, -45)
    assert abs(Decimal(s["avg_off_pct"]) - Decimal("0.011938")) < Decimal("1e-6")
    assert eur["best"]["id"] != eur["worst"]["id"]
    assert [Decimal(p["cost"]) for p in eur["cumulative"]] == [2, 102, -45]
    assert [y["year"] for y in eur["by_year"]] == [2026]
    assert [p["provider"] for p in eur["by_provider"]] == ["wise", "revolut"]
    # revolut costs 100 on 900 (11.1 %), wise -145 on 2850: wise is the cheaper
    assert eur["cheaper_provider"] == "wise"
    u = usd["summary"]
    assert (Decimal(u["converted"]), Decimal(u["fees"])) == (4100, Decimal("5.2"))
    assert (Decimal(u["spread"]), Decimal(u["cost"])) == (-25, Decimal("-19.8"))
    assert [Decimal(p["cost"]) for p in usd["cumulative"]] == [
        Decimal("2.2"),
        Decimal("127.2"),
        Decimal("-19.8"),
    ]
    # the per-conversion row of the list carries fees and cost in both currencies
    rows = {r["date"]: r for r in api_client.get("/api/fx-conversions").json()}
    c2 = rows["2026-02-02"]
    assert (Decimal(c2["cost_eur"]), Decimal(c2["cost_usd"]), Decimal(c2["spread_eur"])) == (
        100,
        125,
        100,
    )


def test_range_limits_the_window(api_client: TestClient) -> None:
    _seed(api_client)
    got = api_client.get("/api/fx-conversions/costs?range=1m").json()
    assert got["EUR"]["summary"]["count"] == 0
    assert api_client.get("/api/fx-conversions/costs?range=bogus").status_code == 422
    for r in ("1d", "1w", "3m", "ytd", "1y", "5y", "10y", "max"):
        assert api_client.get(f"/api/fx-conversions/costs?range={r}").status_code == 200


def test_timing_against_the_month_average(api_client: TestClient) -> None:
    _seed(api_client)
    got = api_client.get("/api/fx-conversions/costs?range=all").json()["EUR"]
    # one fixing per month: the month average is that fixing; C1 0, C2 -1/9, C3 +0.0811
    by_date = {r["date"]: Decimal(r["timing_pct"]) for r in got["rows"]}
    assert abs(by_date["2026-01-05"]) < Decimal("1e-9")
    assert abs(by_date["2026-02-02"] + Decimal(1) / 9) < Decimal("1e-9")
    assert abs(by_date["2026-03-09"] - Decimal("0.081081")) < Decimal("1e-6")
    assert got["timing"]["count"] == 3 and got["timing"]["better"] == 1


def test_weekend_conversion_uses_the_last_fixing_before_it(api_client: TestClient) -> None:
    with ledger_session_scope() as s:
        s.add(FxHistory(date=date(2026, 3, 6), base="EUR", quote="USD", rate=Decimal("1.10")))
    body = {"date": "2026-03-08", "eur_sent": "1000", "usd_received": "1100", "provider": "wise"}
    assert api_client.post("/api/fx-conversions", json=body).status_code == 201
    row = api_client.get("/api/fx-conversions/costs?range=all").json()["EUR"]["rows"][0]
    assert row["ecb_rate_date"] == "2026-03-06"
    assert Decimal(row["cost"]) == 0
