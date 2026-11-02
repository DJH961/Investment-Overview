"""Tests for ``GET /api/graphs/{range}``."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.db import ledger_session_scope
from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.services import intraday_snapshots_service

from ._seed import seed_ledger

DAILY_RANGES = ["1m", "3m", "6m", "ytd", "1y", "all"]


@pytest.fixture
def seeded(api_db: object) -> Iterator[None]:
    with ledger_session_scope() as session:
        seed_ledger(session)
    return


@pytest.fixture
def offline_intraday(monkeypatch: pytest.MonkeyPatch) -> None:
    """Serve fixed intraday samples so no test touches the price feed."""
    samples = [
        (datetime(2026, 10, 30, 14, 30), Decimal("4000"), Decimal("1.2")),
        (datetime(2026, 10, 30, 15, 30), Decimal("4100"), Decimal("1.2")),
        (datetime(2026, 10, 30, 19, 55), Decimal("4200"), Decimal("1.2")),
    ]
    monkeypatch.setattr(
        intraday_snapshots_service, "day_series_with_fx", lambda *_a, **_k: list(samples)
    )
    monkeypatch.setattr(
        intraday_snapshots_service, "week_series_with_fx", lambda *_a, **_k: list(samples)
    )
    monkeypatch.setattr(intraday_snapshots_service, "week_nav_drift_with_fx", lambda *_a, **_k: {})


def test_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.get("/api/graphs/1m").status_code == 401


@pytest.mark.parametrize("range_key", DAILY_RANGES)
def test_daily_ranges(api_client: TestClient, seeded: None, range_key: str) -> None:
    body = api_client.get(f"/api/graphs/{range_key}?ccy=USD&compare=false").json()
    assert body["range"] == range_key
    assert body["ccy"] == "USD"
    assert body["intraday"] is False
    assert body["as_of"] == exchange_today().isoformat()
    assert body["reference"] is None
    assert body["secondary"] is None
    points = body["points"]
    assert points, "the seeded ledger has a priced history"
    dates = [p["t"] for p in points]
    assert dates == sorted(dates)
    assert len(set(dates)) == len(dates)
    assert len(dates[0]) == 10  # a plain date, not a timestamp
    # USD is the booked currency: the latest close is FX-free (15 VTI x 250 + 20 BND x 70).
    assert Decimal(points[-1]["v"]) == Decimal(5150)


def test_eur_line_uses_that_days_rate_and_compare_returns_other_ccy(
    api_client: TestClient, seeded: None
) -> None:
    body = api_client.get("/api/graphs/1m?ccy=EUR&compare=true").json()
    assert body["ccy"] == "EUR"
    secondary = body["secondary"]
    assert secondary["ccy"] == "USD"
    assert [p["t"] for p in secondary["points"]] == [p["t"] for p in body["points"]]
    # Each EUR point is that day's USD value over that day's rate (never one global rate).
    assert Decimal(body["points"][-1]["v"]) < Decimal(secondary["points"][-1]["v"])
    assert body["points"][-1]["v"] != secondary["points"][-1]["v"]


def test_longer_ranges_never_have_fewer_points(api_client: TestClient, seeded: None) -> None:
    sizes = {
        key: len(api_client.get(f"/api/graphs/{key}").json()["points"]) for key in DAILY_RANGES
    }
    assert sizes["1m"] <= sizes["3m"] <= sizes["6m"] <= sizes["1y"] <= sizes["all"]


def test_one_day_is_intraday_with_reference(
    api_client: TestClient, seeded: None, offline_intraday: None
) -> None:
    body = api_client.get("/api/graphs/1d?ccy=USD").json()
    assert body["intraday"] is True
    assert body["points"], "intraday samples plus the live tip"
    assert "T" in body["points"][0]["t"]  # a UTC timestamp, not a date
    assert body["points"][0]["t"].endswith(("Z", "+00:00"))
    assert body["reference"] is not None


def test_one_week_is_intraday(api_client: TestClient, seeded: None, offline_intraday: None) -> None:
    body = api_client.get("/api/graphs/1w?ccy=EUR&compare=true").json()
    assert body["intraday"] is True
    assert body["points"]
    assert body["reference"] is None


def test_one_day_empty_ledger(api_client: TestClient, api_db: object) -> None:
    body = api_client.get("/api/graphs/1d").json()
    assert body["points"] == []


@pytest.mark.parametrize("path", ["/api/graphs/2w", "/api/graphs/1m?ccy=GBP", "/api/graphs/ALL"])
def test_bad_input_is_422(api_client: TestClient, path: str) -> None:
    assert api_client.get(path).status_code == 422


# -- v2 fields -----------------------------------------------------------------


def test_secondary_is_on_by_default_with_shared_start_scale(
    api_client: TestClient, seeded: None
) -> None:
    body = api_client.get("/api/graphs/1m?ccy=EUR").json()
    secondary = body["secondary"]
    assert secondary is not None
    assert secondary["ccy"] == "USD"
    first_primary = Decimal(body["points"][0]["v"])
    first_secondary = Decimal(secondary["points"][0]["v"])
    assert secondary["anchor_t"] == body["points"][0]["t"]
    assert Decimal(secondary["scale"]) == first_secondary / first_primary
    # Each line has its own growth, computed in its own currency.
    assert body["growth"]["mode"] in ("xirr", "simple")
    assert secondary["growth"]["mode"] in ("xirr", "simple")
    assert body["growth"]["pct"] != secondary["growth"]["pct"]


def test_daily_ranges_have_no_sessions_or_coverage(api_client: TestClient, seeded: None) -> None:
    body = api_client.get("/api/graphs/3m").json()
    assert body["sessions"] == []
    assert body["coverage"] is None
    assert body["session_date"] is None
    assert body["direction"] is None
    assert isinstance(body["market_open"], bool)


def test_all_range_growth_is_lifetime_total(api_client: TestClient, seeded: None) -> None:
    body = api_client.get("/api/graphs/all?ccy=USD").json()
    overview = api_client.get("/api/overview?ccy=USD").json()
    assert body["growth"]["mode"] == "total"
    assert Decimal(body["growth"]["pct"]) == Decimal(overview["kpis"]["total_growth_compounded"])


def test_one_day_direction_sessions_and_growth(
    api_client: TestClient, seeded: None, offline_intraday: None
) -> None:
    body = api_client.get("/api/graphs/1d?ccy=USD").json()
    reference = Decimal(body["reference"])
    last = Decimal(body["points"][-1]["v"])
    expected = "up" if last > reference else "down" if last < reference else "flat"
    assert body["direction"] == expected
    assert body["growth"]["mode"] == "reference"
    assert Decimal(body["growth"]["pct"]) == (last - reference) / reference
    assert len(body["sessions"]) == 1
    session = body["sessions"][0]
    assert session["date"] == body["session_date"]
    assert session["open"] < session["close"]
    assert body["coverage"]["total"] == 1


def test_one_week_sessions_are_ordered_trading_days(
    api_client: TestClient, seeded: None, offline_intraday: None
) -> None:
    body = api_client.get("/api/graphs/1w?ccy=EUR").json()
    dates = [s["date"] for s in body["sessions"]]
    assert len(dates) == intraday_snapshots_service.WEEK_SESSIONS
    assert dates == sorted(dates)
    assert dates[-1] == body["session_date"]
    assert body["coverage"]["total"] == len(dates)
    assert body["growth"]["mode"] == "simple"


def test_secondary_alignment_drops_only_unmatched_points() -> None:
    from datetime import date

    from investment_dashboard.readmodels.live_graphs import _align_secondary
    from investment_dashboard.readmodels.queries.overview_query import ValueSeriesPoint as P

    primary = [P(date(2026, 1, d), Decimal(v)) for d, v in ((1, 100), (2, 110), (3, 120))]
    secondary = [P(date(2026, 1, d), Decimal(v)) for d, v in ((4, 1), (2, 132), (3, 150))]
    aligned, scale, anchor = _align_secondary(primary, secondary)
    assert [p.date.day for p in aligned] == [2, 3]
    # The first *shared* point anchors the scale.
    assert anchor == date(2026, 1, 2)
    assert scale == Decimal(132) / Decimal(110)


# -- writes --------------------------------------------------------------------


def test_put_range_round_trip_when_closed(
    api_client: TestClient, api_db: object, monkeypatch: pytest.MonkeyPatch
) -> None:
    from investment_dashboard.readmodels.queries import overview_query

    monkeypatch.setattr(overview_query, "is_us_market_open", lambda *_a, **_k: False)
    resp = api_client.put("/api/graphs/range", json={"range": "6m"})
    assert resp.status_code == 200
    assert resp.json() == {"range": "6m", "default_range": "6m"}
    assert api_client.get("/api/overview").json()["default_range"] == "6m"


def test_put_range_while_market_open_is_session_scoped(
    api_db: object, monkeypatch: pytest.MonkeyPatch
) -> None:
    from investment_dashboard.readmodels import live_graphs

    monday_open = datetime(2026, 10, 26, 15, 0, tzinfo=UTC)  # 11:00 New York
    tuesday_open = datetime(2026, 10, 27, 15, 0, tzinfo=UTC)
    with ledger_session_scope() as session:
        assert live_graphs.default_range(session, now=monday_open) == "1d"
        assert live_graphs.remember_range(session, "1m", now=monday_open) == "1m"
        assert live_graphs.default_range(session, now=monday_open) == "1m"
        # A new session opens on 1D again.
        assert live_graphs.default_range(session, now=tuesday_open) == "1d"


def test_put_range_rejects_unknown_range(api_client: TestClient) -> None:
    assert api_client.put("/api/graphs/range", json={"range": "2w"}).status_code == 422


def test_reload_is_202_then_409_while_running(
    api_client: TestClient, api_db: object, monkeypatch: pytest.MonkeyPatch
) -> None:
    import threading

    from investment_dashboard.api import graphs as graphs_api
    from investment_dashboard.readmodels import live_graphs
    from investment_dashboard.services import live_bus

    release = threading.Event()
    done = threading.Event()
    calls: list[str] = []

    def fake_reload(_session: object, range_key: str, **_k: object) -> int:
        calls.append(range_key)
        release.wait(5)
        return 7

    published: list[dict[str, object]] = []

    def fake_publish(event: dict[str, object]) -> None:
        published.append(event)
        done.set()

    monkeypatch.setattr(live_graphs, "reload_range", fake_reload)
    monkeypatch.setattr(live_bus.bus, "publish", fake_publish)

    first = api_client.post("/api/graphs/1d/reload")
    assert first.status_code == 202
    assert first.json() == {"range": "1d", "status": "started"}
    assert api_client.post("/api/graphs/1w/reload").status_code == 409
    release.set()
    assert done.wait(5)
    assert calls == ["1d"]
    assert published[0]["type"] == "graphs"
    assert published[0]["range"] == "1d"
    assert published[0]["ok"] is True
    assert published[0]["points"] == 7
    assert graphs_api._reload_running is None


def test_reload_rejects_unknown_range(api_client: TestClient) -> None:
    assert api_client.post("/api/graphs/2w/reload").status_code == 422


def test_writes_require_auth(anon_client: TestClient) -> None:
    assert anon_client.post("/api/graphs/1d/reload").status_code == 401
    assert anon_client.put("/api/graphs/range", json={"range": "1d"}).status_code == 401
