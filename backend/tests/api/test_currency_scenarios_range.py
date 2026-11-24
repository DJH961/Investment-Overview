"""The scenarios endpoint follows the Currency page's range (7.2.1). Synthetic data only."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from fastapi.testclient import TestClient

from investment_dashboard.readmodels import currency_scenarios as sc

from .test_currency_dollar import _get, seeded  # noqa: F401


def test_range_start_windows() -> None:
    today = date(2026, 11, 20)
    first = date(2023, 3, 1)
    assert sc.range_start("all", today, first) == first
    # All is your investing window only: an empty ledger has none (yesterday's close).
    assert sc.range_start("all", today, None) == date(2026, 11, 20)
    assert sc.range_start("max", today, first) == date(1999, 1, 4)
    # One meaning per range (currency_range): measured from the close it starts from.
    assert sc.range_start("1w", today, first) == date(2026, 11, 13)
    assert sc.range_start("1d", today, first) == date(2026, 11, 19)
    assert sc.range_start("ytd", today, first) == date(2025, 12, 31)
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
    # The start mark is the close the range is measured from (weekend: the Friday).
    assert date.fromisoformat(n["range_start"]["date"]) >= date.fromisoformat(
        narrow["USD"]["range_start"]
    ) - timedelta(days=4)
    # The low/high of a window sit inside the all-time ones.
    assert Decimal(n["historic_low"]["rate_display"]) >= Decimal(w["historic_low"]["rate_display"])
    assert Decimal(n["historic_high"]["rate_display"]) <= Decimal(
        w["historic_high"]["rate_display"]
    )
    # The window includes the close it starts from (a weekend start: the Friday).
    assert date.fromisoformat(n["historic_low"]["date"]) >= date.fromisoformat(
        narrow["USD"]["range_start"]
    ) - timedelta(days=4)


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


def test_usd_view_is_the_investing_perspective(
    api_client: TestClient,
    seeded: None,  # noqa: F811
) -> None:
    body = _get(api_client, "/api/currency/scenarios/both?range=1y")
    usd, eur = body["USD"], body["EUR"]
    assert eur["perspective"] == "value"
    assert eur["invest"] is None
    assert usd["perspective"] == "invest"
    unit = Decimal(usd["invest"]["unit_eur"])
    monthly = Decimal(usd["invest"]["monthly_eur"])
    # The regular amount (the service default here), never a fixed 1,000.
    assert unit == monthly == Decimal(100)
    spot = Decimal(usd["rate_now"]["rate"])
    for row in usd["rows"][::25]:
        rate = Decimal(row["rate"])
        assert Decimal(row["per_unit"]) == unit * rate
        assert Decimal(row["per_monthly"]) == monthly * rate
        assert Decimal(row["unit_change"]) == unit * (rate - spot)
        assert Decimal(row["monthly_change"]) == monthly * (rate - spot)
    today = next(m for m in usd["marks"] if m["key"] == "today")
    assert Decimal(usd["rows"][today["row_index"]]["unit_change"]) == 0
    # A stronger euro buys more: the stress rows rise with the shift.
    stress = usd["stress"]
    assert [Decimal(s["unit_change"]) for s in stress] == sorted(
        Decimal(s["unit_change"]) for s in stress
    )
    assert Decimal(stress[0]["unit_change"]) == unit * spot * Decimal("-0.15")
    # Same richness as the EUR view: one cent tile, break-even, worth at low / high.
    assert {s["key"] for s in usd["stats"]} == {s["key"] for s in eur["stats"]}
    for s in usd["stats"]:
        assert s["currency"] in (None, "USD")
    # The euro value of the holdings stays as the secondary line.
    assert usd["other_ccy"] == "EUR"
    assert usd["value_now_other"] is not None
    assert len({r["other_value"] for r in usd["rows"]}) > 1
    # EUR view rows carry no invest fields.
    assert eur["rows"][0]["per_unit"] is None
