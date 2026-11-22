"""Tests for ``GET /api/currency/effect/both`` (Currency page, Impact section, v7.2).

Synthetic ledger (``_seed``) plus a synthetic daily rate history; no network, no
real data.
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

from ._seed import FIRST_DAY, seed_ledger


def _history(today: date, existing: set[date]) -> dict[date, Decimal]:
    """Weekdays from just before the first trade: a zig-zag between 1.05 and 1.25."""
    out: dict[date, Decimal] = {}
    day = FIRST_DAY - timedelta(days=400)
    i = 0
    while day < today:
        if day.weekday() < 5 and day not in existing:
            phase = i % 80
            step = phase if phase < 40 else 80 - phase
            out[day] = Decimal("1.05") + Decimal(step) / 200
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


def _get(client: TestClient, rng: str) -> dict[str, Any]:
    resp = client.get(f"/api/currency/effect/both?range={rng}")
    assert resp.status_code == 200, resp.text
    return resp.json()


def D(value: str | None) -> Decimal:
    assert value is not None
    return Decimal(value)


def test_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.get("/api/currency/effect/both?range=ytd").status_code == 401


def test_unknown_range_is_rejected(api_client: TestClient, seeded: None) -> None:
    assert api_client.get("/api/currency/effect/both?range=2y").status_code == 422


def test_all_range_uses_the_overview_lifetime_returns(api_client: TestClient, seeded: None) -> None:
    body = _get(api_client, "all")
    overview = api_client.get("/api/overview/both").json()
    eur_life = D(overview["EUR"]["kpis"]["total_growth_compounded"])
    usd_life = D(overview["USD"]["kpis"]["total_growth_compounded"])
    for ccy in ("EUR", "USD"):
        head = body[ccy]["headline"]
        assert head["return_basis"] == "lifetime"
        assert abs(D(head["eur_return"]) - eur_life) < Decimal("1e-8")
        assert abs(D(head["usd_return"]) - usd_life) < Decimal("1e-8")
        assert abs(D(head["effect_pp"]) - (eur_life - usd_life)) < Decimal("2e-8")


@pytest.mark.parametrize("rng", ["1y", "all"])
def test_views_lead_with_what_answers_them(api_client: TestClient, seeded: None, rng: str) -> None:
    """EUR: the money effect leads, the tag follows it. USD of an all-dollar book: the
    gap leads, the tag follows the gap, the euros beside it are the EUR side's own."""
    body = _get(api_client, rng)
    eur, usd = body["EUR"]["headline"], body["USD"]["headline"]
    assert eur["lead"] == "effect"
    effect = D(eur["effect"])
    assert eur["kind"] == ("tailwind" if effect > 0 else "headwind" if effect < 0 else "neutral")
    assert usd["lead"] == "gap"
    assert D(usd["effect"]) == 0
    gap = D(usd["effect_pp"])
    assert usd["kind"] == ("tailwind" if gap > 0 else "headwind" if gap < 0 else "neutral")
    assert usd["other_ccy"] == "EUR"
    assert usd["other_effect"] == eur["effect"]
    # Nothing moved in dollars: no month, record or rolling figures of zeros.
    side = body["USD"]
    assert side["months"] == []
    assert side["grid"] == []
    assert side["rolling"] == []
    assert side["records"]["best_day"] is None
    assert side["records"]["lifetime_months_of_contributions"] is None
    assert {s["key"] for s in side["stats"]} <= {"eur_return", "usd_return", "effect_pp", "effect"}


@pytest.mark.parametrize(
    "rng", ["1d", "1w", "1m", "3m", "ytd", "1y", "3y", "5y", "10y", "all", "2025"]
)
def test_every_range_answers_both_sides(api_client: TestClient, seeded: None, rng: str) -> None:
    body = _get(api_client, rng)
    for ccy in ("EUR", "USD"):
        side = body[ccy]
        assert side["ccy"] == ccy
        assert side["range"] == rng
        bridge = side["bridge"]
        if bridge is not None:
            total = D(bridge["start"]) + D(bridge["deposits"]) + D(bridge["market"])
            assert total + D(bridge["currency"]) == D(bridge["end"])
        split = side["session_split"]
        if split is not None:
            assert D(split["inside"]) + D(split["outside"]) == D(split["covered_currency"])


def test_etag_round_trip(api_client: TestClient, seeded: None) -> None:
    first = api_client.get("/api/currency/effect/both?range=all")
    assert first.status_code == 200
    etag = first.headers["etag"]
    again = api_client.get("/api/currency/effect/both?range=all", headers={"If-None-Match": etag})
    assert again.status_code == 304


def test_all_range_has_explainer_and_lifetime_record(api_client: TestClient, seeded: None) -> None:
    body = _get(api_client, "all")
    eur = body["EUR"]
    assert eur["explainer"]
    assert "average buy rate" in eur["explainer"]
    assert eur["bridge"] is not None
    assert D(eur["records"]["lifetime_effect"]) == D(eur["bridge"]["currency"])
    # The months add up to the range's currency effect (to the rounding of each bar).
    months = sum((D(m["currency"]) for m in eur["months"]), Decimal(0))
    assert abs(months - D(eur["headline"]["effect"])) <= Decimal("0.00001") * len(eur["months"])


def test_strip_tiles_present(api_client: TestClient, seeded: None) -> None:
    body = api_client.get("/api/currency/both").json()
    eur_keys = {s["key"] for s in body["EUR"]["stats"]}
    assert {"effect_this_year", "effect_lifetime"} <= eur_keys
    effect = _get(api_client, "all")
    tile = next(s for s in body["EUR"]["stats"] if s["key"] == "effect_lifetime")
    assert D(tile["value"]) == D(effect["EUR"]["records"]["lifetime_effect"])
    # The 7.0 tile keeps its meaning (the Overview card's average-buy-rate figure).
    old = next(s for s in body["EUR"]["stats"] if s["key"] == "lifetime_effect")
    assert old["value"] == body["EUR"]["lifetime"]["fx_pnl_eur"]


def test_today_equals_day_split(api_client: TestClient, seeded: None) -> None:
    body = _get(api_client, "1d")
    overview = api_client.get("/api/overview/both").json()
    for ccy in ("EUR", "USD"):
        split = overview[ccy].get("day_split")
        if split is None:
            continue
        assert D(body[ccy]["headline"]["effect"]) == D(split["currency_move"]).quantize(
            Decimal("0.000001")
        )
