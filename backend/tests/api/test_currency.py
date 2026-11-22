"""Tests for ``GET /api/currency/both`` (the Currency page, v7.0)."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.db import ledger_session_scope
from investment_dashboard.readmodels import currency as currency_rm
from investment_dashboard.services import intraday_snapshots_service

from ._seed import seed_ledger


@pytest.fixture
def seeded(api_db: object) -> Iterator[None]:
    with ledger_session_scope() as session:
        seed_ledger(session)
    return


def D(value: str | None) -> Decimal:
    assert value is not None
    return Decimal(value)


def test_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.get("/api/currency/both").status_code == 401


def test_both_sides_and_overview_identity(api_client: TestClient, seeded: None) -> None:
    resp = api_client.get("/api/currency/both")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    overview = api_client.get("/api/overview/both").json()
    for ccy in ("EUR", "USD"):
        side = body[ccy]
        assert side["ccy"] == ccy
        block = overview[ccy]["currency"]
        assert side["today"] == block["today"]
        assert side["lifetime"] == block["lifetime"]
        assert side["return_split"] == block["return_split"]


def test_return_split_gap_is_same_in_both_views(api_client: TestClient, seeded: None) -> None:
    overview = api_client.get("/api/overview/both").json()
    usd = overview["USD"]["currency"]["return_split"]
    eur = overview["EUR"]["currency"]["return_split"]
    assert D(usd["currency_effect_pp"]) == 0
    assert usd["eur_minus_usd_pp"] == eur["currency_effect_pp"]
    assert eur["eur_minus_usd_pp"] == eur["currency_effect_pp"]


def test_freshness_clock_fields(api_client: TestClient, seeded: None) -> None:
    fresh = api_client.get("/api/overview/both").json()["EUR"]["freshness"]
    opens = datetime.fromisoformat(fresh["next_open_at"])
    closes = datetime.fromisoformat(fresh["next_close_at"])
    assert opens.tzinfo is not None
    assert closes > datetime.now(UTC)
    assert opens > datetime.now(UTC)


def test_etag_304(api_client: TestClient, seeded: None) -> None:
    first = api_client.get("/api/currency/both")
    etag = first.headers["etag"]
    again = api_client.get("/api/currency/both", headers={"If-None-Match": etag})
    assert again.status_code == 304
    assert again.content == b""


def test_stats_have_values_and_side_specific_tiles(api_client: TestClient, seeded: None) -> None:
    body = api_client.get("/api/currency/both").json()
    for ccy in ("EUR", "USD"):
        for tile in body[ccy]["stats"]:
            assert tile["value"] is not None
    keys_usd = {t["key"] for t in body["USD"]["stats"]}
    # The USD view reads the investing side: dollars per EUR 1,000 today, and what
    # the rate did to the euros sent in this year and since the start (as Impact).
    tiles = {
        t["key"]: t
        for t in body["USD"]["stats"]
        if t["key"] in {"effect_today", "effect_this_year", "effect_lifetime"}
    }
    assert {"effect_this_year", "effect_lifetime"} <= set(tiles)
    for t in tiles.values():
        assert t["unit"] == "money"
        assert t["currency"] == "USD"
        assert t["kind"] == currency_rm._kind(D(t["value"]))
    impact = api_client.get("/api/currency/effect/both?range=all").json()
    inv = impact["USD"]["investing"]
    assert D(tiles["effect_lifetime"]["value"]) == D(inv["effect"])
    gap = D(impact["USD"]["headline"]["effect_pp"])
    assert abs(D(tiles["effect_lifetime"]["secondary"]) - gap) < Decimal("1e-8")
    keys_eur = {t["key"] for t in body["EUR"]["stats"]}
    assert "investing_power_today" not in keys_eur
    assert "rate_now" in keys_eur
    assert "one_cent" in keys_eur
    assert "one_cent" in keys_usd


def test_one_cent_native_legs(api_client: TestClient, seeded: None) -> None:
    body = api_client.get("/api/currency/both").json()
    usd = body["USD"]["one_cent"]
    eur = body["EUR"]["one_cent"]
    assert usd is not None
    assert eur is not None
    assert D(usd["value_at_rate_plus"]) - D(usd["value_at_rate"]) == D(usd["change"])
    assert D(usd["change"]) == 0  # an all-USD book: dollars do not move with the rate
    assert D(eur["change"]) < 0  # a stronger euro makes the dollar book worth fewer euros
    assert usd["rate"] == eur["rate"]
    tile = next(t for t in body["EUR"]["stats"] if t["key"] == "one_cent")
    assert tile["currency"] == "EUR"
    assert tile["value"] == eur["change"]


def test_buys_same_on_both_sides(api_client: TestClient, seeded: None) -> None:
    body = api_client.get("/api/currency/both").json()
    assert body["EUR"]["buys"] == body["USD"]["buys"]
    buys = body["EUR"]["buys"]
    # The owner's investing-power amount (default EUR 100), as the Overview card uses.
    assert D(buys["amount_eur"]) == 100
    assert D(buys["usd_now"]) == 100 * D(body["EUR"]["today"]["spot"])


def test_buys_use_the_owner_amount(api_client: TestClient, seeded: None) -> None:
    from investment_dashboard.db import ledger_session_scope
    from investment_dashboard.services import investing_power_service

    with ledger_session_scope() as session:
        investing_power_service.set_amount_eur(session, Decimal("250"))
    from investment_dashboard.services import read_cache

    read_cache.invalidate()
    body = api_client.get("/api/currency/both").json()
    buys = body["USD"]["buys"]
    assert D(buys["amount_eur"]) == 250
    assert D(buys["usd_now"]) == 250 * D(body["USD"]["today"]["spot"])
    power = body["USD"]["today"]["investing_power_usd"]
    if power is not None:
        assert D(power["amount_eur"]) == 250


def _fake_series(*_a: Any, **_k: Any) -> list[tuple[datetime, Decimal, Decimal | None]]:
    t = datetime(2026, 11, 17, 14, 30)
    return [
        (t, Decimal(1), None),
        (t.replace(minute=31), Decimal(1), Decimal("1.1600")),
        (t.replace(minute=32), Decimal(1), Decimal("1.1700")),
        (t.replace(minute=33), Decimal(1), Decimal("1.1500")),
        (t.replace(minute=34), Decimal(1), Decimal(0)),
    ]


def test_rate_range_from_stored_samples(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(intraday_snapshots_service, "day_series_with_fx", _fake_series)
    now = datetime(2026, 11, 17, 16, 0, tzinfo=UTC)
    usd = currency_rm._rate_range(None, now=now, quote_usd_per_eur=True)  # type: ignore[arg-type]
    eur = currency_rm._rate_range(None, now=now, quote_usd_per_eur=False)  # type: ignore[arg-type]
    assert usd is not None
    assert eur is not None
    assert (D(usd["low"]), D(usd["high"])) == (Decimal("1.15"), Decimal("1.17"))
    assert (usd["low_display"], usd["high_display"]) == (usd["low"], usd["high"])
    assert D(eur["low_display"]) == 1 / Decimal("1.17")
    assert D(eur["high_display"]) == 1 / Decimal("1.15")
    assert usd["samples"] == 3
    assert usd["session_date"] == "2026-11-17"
    assert usd["first_at"].startswith("2026-11-17T14:31")
    assert usd["first_at"].endswith("+00:00")
    assert usd["last_at"].startswith("2026-11-17T14:33")


def test_rate_range_none_without_rates(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        intraday_snapshots_service,
        "day_series_with_fx",
        lambda *_a, **_k: [(datetime(2026, 11, 17, 14, 30), Decimal(1), None)],
    )
    assert currency_rm._rate_range(None, now=datetime.now(UTC), quote_usd_per_eur=True) is None  # type: ignore[arg-type]
