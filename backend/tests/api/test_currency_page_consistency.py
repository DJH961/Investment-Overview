"""7.3.1 consistency matrix: one range means the same days in every Currency section.

For each page range, every Currency endpoint reports the same window; All never
quotes a day before the first transaction and Max reaches back further. In the EUR
view the headline effect, its kind and the bridge's currency lines agree; the USD
view labels the euro lens instead of contradicting it. Synthetic seeded ledger.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.readmodels import currency_range

from .test_currency_dollar import _get, seeded  # noqa: F401

D = Decimal
RANGES = ["1d", "1w", "1m", "3m", "ytd", "1y", "all", "5y", "10y", "max"]


def _windows(client: TestClient, rng: str) -> dict[str, dict[str, Any]]:
    rate = _get(client, f"/api/currency/rate-history?range={rng}")
    dollar = _get(client, f"/api/currency/dollar/both?range={rng}")
    scen = _get(client, f"/api/currency/scenarios/both?range={rng}")
    effect = _get(client, f"/api/currency/effect/both?range={rng}")
    costs = _get(client, f"/api/fx-conversions/costs?range={rng}")
    out = {"rate": rate["window"]}
    for ccy in ("EUR", "USD"):
        out[f"dollar.{ccy}"] = dollar[ccy]["window"]
        out[f"scenarios.{ccy}"] = scen[ccy]["window"]
        out[f"effect.{ccy}"] = effect[ccy]["window"]
        out[f"costs.{ccy}"] = costs[ccy]["window"]
    return out


@pytest.mark.parametrize("rng", RANGES)
def test_every_section_reports_the_same_window(
    api_client: TestClient,
    seeded: None,  # noqa: F811
    rng: str,
) -> None:
    windows = _windows(api_client, rng)
    first = next(iter(windows.values()))
    for name, w in windows.items():
        assert w == first, name
    assert first["key"] == rng
    assert first["intraday"] is (rng in currency_range.INTRADAY_RANGES)


def test_all_and_max_differ_and_all_stays_in_your_window(
    api_client: TestClient,
    seeded: None,  # noqa: F811
) -> None:
    all_w = _windows(api_client, "all")["rate"]
    max_w = _windows(api_client, "max")["rate"]
    assert date.fromisoformat(max_w["start"]) < date.fromisoformat(all_w["start"])
    assert all_w["context_until"] is None
    assert max_w["context_until"] is not None
    start = date.fromisoformat(all_w["start"])
    rate = _get(api_client, "/api/currency/rate-history?range=all")
    assert all(date.fromisoformat(p["t"][:10]) >= start for p in rate["points"])
    dollar = _get(api_client, "/api/currency/dollar/both?range=all")
    for series in dollar["EUR"]["rolling"]:
        assert all(date.fromisoformat(p["t"][:10]) >= start for p in series["points"])


@pytest.mark.parametrize("rng", RANGES)
def test_eur_headline_sign_kind_and_bridge_agree(
    api_client: TestClient,
    seeded: None,  # noqa: F811
    rng: str,
) -> None:
    eur = _get(api_client, f"/api/currency/effect/both?range={rng}")["EUR"]
    head = eur["headline"]
    if head["lead"] == "effect":
        effect = D(head["effect"])
        expected = "tailwind" if effect > 0 else "headwind" if effect < 0 else "neutral"
        assert head["kind"] == expected
    b = eur["bridge"]
    if b is not None:
        assert D(b["revaluation"]) + D(b["waiting"]) + D(b["conversion_cost"]) == D(b["currency"])
        assert abs(D(b["currency"]) - D(head["effect"])) < D("0.000002")


@pytest.mark.parametrize("rng", ["1d", "ytd", "all"])
def test_usd_view_labels_the_other_lens(
    api_client: TestClient,
    seeded: None,  # noqa: F811
    rng: str,
) -> None:
    usd = _get(api_client, f"/api/currency/effect/both?range={rng}")["USD"]
    head = usd["headline"]
    if head["lead"] == "deposits":
        assert head["lens_note"]
        if head["effect_pp"] is not None:
            assert head["other_lens"]["label"] == "Seen from euros"
            assert D(head["other_lens"]["value"]) == D(head["effect_pp"])
