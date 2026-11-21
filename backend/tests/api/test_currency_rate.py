"""Tests for ``GET /api/currency/rate-history`` (the Currency page EUR/USD chart, v7.2).

Synthetic ledger (``_seed``) plus a synthetic ~12-year daily rate history; no
network, no real data.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.db import ledger_session_scope
from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.readmodels import currency_rate as rate_rm
from investment_dashboard.repositories import fx_repo
from investment_dashboard.services import (
    fx_conversion_service,
    fx_service,
    intraday_snapshots_service,
)

from ._seed import seed_ledger

CONVERSION_DAY_OFFSET = 40


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
        fx_conversion_service.create_conversion(
            session,
            on=today - timedelta(days=CONVERSION_DAY_OFFSET),
            eur_sent=Decimal("1000"),
            usd_received=Decimal("1150"),
        )
    fx_service.clear_live_spot()
    yield
    fx_service.clear_live_spot()


def _get(client: TestClient, rng: str) -> dict[str, Any]:
    resp = client.get(f"/api/currency/rate-history?range={rng}")
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.get("/api/currency/rate-history?range=1y").status_code == 401


def test_unknown_range_is_rejected(api_client: TestClient, seeded: None) -> None:
    assert api_client.get("/api/currency/rate-history?range=2y").status_code == 422


@pytest.mark.parametrize(
    ("rng", "granularity", "has_ma"),
    [
        ("1m", "daily", False),
        ("3m", "daily", False),
        ("ytd", "daily", False),
        ("1y", "daily", True),
        ("5y", "daily", True),
        ("10y", "weekly", True),
        ("max", "weekly", True),
    ],
)
def test_daily_and_weekly_ranges(
    api_client: TestClient, seeded: None, rng: str, granularity: str, has_ma: bool
) -> None:
    body = _get(api_client, rng)
    assert body["range"] == rng
    assert body["granularity"] == granularity
    assert body["source"] == "ECB reference rate"
    points = body["points"]
    assert points
    today = exchange_today()
    start = rate_rm.range_start(rng, today)
    assert date.fromisoformat(points[0]["t"]) >= start
    for p in points:
        assert Decimal(p["inverse"]) == (1 / Decimal(p["rate"])).quantize(Decimal("0.000001"))
    if granularity == "weekly":
        weeks = [date.fromisoformat(p["t"]).isocalendar()[:2] for p in points]
        assert len(weeks) == len(set(weeks))
    assert bool(body["ma200"]) == has_ma
    if has_ma and rng != "max":  # max starts at the first stored row (no MA yet)
        # Computed on the full history, so it starts with the range (no 200-day lag).
        assert body["ma200"][0]["t"] == points[0]["t"]
    rates = [Decimal(p["rate"]) for p in points]
    assert Decimal(body["low"]["rate"]) == min(rates)
    assert Decimal(body["high"]["rate"]) == max(rates)
    change = body["change"]
    assert Decimal(change["start_rate"]) == rates[0]
    assert Decimal(change["end_rate"]) == rates[-1]
    # Trend and percentiles do not depend on the range.
    assert body["trend"] == _get(api_client, "1m")["trend"]
    assert body["trend"]["direction"] in ("dollar_up", "dollar_down", "sideways")
    assert body["trend"]["window_days"] == 21
    pct = body["percentiles"]
    for key in ("since_start", "y5", "y10"):
        assert pct[key] is not None
        assert 0 <= Decimal(pct[key]) <= 1
    assert pct["since_1999"] is None  # the synthetic history starts long after 1999


def test_daily_points_are_settled_and_live_spot_marks_today(
    api_client: TestClient, seeded: None
) -> None:
    today = exchange_today()
    fx_service.set_live_spot(
        "USD", Decimal("1.2345"), observed_on=today, observed_at=datetime.now(UTC)
    )
    body = _get(api_client, "1m")
    if fx_service.active_live_spot("USD") is None:
        pytest.skip("spot-FX market closed right now: no live point")
    last = body["points"][-1]
    assert last["t"] == today.isoformat()
    assert last["rate"] == "1.2345"
    assert "T" in body["as_of"]
    # Every earlier point is a stored (settled) row.
    with ledger_session_scope() as session:
        settled = fx_service.get_settled_rates(session)
    for p in body["points"][:-1]:
        assert Decimal(p["rate"]) == settled[date.fromisoformat(p["t"])]


def test_markers_from_conversions(api_client: TestClient, seeded: None) -> None:
    body = _get(api_client, "3m")
    (marker,) = body["markers"]
    assert (marker["from_ccy"], marker["to_ccy"]) == ("EUR", "USD")
    assert Decimal(marker["amount_from"]) == 1000
    assert Decimal(marker["rate"]) == Decimal("1.15")
    assert marker["kind"] is None
    assert isinstance(marker["conversion_id"], int)
    assert _get(api_client, "1m")["markers"] == []  # 40 days ago is outside 1m


def test_avg_rate_is_the_overview_lifetime_rate(api_client: TestClient, seeded: None) -> None:
    body = _get(api_client, "1y")
    overview = api_client.get("/api/overview/both").json()
    avg = overview["EUR"]["currency"]["lifetime"]["avg_invest_rate"]
    assert avg is not None
    assert body["avg_rate"]["rate"] == avg
    assert overview["USD"]["currency"]["lifetime"]["avg_invest_rate"] == avg


def test_intraday_ranges_from_samples(
    api_client: TestClient, seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    t = datetime(2026, 11, 17, 14, 30)
    samples = [
        (t, Decimal("1.1600")),
        (t + timedelta(minutes=5), Decimal("1.1700")),
        (t + timedelta(minutes=10), Decimal("1.1500")),
    ]
    monkeypatch.setattr(intraday_snapshots_service, "fx_samples_between", lambda *_a: samples)
    for rng in ("1d", "1w"):
        body = _get(api_client, rng)
        assert body["granularity"] == "intraday"
        assert body["source"] == "live samples"
        assert body["ma200"] == []
        assert body["points"][0]["t"] == "2026-11-17T14:30:00+00:00"
        assert body["low"]["rate"] == "1.1500"
        assert body["high"]["t"] == "2026-11-17T14:35:00+00:00"
        assert body["as_of"] == "2026-11-17T14:40:00+00:00"
        assert body["trend"] is not None


def test_etag_304(api_client: TestClient, seeded: None) -> None:
    first = api_client.get("/api/currency/rate-history?range=5y")
    etag = first.headers["etag"]
    again = api_client.get("/api/currency/rate-history?range=5y", headers={"If-None-Match": etag})
    assert again.status_code == 304
    assert again.content == b""
    other = api_client.get("/api/currency/rate-history?range=1y", headers={"If-None-Match": etag})
    assert other.status_code == 200  # the range is part of the ETag
