"""``/api/recap`` (7.4 P8) and the real return on ``/api/periods`` (7.4 P10).

Synthetic ledger (``_seed``), a synthetic rate history and a synthetic HICP index;
no network, no real data.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.db import cache_session_scope, ledger_session_scope
from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.readmodels import recap as recap_rm
from investment_dashboard.repositories import fx_repo, hicp_repo
from investment_dashboard.services import fx_service, hicp_service

from ._seed import FIRST_DAY, seed_ledger

#: Euro-area prices rising 0.2 % a month from 100 in Dec 2024 (synthetic).
STEP = Decimal("1.002")


def _index(through: str) -> dict[str, Decimal]:
    out: dict[str, Decimal] = {}
    value = Decimal(100)
    year, month = 2024, 12
    while f"{year:04d}-{month:02d}" <= through:
        out[f"{year:04d}-{month:02d}"] = value
        value *= STEP
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    return out


def _history(today: date, existing: set[date]) -> dict[date, Decimal]:
    out: dict[date, Decimal] = {}
    day = FIRST_DAY - timedelta(days=40)
    i = 0
    while day < today:
        if day.weekday() < 5 and day not in existing:
            out[day] = Decimal("1.08") + Decimal(i % 20) / 1000
            i += 1
        day += timedelta(days=1)
    return out


@pytest.fixture
def seeded(api_db: object) -> Iterator[None]:
    today = exchange_today()
    with ledger_session_scope() as session:
        seed_ledger(session)
        existing = set(fx_repo.get_rates(session))
        fx_repo.upsert_rates(session, _history(today, existing))
    with cache_session_scope() as cache:
        hicp_repo.upsert(
            cache,
            hicp_service.SERIES,
            _index("2025-06").items(),
            fetched_at=datetime(2026, 1, 1, tzinfo=UTC).replace(tzinfo=None),
        )
    fx_service.clear_live_spot()
    yield
    fx_service.clear_live_spot()


def _recap(client: TestClient, period: str | None = None) -> dict[str, Any]:
    url = "/api/recap" + (f"?period={period}" if period else "")
    resp = client.get(url)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _periods(client: TestClient, kind: str) -> dict[str, Any]:
    # Monthly gap-filled, as the Periods page asks for it.
    query = "?fill_gaps=true" if kind == "monthly" else ""
    resp = client.get(f"/api/periods/{kind}/both{query}")
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.get("/api/recap").status_code == 401


def test_bad_period_is_rejected(api_client: TestClient) -> None:
    assert api_client.get("/api/recap?period=2026-13").status_code == 422
    assert api_client.get("/api/recap?period=26-01").status_code == 422


def _same(a: str | None, b: str | None) -> bool:
    """Equal figures; fractions may differ only past the 20th digit (Decimal context)."""
    if a is None or b is None:
        return a is b
    return abs(Decimal(a) - Decimal(b)) < Decimal("1e-20")


@pytest.mark.parametrize(
    ("period", "kind"), [("2025-01", "monthly"), ("2025-03", "monthly"), ("2025", "yearly")]
)
def test_recap_equals_periods(api_client: TestClient, seeded: None, period: str, kind: str) -> None:
    body = _recap(api_client, period)
    both = _periods(api_client, kind)
    assert body["has_data"] is True
    for ccy in ("EUR", "USD"):
        row = next(r for r in both[ccy]["rows"] if r["label"] == period)
        side = body[ccy]
        assert _same(side["contributed"], row["contributions"])
        assert _same(side["dividends"], row["dividends"])
        assert _same(side["interest"], row["interest"])
        assert _same(side["nominal_return"], row["growth_pct"])
        assert _same(side["closing_value"], row["closing_value"])
        assert _same(side["real_return"], row["real_return"])
        assert side["real_to"] == row["real_to"]
        assert side["cashed_out"] == "0"
    # The real return is a euro figure only.
    assert body["USD"]["real_return"] is None


def test_real_return_on_periods_uses_the_index(api_client: TestClient, seeded: None) -> None:
    eur = _periods(api_client, "monthly")["EUR"]
    row = next(r for r in eur["rows"] if r["label"] == "2025-03")
    assert row["growth_pct"] is not None
    expected = (1 + Decimal(row["growth_pct"])) / STEP - 1
    assert abs(Decimal(row["real_return"]) - expected) < Decimal("1e-6")
    assert row["real_to"] == "2025-03"
    # A month after the last published index month has none (the index is late).
    late = next(r for r in eur["rows"] if r["label"] == "2025-08")
    assert late["real_return"] is None
    assert late["real_to"] is None
    usd = _periods(api_client, "monthly")["USD"]
    assert all(r["real_return"] is None for r in usd["rows"])


def test_year_real_return_uses_the_latest_month_and_says_so(
    api_client: TestClient, seeded: None
) -> None:
    eur = _periods(api_client, "yearly")["EUR"]
    row = next(r for r in eur["rows"] if r["label"] == "2025")
    assert row["real_to"] == "2025-06"  # the index stops in June
    expected = (1 + Decimal(row["growth_pct"])) / STEP**6 - 1
    assert abs(Decimal(row["real_return"]) - expected) < Decimal("1e-6")


def test_conversion_cost_counts_only_the_period(api_client: TestClient, seeded: None) -> None:
    body = _recap(api_client, "2025-01")
    for ccy in ("EUR", "USD"):
        side = body[ccy]
        if side["conversions"] == 0:
            assert side["conversion_cost"] is None
        else:
            assert side["conversion_cost"] is not None


def test_ack_hides_the_overview_card(api_client: TestClient, seeded: None) -> None:
    first = _recap(api_client)
    today = exchange_today()
    assert first["period"] == recap_rm.default_period(today)
    assert first["last_ack"] is None
    resp = api_client.post("/api/recap/ack", json={})
    assert resp.status_code == 200, resp.text
    assert resp.json()["last_ack"] == first["period"]
    again = _recap(api_client)
    assert again["due"] is False
    assert again["last_ack"] == first["period"]


def test_ack_rejects_a_bad_period(api_client: TestClient) -> None:
    assert api_client.post("/api/recap/ack", json={"period": "2026-00"}).status_code == 422


def test_cashed_out_comes_from_the_journey(
    api_client: TestClient, seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Euros back from cash-outs: on each Periods row and, equal, in the recap (EUR only)."""
    from investment_dashboard.readmodels import journey_fields as jf
    from investment_dashboard.services import read_cache

    monkeypatch.setattr(jf, "inputs_for", lambda _s: object())
    monkeypatch.setattr(
        jf,
        "cashed_out_by_period",
        lambda _i, *, by: (
            {"2025-01": Decimal("900.5")} if by == "month" else {"2025": Decimal("900.5")}
        ),
    )
    read_cache.invalidate()
    both = _periods(api_client, "monthly")
    row = next(r for r in both["EUR"]["rows"] if r["label"] == "2025-01")
    assert Decimal(row["cashed_out_eur"]) == Decimal("900.5")
    quiet = next(r for r in both["EUR"]["rows"] if r["label"] == "2025-03")
    assert Decimal(quiet["cashed_out_eur"]) == 0
    body = _recap(api_client, "2025-01")
    assert Decimal(body["EUR"]["cashed_out"]) == Decimal("900.5")
    assert body["USD"]["cashed_out"] == "0"


def test_default_period() -> None:
    assert recap_rm.default_period(date(2026, 11, 25)) == "2026-10"
    assert recap_rm.default_period(date(2026, 1, 3)) == "2025"
    assert recap_rm.default_period(date(2026, 2, 1)) == "2026-01"
