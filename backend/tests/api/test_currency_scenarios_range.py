"""The scenarios endpoint follows the Currency page's range (7.2.1). Synthetic data only."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from fastapi.testclient import TestClient

from investment_dashboard.readmodels import currency_scenarios as sc

from .test_currency_dollar import _get, seeded  # noqa: F401


def test_range_start_windows() -> None:
    today = date(2026, 11, 20)
    first = date(2023, 3, 1)
    assert sc.range_start("all", today, first) == first
    assert sc.range_start("all", today, None) == date(1999, 1, 4)
    assert sc.range_start("max", today, first) == date(1999, 1, 4)
    assert sc.range_start("1w", today, first) == date(2026, 11, 13)
    assert sc.range_start("1d", today, first) == date(2026, 11, 19)
    assert sc.range_start("ytd", today, first) == date(2026, 1, 1)
    assert sc.range_start("1y", today, first) == date(2025, 11, 20)


def _marks(side: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {m["key"]: m for m in side["marks"]}


def test_marks_follow_the_range(api_client: TestClient, seeded: None) -> None:  # noqa: F811
    wide = _get(api_client, "/api/currency/scenarios/both?range=max")
    narrow = _get(api_client, "/api/currency/scenarios/both?range=3m")
    assert narrow["USD"]["range"] == "3m"
    assert narrow["USD"]["range_start"] is not None
    w, n = _marks(wide["USD"]), _marks(narrow["USD"])
    assert "range_start" in n
    assert date.fromisoformat(n["range_start"]["date"]) >= date.fromisoformat(
        narrow["USD"]["range_start"]
    )
    # The low/high of a window sit inside the all-time ones.
    assert Decimal(n["historic_low"]["rate_display"]) >= Decimal(w["historic_low"]["rate_display"])
    assert Decimal(n["historic_high"]["rate_display"]) <= Decimal(
        w["historic_high"]["rate_display"]
    )
    assert date.fromisoformat(n["historic_low"]["date"]) >= date.fromisoformat(
        narrow["USD"]["range_start"]
    )


def test_short_range_cushion_says_too_short(api_client: TestClient, seeded: None) -> None:  # noqa: F811
    body = _get(api_client, "/api/currency/scenarios/both?range=1w")
    for ccy in ("EUR", "USD"):
        cushion = body[ccy]["cushion"]
        assert cushion is not None
        assert cushion["too_short"] is True
        assert cushion["volatility_usd"] is None


def test_all_range_starts_at_first_transaction(api_client: TestClient, seeded: None) -> None:  # noqa: F811
    body = _get(api_client, "/api/currency/scenarios/both?range=all")
    assert body["USD"]["range"] == "all"
    cushion = body["USD"]["cushion"]
    assert cushion is not None
    assert cushion["since"] >= body["USD"]["range_start"]


def test_all_dollar_book_is_not_exposed_in_the_dollar_view(
    api_client: TestClient,
    seeded: None,  # noqa: F811
) -> None:
    body = _get(api_client, "/api/currency/scenarios/both?range=1y")
    usd, eur = body["USD"], body["EUR"]
    assert usd["exposed"] is False
    assert eur["exposed"] is True
    assert usd["other_ccy"] == "EUR"
    # Dollars never move with the rate; the euro value does.
    assert len({r["value"] for r in usd["rows"]}) == 1
    assert len({r["other_value"] for r in usd["rows"]}) > 1
    assert usd["sensitivity"] is None
    assert {s["key"] for s in usd["stats"]} <= {"breakeven", "value_at_low", "value_at_high"}
    for s in usd["stats"]:
        if s["key"].startswith("value_at"):
            assert s["currency"] == "EUR"
    assert all(s["currency"] == "EUR" for s in eur["stats"] if s["key"].startswith("value_at"))
