"""Cross-range graph contract: every range agrees with the others and the hero total.

On the seeded ledger (``_seed.py``): each range's last point equals the Overview
``kpis.total_value`` in the same currency; the 1W curve's last session is the 1D
curve; the 1D growth equals the headline daily move; the secondary line's
start ratio is its ``scale``; a non-trading "today" is never appended.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import date, datetime
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.db import ledger_session_scope
from investment_dashboard.domain.market_hours import exchange_today, is_trading_day
from investment_dashboard.services import intraday_snapshots_service

from ._seed import seed_ledger

ALL_RANGES = ["1d", "1w", "1m", "3m", "6m", "ytd", "1y", "all"]
DAILY_RANGES = ["1m", "3m", "6m", "ytd", "1y", "all"]
CCYS = ["EUR", "USD"]


@pytest.fixture
def seeded(api_db: object) -> Iterator[None]:
    with ledger_session_scope() as session:
        seed_ledger(session)
    return


@pytest.fixture
def offline_intraday(monkeypatch: pytest.MonkeyPatch) -> None:
    """No price feed: the intraday curves are the cache (empty) plus the live tip."""
    monkeypatch.setattr(intraday_snapshots_service, "day_series_with_fx", lambda *_a, **_k: [])
    monkeypatch.setattr(intraday_snapshots_service, "week_series_with_fx", lambda *_a, **_k: [])
    monkeypatch.setattr(intraday_snapshots_service, "week_nav_drift_with_fx", lambda *_a, **_k: {})


def _graph(client: TestClient, key: str, ccy: str) -> dict[str, object]:
    resp = client.get(f"/api/graphs/{key}?ccy={ccy}")
    assert resp.status_code == 200
    return resp.json()  # type: ignore[no-any-return]


def _last(body: dict[str, object]) -> Decimal:
    points = body["points"]
    assert isinstance(points, list)
    assert points, f"{body['range']} has points"
    return Decimal(points[-1]["v"])


@pytest.mark.parametrize("ccy", CCYS)
def test_daily_ranges_end_at_the_hero_total(api_client: TestClient, seeded: None, ccy: str) -> None:
    total = Decimal(api_client.get(f"/api/overview?ccy={ccy}").json()["kpis"]["total_value"])
    today = exchange_today()
    for key in DAILY_RANGES:
        body = _graph(api_client, key, ccy)
        last_t = date.fromisoformat(body["points"][-1]["t"])  # type: ignore[index]
        # A non-trading "today" is never appended (the curve ends at the last session).
        assert is_trading_day(last_t), key
        if is_trading_day(today):
            assert last_t == today, key
            assert _last(body) == pytest.approx(total, rel=Decimal("1e-9")), key


@pytest.mark.parametrize("ccy", CCYS)
def test_daily_ranges_agree_on_shared_dates(api_client: TestClient, seeded: None, ccy: str) -> None:
    curves = {
        key: {p["t"]: p["v"] for p in _graph(api_client, key, ccy)["points"]}  # type: ignore[attr-defined]
        for key in DAILY_RANGES
    }
    reference = curves["all"]
    for key, curve in curves.items():
        for t, v in curve.items():
            assert reference.get(t) == v, (key, t)


@pytest.mark.parametrize("ccy", CCYS)
def test_intraday_ranges_end_at_the_hero_total(
    api_client: TestClient, seeded: None, offline_intraday: None, ccy: str
) -> None:
    total = Decimal(api_client.get(f"/api/overview?ccy={ccy}").json()["kpis"]["total_value"])
    day, week = _graph(api_client, "1d", ccy), _graph(api_client, "1w", ccy)
    if not day["points"]:
        pytest.skip("no live tip without a priced book")
    # The live tip is the hero figure. After the close the EUR tip is frozen at
    # the session-close FX by design (the 1D market-day trajectory must not slide
    # with overnight FX), so off-hours only the FX-free USD line must match.
    if ccy == "USD" or day["market_open"]:
        assert _last(day) == pytest.approx(total, rel=Decimal("1e-9"))
    if week["intraday"]:
        assert _last(week) == _last(day)


@pytest.mark.parametrize("ccy", CCYS)
def test_week_last_session_is_the_day_curve(
    api_client: TestClient, seeded: None, monkeypatch: pytest.MonkeyPatch, ccy: str
) -> None:
    session_date = intraday_snapshots_service.last_session_date()
    start = datetime.combine(session_date, datetime.min.time()).replace(hour=14, minute=30)
    samples = [
        (start, Decimal("4000"), Decimal("1.2")),
        (start.replace(hour=16), Decimal("4100"), Decimal("1.2")),
        (start.replace(hour=19, minute=55), Decimal("4200"), Decimal("1.2")),
    ]
    monkeypatch.setattr(
        intraday_snapshots_service, "day_series_with_fx", lambda *_a, **_k: list(samples)
    )
    monkeypatch.setattr(
        intraday_snapshots_service, "week_series_with_fx", lambda *_a, **_k: list(samples)
    )
    monkeypatch.setattr(intraday_snapshots_service, "week_nav_drift_with_fx", lambda *_a, **_k: {})
    day, week = _graph(api_client, "1d", ccy), _graph(api_client, "1w", ccy)
    assert day["session_date"] == week["session_date"] == session_date.isoformat()
    day_points = [(p["t"], p["v"]) for p in day["points"]]  # type: ignore[attr-defined]
    tail = [(p["t"], p["v"]) for p in week["points"]][-len(day_points) :]  # type: ignore[attr-defined]
    assert tail == day_points


def test_one_day_growth_is_the_headline_daily_move(
    api_client: TestClient, seeded: None, offline_intraday: None
) -> None:
    # USD: the FX-free line, so the live tip and the settled close coincide.
    body = _graph(api_client, "1d", "USD")
    if not body["points"] or body["growth"] is None:
        pytest.skip("no live tip / reference")
    kpis = api_client.get("/api/overview?ccy=USD").json()["kpis"]
    if kpis["daily_growth_pct"] is None:
        pytest.skip("no daily move yet")
    growth = Decimal(body["growth"]["pct"])  # type: ignore[index]
    assert growth == pytest.approx(Decimal(kpis["daily_growth_pct"]), abs=Decimal("1e-9"))


@pytest.mark.parametrize("ccy", CCYS)
@pytest.mark.parametrize("key", DAILY_RANGES)
def test_secondary_start_ratio_is_scale(
    api_client: TestClient, seeded: None, key: str, ccy: str
) -> None:
    body = _graph(api_client, key, ccy)
    secondary = body["secondary"]
    assert isinstance(secondary, dict)
    primary = {p["t"]: Decimal(p["v"]) for p in body["points"]}  # type: ignore[attr-defined]
    first = secondary["points"][0]
    assert secondary["anchor_t"] == first["t"]
    assert Decimal(secondary["scale"]) == Decimal(first["v"]) / primary[first["t"]]
    # Every secondary point sits on a primary timestamp (alignment).
    assert all(p["t"] in primary for p in secondary["points"])


@pytest.mark.parametrize("key", ALL_RANGES)
def test_each_currency_growth_is_its_own(
    api_client: TestClient, seeded: None, offline_intraday: None, key: str
) -> None:
    eur, usd = _graph(api_client, key, "EUR"), _graph(api_client, key, "USD")
    if eur["growth"] is None or usd["growth"] is None:
        return
    # The EUR response's secondary growth is the USD response's own growth.
    assert eur["secondary"]["growth"] == usd["growth"]  # type: ignore[index]
    assert usd["secondary"]["growth"] == eur["growth"]  # type: ignore[index]


@pytest.mark.parametrize("ccy", CCYS)
def test_weekend_now_ends_at_fridays_close(seeded: None, ccy: str) -> None:
    from datetime import UTC, timedelta

    from investment_dashboard.readmodels import live_graphs

    today = exchange_today()
    saturday = today - timedelta(days=(today.weekday() - 5) % 7)  # latest Saturday <= today
    now = datetime.combine(saturday, datetime.min.time(), tzinfo=UTC).replace(hour=15)
    with ledger_session_scope() as session:
        body = live_graphs.build_graph(session, range_key="1m", ccy=ccy, now=now)
    assert body["as_of"] == saturday.isoformat()
    last_t = date.fromisoformat(body["points"][-1]["t"])
    assert last_t < saturday
    assert is_trading_day(last_t)
    assert body["market_open"] is False
