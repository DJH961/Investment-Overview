"""live_state + ``GET /api/live``: seq, the latest tick, catch-up points, day reset."""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.api.schemas.stream import TickEvent
from investment_dashboard.services import live_state


@pytest.fixture(autouse=True)
def _clean_state() -> Iterator[None]:
    live_state.reset()
    yield
    live_state.reset()


def _tick(n: int, *, instruments: int = 3) -> dict[str, Any]:
    return {
        "type": "tick",
        "ts": f"2026-03-02T15:{n:02d}:00+00:00",
        "market_state": "open",
        "total_value_eur": "123456.78",
        "total_value_usd": "133333.33",
        "fx_eur_usd": "1.0800",
        "last_update_at": "2026-03-02T15:00:00+00:00",
        "prices_live": True,
        "prices": {
            str(i): {"px": "1234.5678", "ccy": "USD", "prev_close": "1230.1234"}
            for i in range(1, instruments + 1)
        },
        "point": {"t": f"2026-03-02T15:{n:02d}:00+00:00", "EUR": "123456.78", "USD": "133333.33"},
    }


def test_record_tick_stamps_increasing_seq() -> None:
    first, second = _tick(1), _tick(2)
    assert live_state.record_tick(first, day=date(2026, 3, 2)) == 1
    assert live_state.record_tick(second, day=date(2026, 3, 2)) == 2
    assert (first["seq"], second["seq"]) == (1, 2)
    assert TickEvent.model_validate(second).point is not None


def test_live_empty_before_first_tick(api_client: TestClient) -> None:
    body = api_client.get("/api/live").json()
    assert body["seq"] == 0
    assert body["tick"] is None
    assert body["missed_points"] == []


def test_live_returns_missed_points_since(api_client: TestClient) -> None:
    for n in range(1, 5):
        live_state.record_tick(_tick(n), day=date(2026, 3, 2))
    body = api_client.get("/api/live", params={"since": 2}).json()
    assert body["seq"] == 4
    assert body["tick"]["seq"] == 4
    assert [p["t"][11:16] for p in body["missed_points"]] == ["15:03", "15:04"]
    everything = api_client.get("/api/live", params={"since": 0}).json()
    assert len(everything["missed_points"]) == 4
    assert api_client.get("/api/live", params={"since": 4}).json()["missed_points"] == []


def test_buffer_resets_on_new_trading_day() -> None:
    live_state.record_tick(_tick(1), day=date(2026, 3, 2))
    live_state.record_tick(_tick(2), day=date(2026, 3, 2))
    live_state.record_tick(_tick(3), day=date(2026, 3, 3))
    seq, _latest, points = live_state.snapshot(0)
    assert seq == 3  # the counter keeps running
    assert len(points) == 1


def test_buffer_is_capped() -> None:
    for n in range(live_state.MAX_POINTS + 50):
        live_state.record_tick(_tick(n % 60), day=date(2026, 3, 2))
    assert len(live_state.snapshot(0)[2]) == live_state.MAX_POINTS


def test_typical_tick_payload_stays_small() -> None:
    event = _tick(5, instruments=20)
    live_state.record_tick(event, day=date(2026, 3, 2))
    size = len(json.dumps(event, separators=(",", ":")))
    assert size < 5 * 1024
