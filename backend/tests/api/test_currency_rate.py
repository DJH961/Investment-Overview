"""Tests for ``GET /api/currency/rate-history`` (the Currency page EUR/USD chart, v7.2).

Synthetic ledger (``_seed``) plus a synthetic ~12-year daily rate history; no
network, no real data.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from itertools import pairwise
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


@pytest.fixture(autouse=True)
def _no_forex_network(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Never reach Yahoo/Tiingo: no forex bars unless a test sets some."""
    fx_service.clear_forex_bars_cache()
    monkeypatch.setattr(fx_service, "eur_usd_forex_bars", lambda *_a, **_k: {})
    yield
    fx_service.clear_forex_bars_cache()


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
        ("all", "daily", True),
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


def _rm_intraday(range_key: str, now: datetime) -> dict[str, Any]:
    with ledger_session_scope() as session:
        return rate_rm.build_rate_history(session, range_key, avg_invest_rate=None, now=now)


def test_1w_weekend_merges_bars_and_stored_samples_and_squeezes_weekend(
    api_db: object, seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Saturday 2026-11-21 12:00 UTC: forex is shut, the week ended Friday 17:00 ET.
    now = datetime(2026, 11, 21, 12, 0, tzinfo=UTC)
    night = datetime(2026, 11, 19, 2, 0)  # Thursday night, outside US hours
    stored = datetime(2026, 11, 20, 15, 7)
    monkeypatch.setattr(
        fx_service,
        "eur_usd_forex_bars",
        lambda *_a, **_k: {
            night: Decimal("1.1600"),
            night + timedelta(minutes=15): Decimal("1.1610"),
        },
    )
    monkeypatch.setattr(
        intraday_snapshots_service,
        "fx_samples_between",
        lambda *_a: [(stored, Decimal("1.1700")), (night, Decimal("9.9999"))],
    )
    body = _rm_intraday("1w", now)
    times = [p["t"] for p in body["points"]]
    assert times == sorted(times)
    assert "2026-11-19T02:00:00+00:00" in times  # the night the samples never had
    assert "2026-11-20T15:07:00+00:00" in times
    assert body["points"][times.index("2026-11-19T02:00:00+00:00")]["rate"] == "1.1600"  # bars win
    sessions = body["sessions"]
    assert len(sessions) == 5
    # Contiguous forex days, Sunday 17:00 ET open to Friday 17:00 ET close.
    assert sessions[-1]["close"] == "2026-11-20T22:00:00+00:00"
    assert sessions[0]["open"] == "2026-11-15T22:00:00+00:00"
    for prev, nxt in pairwise(sessions):
        assert prev["close"] == nxt["open"]


def test_1d_on_weekend_shows_fridays_forex_day(
    api_db: object, seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    now = datetime(2026, 11, 22, 9, 0, tzinfo=UTC)  # Sunday morning
    overnight = datetime(2026, 11, 20, 3, 0)
    friday_late = datetime(2026, 11, 20, 21, 45)
    monkeypatch.setattr(
        fx_service,
        "eur_usd_forex_bars",
        lambda *_a, **_k: {overnight: Decimal("1.1500"), friday_late: Decimal("1.1550")},
    )
    monkeypatch.setattr(intraday_snapshots_service, "fx_samples_between", lambda *_a: [])
    body = _rm_intraday("1d", now)
    assert [p["t"] for p in body["points"]] == [
        "2026-11-20T03:00:00+00:00",
        "2026-11-20T21:45:00+00:00",
    ]
    assert body["sessions"] == []


def test_1w_falls_back_to_stored_samples_when_yahoo_fails(
    api_db: object, seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    now = datetime(2026, 11, 18, 18, 0, tzinfo=UTC)
    stored = datetime(2026, 11, 18, 15, 0)
    monkeypatch.setattr(
        intraday_snapshots_service, "fx_samples_between", lambda *_a: [(stored, Decimal("1.1700"))]
    )
    # The real service with a failing downloader and no Tiingo token: soft failure.
    monkeypatch.undo()
    monkeypatch.setattr(
        intraday_snapshots_service, "fx_samples_between", lambda *_a: [(stored, Decimal("1.1700"))]
    )

    def boom(*_a: object, **_k: object) -> dict[datetime, Decimal]:
        raise RuntimeError("yahoo down")

    monkeypatch.setattr(
        "investment_dashboard.adapters.yfinance_client.fetch_eur_usd_intraday_range", boom
    )
    monkeypatch.setattr(fx_service, "intraday_fx_bars_via_tiingo", lambda *_a, **_k: {})
    fx_service.clear_forex_bars_cache()
    body = _rm_intraday("1w", now)
    assert [p["t"] for p in body["points"]] == ["2026-11-18T15:00:00+00:00"]
    assert len(body["sessions"]) == 5


def test_forex_bars_are_cached(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.undo()
    fx_service.clear_forex_bars_cache()
    calls: list[int] = []

    def fetch(_s: date, _e: date) -> dict[datetime, Decimal]:
        calls.append(1)
        return {datetime(2026, 11, 18, 1, 0): Decimal("1.16")}

    day = date(2026, 11, 18)
    assert fx_service.eur_usd_forex_bars(day, day, fetcher=fetch)
    assert fx_service.eur_usd_forex_bars(day, day, fetcher=fetch)
    assert len(calls) == 1
    fx_service.clear_forex_bars_cache()


def test_forex_bars_reuse_follows_the_setting(monkeypatch: pytest.MonkeyPatch) -> None:
    """Settings > Data refresh "Currency chart 1D/1W: reuse rate bars for" sets the window."""
    monkeypatch.undo()
    fx_service.clear_forex_bars_cache()
    ages = {"ttl": 600.0}
    monkeypatch.setattr(fx_service, "forex_bars_ttl_seconds", lambda: ages["ttl"])
    calls: list[int] = []

    def fetch(_s: date, _e: date) -> dict[datetime, Decimal]:
        calls.append(1)
        return {datetime(2026, 11, 18, 1, 0): Decimal("1.16")}

    day = date(2026, 11, 18)
    fx_service.eur_usd_forex_bars(day, day, fetcher=fetch)
    fx_service.eur_usd_forex_bars(day, day, fetcher=fetch)
    assert len(calls) == 1
    ages["ttl"] = 0.0  # set to (effectively) nothing: the next read fetches again
    fx_service.eur_usd_forex_bars(day, day, fetcher=fetch)
    assert len(calls) == 2
    fx_service.clear_forex_bars_cache()


def test_forex_bars_ttl_reads_the_setting(monkeypatch: pytest.MonkeyPatch) -> None:
    from investment_dashboard.services import settings_service

    monkeypatch.setattr(
        settings_service,
        "get_or",
        lambda key, fallback, session=None: (
            120 if key == "fx.chart_bars_max_age_seconds" else fallback
        ),
    )
    assert fx_service.forex_bars_ttl_seconds() == 120.0


def test_all_range_starts_at_first_ledger_day_and_empty_ledger_falls_back(
    api_client: TestClient, seeded: None
) -> None:
    body = _get(api_client, "all")
    assert body["points"][0]["t"] >= "2025-01-02"
    assert body["granularity"] == "daily"
    assert body["ma200"]
    assert rate_rm.range_start("all", date(2026, 11, 22), None) == fx_service.HISTORY_START
    assert rate_rm.range_start("all", date(2026, 11, 22), date(2025, 1, 2)) == date(2025, 1, 2)
