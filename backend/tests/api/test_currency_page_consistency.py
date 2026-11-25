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
        # Money and gap printing opposite signs read "mixed" (and carry the why).
        if head["note"] is not None:
            expected = "mixed"
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


# -- 7.4 journey section (lane C): a synthetic G1 pool stands in for B2's service ------


@pytest.fixture
def journey_g1(monkeypatch: pytest.MonkeyPatch) -> None:
    from investment_dashboard.readmodels import currency_journey
    from readmodels import journey_g1 as g1  # tests/readmodels (rootdir on sys.path)

    monkeypatch.setattr(currency_journey, "load_inputs", lambda *_a, **_k: g1.inputs())


def test_journey_section_needs_no_pool_service(
    api_client: TestClient,
    seeded: None,  # noqa: F811
) -> None:
    both = _get(api_client, "/api/currency/journey")
    assert set(both) == {"eur", "usd"}
    assert len(both["eur"]["stats"]) == 4


def test_journey_bridge_total_is_the_overview_fx_gain(
    api_client: TestClient,
    seeded: None,  # noqa: F811
    journey_g1: None,
) -> None:
    both = _get(api_client, "/api/currency/journey")
    eur, usd = both["eur"], both["usd"]
    lines = sum(D(line["eur"]) for line in eur["bridge"]["lines"])
    assert D(eur["bridge"]["total_eur"]) == lines
    overview = _get(api_client, "/api/overview/both")
    for ccy in ("EUR", "USD"):
        life = overview[ccy]["currency"]["lifetime"]
        assert life["fx_pnl_eur"] == eur["bridge"]["total_eur"]
        assert life["breakeven_rate"] is not None
        assert D(life["your_rate"]) == D(eur["stats"]["your_rate"]["rate"])
        assert D(life["realised_eur"]) == D(eur["back_in_euros"]["realised_eur"])
    assert usd["bridge"] is None
    assert usd["stats"]["invested"]["eur_cost"] is None
    assert usd["stats"]["invested"]["usd"] == eur["stats"]["invested"]["usd"]
    assert api_client.get("/api/currency/journey", headers={"If-None-Match": "x"}).headers["ETag"]


def test_trail_and_preview_endpoints(
    api_client: TestClient,
    seeded: None,  # noqa: F811
    journey_g1: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    trail = _get(api_client, "/api/trail/buy/202")
    assert len(trail["paths"]) == 2
    assert api_client.get("/api/trail/buy/999999").status_code == 404
    assert api_client.get("/api/trail/split/1").status_code == 422
    # Preview CB1 on the ledger before it was saved: the same result as the saved one.
    from investment_dashboard.readmodels import currency_journey
    from investment_dashboard.services import read_cache
    from readmodels import journey_g1 as g1

    monkeypatch.setattr(currency_journey, "load_inputs", lambda *_a, **_k: g1.inputs(back=False))
    read_cache.invalidate()
    body = {
        "withdrawal_id": 206,
        "usd_sent": "280",
        "eur_received": "198",
        "fees_eur": "0",
        "date": "2026-04-10",
    }
    resp = api_client.post("/api/cash-out/preview", json=body)
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["conversion_id"] is None
    assert out["eur"]["realised"] == "38.00"
