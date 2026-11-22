"""Tests for ``GET /api/currency/dollar/both`` and ``/api/currency/scenarios/both`` (v7.2).

Synthetic ledger (``_seed``) plus a synthetic ~12-year daily rate history; no
network, no real data.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.db import ledger_session_scope
from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.repositories import fx_repo
from investment_dashboard.services import fx_service

from ._seed import seed_ledger


def _history(today: date, existing: set[date]) -> dict[date, Decimal]:
    """Weekdays for ~12 years: a slow zig-zag between 1.00 and 1.30 (4 dp)."""
    out: dict[date, Decimal] = {}
    day = today - timedelta(days=12 * 365)
    i = 0
    while day < today:
        if day.weekday() < 5 and day not in existing:
            phase = i % 600
            step = phase if phase < 300 else 600 - phase
            out[day] = Decimal("1.0000") + Decimal(step) / 1000
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
    fx_service.clear_live_spot()
    yield
    fx_service.clear_live_spot()


def _get(client: TestClient, path: str) -> dict[str, Any]:
    resp = client.get(path)
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


@pytest.mark.parametrize("path", ["/api/currency/dollar/both", "/api/currency/scenarios/both"])
def test_requires_auth(anon_client: TestClient, path: str) -> None:
    assert anon_client.get(path).status_code == 401


def test_dollar_unknown_range_is_rejected(api_client: TestClient, seeded: None) -> None:
    assert api_client.get("/api/currency/dollar/both?range=2y").status_code == 422


def test_dollar_shape_and_quote(api_client: TestClient, seeded: None) -> None:
    body = _get(api_client, "/api/currency/dollar/both?range=1y")
    assert body["EUR"]["quote"] == {"pair": "USD/EUR", "field": "inverse"}
    assert body["USD"]["quote"] == {"pair": "EUR/USD", "field": "rate"}
    for ccy in ("EUR", "USD"):
        assert body[ccy]["ccy"] == ccy
        assert body[ccy]["range"] == "1y"
        assert "does not predict" in body[ccy]["caption"]


def test_dollar_low_is_below_high_in_both_quotes(api_client: TestClient, seeded: None) -> None:
    body = _get(api_client, "/api/currency/dollar/both?range=1y")
    for ccy in ("EUR", "USD"):
        stats = {s["key"]: s for s in body[ccy]["stats"]}
        low, high = stats["low_since_start"], stats["high_since_start"]
        assert Decimal(low["value_display"]) <= Decimal(high["value_display"])
    # The same two days, mirrored: the dollar's low day is EUR/USD's high day.
    eur = {s["key"]: s for s in body["EUR"]["stats"]}
    usd = {s["key"]: s for s in body["USD"]["stats"]}
    assert eur["low_since_start"]["date"] == usd["high_since_start"]["date"]
    assert eur["high_since_start"]["date"] == usd["low_since_start"]["date"]


def test_usd_view_says_what_is_held_outside_dollars(api_client: TestClient, seeded: None) -> None:
    body = _get(api_client, "/api/currency/dollar/both?range=1y")
    usd, eur = body["USD"]["position"], body["EUR"]["position"]
    # The seeded book is all dollars: nothing outside them.
    assert Decimal(usd["other_value"]) == 0
    assert Decimal(usd["other_share"]) == 0
    assert eur["other_value"] is None  # the EUR view keeps its dollar position


def test_dollar_run_months_and_spark(api_client: TestClient, seeded: None) -> None:
    body = _get(api_client, "/api/currency/dollar/both?range=1y")
    for ccy in ("EUR", "USD"):
        run = body[ccy]["trend"]["run"]
        if run is not None:
            assert len(run["months"]) == run["of"]
            assert sum(m["move"] == run["direction"] for m in run["months"]) == run["count"]
        spark = (body[ccy]["next_euro"] or {}).get("spark", [])
        assert [p["t"] for p in spark] == sorted(p["t"] for p in spark)


def test_scenarios_shape(api_client: TestClient, seeded: None) -> None:
    body = _get(api_client, "/api/currency/scenarios/both")
    # The slider spans the same 0.90..1.60 EUR/USD, in the quote each side shows.
    assert (Decimal(body["USD"]["min_rate"]), Decimal(body["USD"]["max_rate"])) == (
        Decimal("0.90"),
        Decimal("1.60"),
    )
    assert (Decimal(body["EUR"]["min_rate"]), Decimal(body["EUR"]["max_rate"])) == (
        Decimal("0.62"),
        Decimal("1.12"),
    )


def test_etag_round_trip(api_client: TestClient, seeded: None) -> None:
    for path in ("/api/currency/dollar/both?range=1y", "/api/currency/scenarios/both"):
        first = api_client.get(path)
        etag = first.headers.get("etag")
        assert etag
        again = api_client.get(path, headers={"If-None-Match": etag})
        assert again.status_code == 304


def test_scenarios_follow_the_quote_shown(api_client: TestClient, seeded: None) -> None:
    body = _get(api_client, "/api/currency/scenarios/both")
    eur, usd = body["EUR"], body["USD"]
    # EUR view: USD/EUR grid, ascending in the quote, rate_display matches the grid.
    assert eur["quote"]["pair"] == "USD/EUR"
    assert Decimal(eur["min_rate"]) == Decimal("0.62")
    shown = [Decimal(r["rate_display"]) for r in eur["rows"]]
    assert shown == sorted(shown)
    for row in eur["rows"][::20]:
        assert abs(Decimal(row["rate"]) * Decimal(row["rate_display"]) - 1) < Decimal("1e-9")
    # The dollar's low is the euro's high: the marks swap with the quote.
    marks_eur = {m["key"]: m for m in eur["marks"]}
    marks_usd = {m["key"]: m for m in usd["marks"]}
    assert marks_eur["historic_low"]["date"] == marks_usd["historic_high"]["date"]
    assert Decimal(marks_eur["historic_low"]["rate_display"]) <= Decimal(
        marks_eur["historic_high"]["rate_display"]
    )
    assert Decimal(marks_usd["historic_low"]["rate_display"]) <= Decimal(
        marks_usd["historic_high"]["rate_display"]
    )
    for side in (eur, usd):
        # Stress rows: the quote shown moved by the shift; seven-figure sums are not needed,
        # only the order and the zero-sum around today's value.
        assert [Decimal(s["shift_pct"]) for s in side["stress"]] == [
            Decimal(x) for x in ("-0.15", "-0.10", "-0.05", "0.05", "0.10", "0.15")
        ]
        for s in side["stress"]:
            assert abs(Decimal(s["value"]) - Decimal(side["value_now"]) - Decimal(s["change"])) < 1
        keys = {s["key"] for s in side["stats"]}
        assert keys <= {"one_cent", "breakeven", "value_at_low", "value_at_high"}
        # The break-even distance reads in the quote shown (shown + move == break-even).
        row = side["rows"][len(side["rows"]) // 2]
        if row["to_breakeven"] is not None and side["breakeven"] is not None:
            be_shown = Decimal(side["breakeven"]["inverse" if side is eur else "rate"])
            assert abs(
                Decimal(row["rate_display"]) + Decimal(row["to_breakeven"]) - be_shown
            ) < Decimal("1e-6")


def test_scenarios_today_row_is_exactly_today(api_client: TestClient, seeded: None) -> None:
    body = _get(api_client, "/api/currency/scenarios/both")
    for ccy in ("EUR", "USD"):
        side = body[ccy]
        today = next(m for m in side["marks"] if m["key"] == "today")
        row = side["rows"][today["row_index"]]
        assert Decimal(row["value"]) == Decimal(side["value_now"])
