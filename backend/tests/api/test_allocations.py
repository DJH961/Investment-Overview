"""Tests for ``/api/allocations`` (GET, PUT, rebalance plan)."""

from __future__ import annotations

from collections.abc import Iterator
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from investment_dashboard.db import ledger_session_scope

from ._seed import RATE_NOW, seed_ledger


@pytest.fixture
def ids(api_db: object) -> Iterator[dict[str, int]]:
    with ledger_session_scope() as session:
        seeded = seed_ledger(session)
    return seeded


def _target(ids: dict[str, int], **overrides: object) -> dict[str, object]:
    body: dict[str, object] = {
        "name": "60/40",
        "active": True,
        "allow_sell": False,
        "items": [
            {"instrument_id": ids["VTI"], "weight_pct": "60"},
            {"instrument_id": ids["BND"], "weight_pct": "40"},
        ],
    }
    body.update(overrides)
    return body


def test_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.get("/api/allocations").status_code == 401
    assert anon_client.put("/api/allocations", json={}).status_code == 401


def test_current_mix_without_target(api_client: TestClient, ids: dict[str, int]) -> None:
    body = api_client.get("/api/allocations?ccy=USD").json()
    assert body["targets"] == []
    assert body["drift"] == []
    assert Decimal(body["total_value"]) == 5150
    by_cat = {b["label"]: b for b in body["current_by_category"]}
    assert Decimal(by_cat["US Stocks"]["value"]) == 3750
    assert Decimal(by_cat["Bonds"]["value"]) == 1400
    assert Decimal(by_cat["US Stocks"]["pct"]) == pytest.approx(Decimal(3750) / 5150)
    eur = api_client.get("/api/allocations?ccy=EUR").json()
    # A value converts at the instant's rate; a percentage does not change.
    assert Decimal(eur["total_value"]) == pytest.approx(
        Decimal(5150) / RATE_NOW, rel=Decimal("1e-9")
    )
    assert eur["current_by_category"][0]["pct"] == body["current_by_category"][0]["pct"]


def test_put_then_get_drift(api_client: TestClient, ids: dict[str, int]) -> None:
    saved = api_client.put("/api/allocations", json=_target(ids))
    assert saved.status_code == 200
    target = saved.json()
    assert target["active"] is True
    assert target["name"] == "60/40"
    assert {i["symbol"]: Decimal(i["weight_pct"]) for i in target["items"]} == {
        "VTI": Decimal("0.6"),
        "BND": Decimal("0.4"),
    }
    body = api_client.get("/api/allocations?ccy=USD").json()
    assert body["active_target_id"] == target["id"]
    drift = {r["label"]: r for r in body["drift"]}
    assert Decimal(drift["VTI"]["current_pct"]) == pytest.approx(Decimal(3750) / 5150)
    assert Decimal(drift["VTI"]["drift_pp"]) == pytest.approx(
        Decimal(3750) / 5150 * 100 - 60, rel=Decimal("1e-9")
    )
    assert Decimal(drift["VTI"]["drift_pp"]) > 0  # over-allocated
    assert Decimal(drift["BND"]["drift_pp"]) < 0
    # Amount to hit target: 60 % of 5150 = 3090 vs 3750 held.
    assert Decimal(drift["VTI"]["delta_value"]) == Decimal(3090) - 3750
    assert body["drift"][0]["label"] == "VTI"  # sorted by |drift|
    # One fund per category here, so the category rows repeat the fund rows.
    by_cat = {r["label"]: r for r in body["drift_by_category"]}
    assert set(by_cat) == {"US Stocks", "Bonds"}
    assert by_cat["US Stocks"]["funds"] == 1
    assert by_cat["US Stocks"]["drift_pp"] == drift["VTI"]["drift_pp"]
    assert Decimal(by_cat["US Stocks"]["delta_value"]) == Decimal(3090) - 3750
    assert Decimal(by_cat["Bonds"]["target_pct"]) == Decimal("0.4")


def test_put_normalises_replaces_and_validates(api_client: TestClient, ids: dict[str, int]) -> None:
    first = api_client.put(
        "/api/allocations",
        json=_target(
            ids,
            items=[
                {"instrument_id": ids["VTI"], "weight_pct": "3"},
                {"instrument_id": ids["BND"], "weight_pct": "1", "no_buy": True},
            ],
        ),
    ).json()
    weights = {i["symbol"]: Decimal(i["weight_pct"]) for i in first["items"]}
    assert weights == {"VTI": Decimal("0.75"), "BND": Decimal("0.25")}
    assert next(i for i in first["items"] if i["symbol"] == "BND")["no_buy"] is True

    replaced = api_client.put(
        "/api/allocations", json=_target(ids, id=first["id"], name="renamed", active=False)
    )
    assert replaced.status_code == 200
    listed = api_client.get("/api/allocations").json()["targets"]
    assert [t["name"] for t in listed] == ["renamed"]

    dup = api_client.put("/api/allocations", json=_target(ids, name="renamed"))
    assert dup.status_code == 409
    assert api_client.put("/api/allocations", json=_target(ids, items=[])).status_code == 422
    unknown = _target(ids, name="x", items=[{"instrument_id": 9999, "weight_pct": "10"}])
    assert api_client.put("/api/allocations", json=unknown).status_code == 422
    assert (
        api_client.put("/api/allocations", json=_target(ids, id=4242, name="y")).status_code == 422
    )
    assert (
        api_client.put("/api/allocations", json=_target(ids, display_currency="GBP")).status_code
        == 422
    )


def test_rebalance_plan(api_client: TestClient, ids: dict[str, int]) -> None:
    api_client.put("/api/allocations", json=_target(ids))
    usd = api_client.get("/api/allocations/rebalance?amount=1200&ccy=USD&fractional=true")
    assert usd.status_code == 200
    plan = usd.json()
    rows = {r["symbol"]: r for r in plan["rows"]}
    adds = [Decimal(r["add_value"]) for r in plan["rows"]]
    assert sum(adds) + Decimal(plan["residual_cash"]) == pytest.approx(Decimal(1200))
    assert all(a >= 0 for a in adds)  # buy-only
    assert Decimal(rows["BND"]["add_value"]) > Decimal(rows["VTI"]["add_value"])

    # The same cash expressed in EUR (1200 USD = 1000 EUR at the spot) gives the same plan.
    eur = api_client.get("/api/allocations/rebalance?amount=1000&ccy=EUR&fractional=true").json()
    eur_rows = {r["symbol"]: r for r in eur["rows"]}
    for sym in ("VTI", "BND"):
        assert Decimal(eur_rows[sym]["add_shares"]) == pytest.approx(
            Decimal(rows[sym]["add_shares"]), rel=Decimal("1e-6")
        )
    assert Decimal(eur_rows["BND"]["add_value"]) * RATE_NOW == pytest.approx(
        Decimal(rows["BND"]["add_value"]), rel=Decimal("1e-6")
    )


def test_target_saves_and_restores_the_calculator_selection(
    api_client: TestClient, ids: dict[str, int]
) -> None:
    """Saving from the calculator keeps which funds get new money (and which do not).

    BND is deselected in its category, ETF-only is on, rebalancing on; reading
    the targets back (and after replacing the target) returns exactly that.
    """
    builder = {
        "mode": "category",
        "etf_only": True,
        "categories": [
            {"name": "US Stocks", "weight": "60", "split": "even", "selected": [ids["VTI"]]},
            {"name": "Bonds", "weight": "40", "split": "value", "selected": []},
        ],
    }
    body = _target(ids, allow_sell=True, builder=builder)
    saved = api_client.put("/api/allocations", json=body)
    assert saved.status_code == 200, saved.text
    assert saved.json()["builder"] == builder
    assert saved.json()["allow_sell"] is True
    back = api_client.get("/api/allocations?ccy=USD").json()
    (target,) = back["targets"]
    assert target["builder"] == builder
    assert target["allow_sell"] is True
    # Replacing the target with a different selection replaces the state too.
    changed = {
        **builder,
        "etf_only": False,
        "categories": [{**builder["categories"][0], "selected": [ids["VTI"], ids["BND"]]}],
    }
    api_client.put("/api/allocations", json=body | {"id": target["id"], "builder": changed})
    (again,) = api_client.get("/api/allocations?ccy=USD").json()["targets"]
    assert again["builder"] == {**changed, "categories": [{**changed["categories"][0]}]}
    # An older target (no state) reads back as null.
    api_client.put("/api/allocations", json=_target(ids, name="plain"))
    plain = next(
        t
        for t in api_client.get("/api/allocations?ccy=USD").json()["targets"]
        if t["name"] == "plain"
    )
    assert plain["builder"] is None


def test_rebalance_errors(api_client: TestClient, ids: dict[str, int]) -> None:
    no_target = api_client.get("/api/allocations/rebalance?amount=100")
    assert no_target.status_code == 422
    api_client.put("/api/allocations", json=_target(ids))
    assert api_client.get("/api/allocations/rebalance").status_code == 422  # amount required
    assert api_client.get("/api/allocations/rebalance?amount=-5").status_code == 422
    assert api_client.get("/api/allocations/rebalance?amount=0").status_code == 422  # buy-only
    assert api_client.get("/api/allocations/rebalance?amount=10&ccy=GBP").status_code == 422


# -- POST /allocations/plan (builder mix) ------------------------------------


def _one_category(ids: dict[str, int]) -> None:
    """Move BND into "US Stocks" so the category holds two funds (3750 + 1400 USD)."""
    from investment_dashboard.repositories import instrument_overrides_repo

    with ledger_session_scope() as session:
        instrument_overrides_repo.set_category(session, ids["BND"], "US Stocks")


def _cat_body(
    ids: dict[str, int], split: str, selected: list[str], **kw: object
) -> dict[str, object]:
    body: dict[str, object] = {
        "amount": "1000",
        "ccy": "USD",
        "fractional": True,
        "mode": "category",
        "category_weights": [
            {
                "name": "US Stocks",
                "weight": "100",
                "split": split,
                "selected": [ids[s] for s in selected],
            }
        ],
    }
    body.update(kw)
    return body


def test_builder_plan_needs_no_saved_target(api_client: TestClient, ids: dict[str, int]) -> None:
    body = {
        "amount": "1200",
        "ccy": "USD",
        "fractional": True,
        "fund_weights": [
            {"instrument_id": ids["VTI"], "weight": "60"},
            {"instrument_id": ids["BND"], "weight": "40"},
        ],
    }
    res = api_client.post("/api/allocations/plan", json=body)
    assert res.status_code == 200, res.text
    plan = res.json()
    assert plan["mode"] == "fund"
    s = plan["summary"]
    assert Decimal(s["cash"]) == 1200
    assert Decimal(s["buying"]) + Decimal(s["leftover"]) == pytest.approx(Decimal(1200))
    assert s["other_ccy"] == "EUR"
    assert Decimal(s["other_cash"]) == pytest.approx(Decimal(1000), rel=Decimal("1e-9"))
    assert Decimal(s["pct_of_wealth"]) == pytest.approx(Decimal(1200) / 5150, rel=Decimal("1e-9"))
    rows = {r["symbol"]: r for r in plan["rows"]}
    assert sum(Decimal(r["after_pct"]) for r in plan["rows"]) == pytest.approx(Decimal(1))
    assert Decimal(rows["BND"]["after_pct"]) > Decimal(rows["BND"]["before_pct"])
    assert {c["name"] for c in plan["categories"]} == {"US Stocks", "Bonds"}
    assert plan["extras"] == []

    # Same cash in EUR -> the same shares, the summary restated at the spot.
    eur = api_client.post(
        "/api/allocations/plan", json=body | {"amount": "1000", "ccy": "EUR"}
    ).json()
    assert eur["summary"]["other_ccy"] == "USD"
    assert Decimal(eur["summary"]["other_cash"]) == pytest.approx(Decimal(1200))
    eur_rows = {r["symbol"]: r for r in eur["rows"]}
    assert Decimal(eur_rows["VTI"]["add_shares"]) == pytest.approx(
        Decimal(rows["VTI"]["add_shares"]), rel=Decimal("1e-6")
    )


def test_builder_plan_category_split(api_client: TestClient, ids: dict[str, int]) -> None:
    _one_category(ids)
    even = api_client.post("/api/allocations/plan", json=_cat_body(ids, "even", ["VTI", "BND"]))
    assert even.status_code == 200, even.text
    tgt = {r["symbol"]: Decimal(r["target_pct"]) for r in even.json()["rows"]}
    assert tgt == {"VTI": pytest.approx(Decimal("0.5")), "BND": pytest.approx(Decimal("0.5"))}

    fair = api_client.post("/api/allocations/plan", json=_cat_body(ids, "value", ["VTI", "BND"]))
    tgt = {r["symbol"]: Decimal(r["target_pct"]) for r in fair.json()["rows"]}
    assert tgt["VTI"] == pytest.approx(Decimal(3750) / 5150, abs=Decimal("0.001"))
    cats = fair.json()["categories"]
    assert [c["name"] for c in cats] == ["US Stocks"]
    assert Decimal(cats[0]["target_pct"]) == pytest.approx(Decimal(1))


def test_builder_plan_held_unticked_extras(api_client: TestClient, ids: dict[str, int]) -> None:
    _one_category(ids)
    plan = api_client.post("/api/allocations/plan", json=_cat_body(ids, "value", ["VTI"])).json()
    assert plan["extras"] == ["BND"]
    rows = {r["symbol"]: r for r in plan["rows"]}
    assert rows["BND"]["held_unticked"] is True
    assert Decimal(rows["BND"]["add_value"]) == 0
    # Rebalancing keeps an un-ticked holding as it is (never sold, never bought).
    sell = api_client.post(
        "/api/allocations/plan", json=_cat_body(ids, "value", ["VTI"], allow_sell=True)
    ).json()
    assert sell["extras"] == ["BND"]
    sell_rows = {r["symbol"]: r for r in sell["rows"]}
    assert Decimal(sell_rows["BND"]["add_value"]) == 0
    assert Decimal(sell_rows["BND"]["add_shares"]) == 0


def test_rebalance_counts_kept_funds_toward_their_category(
    api_client: TestClient, ids: dict[str, int]
) -> None:
    """Regression: a rebalance used to plan over the ticked funds only.

    US Stocks holds VTI (3750) + BND (1400, un-ticked, kept); Intl holds VXUS
    (nothing yet). 50/50 with 1000 cash: the plan total is the whole 6150, so
    US Stocks may hold 3075 of which BND already is 1400 -> VTI sells 2075 and
    VXUS buys 3075. (Ignoring BND gave a 4750 total: VTI -1375, VXUS +2375.)
    """
    from investment_dashboard.repositories import instrument_overrides_repo, instruments_repo

    _one_category(ids)
    with ledger_session_scope() as session:
        vxus = instruments_repo.get_or_create(session, symbol="VXUS", asset_class="etf")
        instrument_overrides_repo.set_category(session, vxus.id, "Intl")
        vxus_id = vxus.id
    body = {
        "amount": "1000",
        "ccy": "USD",
        "fractional": True,
        "allow_sell": True,
        "mode": "category",
        "category_weights": [
            {"name": "US Stocks", "weight": "50", "split": "value", "selected": [ids["VTI"]]},
            {"name": "Intl", "weight": "50", "split": "value", "selected": [vxus_id]},
        ],
    }
    res = api_client.post("/api/allocations/plan", json=body)
    assert res.status_code == 200, res.text
    plan = res.json()
    rows = {r["symbol"]: r for r in plan["rows"]}
    assert plan["extras"] == ["BND"]
    assert Decimal(rows["BND"]["add_value"]) == 0
    assert rows["BND"]["held_unticked"] is True
    assert Decimal(rows["VTI"]["add_value"]) == pytest.approx(Decimal(-2075), abs=Decimal("0.01"))
    assert Decimal(rows["VXUS"]["add_value"]) == pytest.approx(Decimal(3075), abs=Decimal("0.01"))
    # Shares are of the whole portfolio after the plan, and the categories land on target.
    assert sum(Decimal(r["after_pct"]) for r in plan["rows"]) == pytest.approx(Decimal(1))
    cats = {c["name"]: c for c in plan["categories"]}
    assert Decimal(cats["US Stocks"]["after_pct"]) == pytest.approx(
        Decimal("0.5"), abs=Decimal("1e-6")
    )
    assert Decimal(cats["Intl"]["after_pct"]) == pytest.approx(Decimal("0.5"), abs=Decimal("1e-6"))
    s = plan["summary"]
    assert Decimal(s["buying"]) == pytest.approx(Decimal(3075), abs=Decimal("0.01"))
    assert Decimal(s["selling"]) == pytest.approx(Decimal(2075), abs=Decimal("0.01"))
    assert Decimal(s["leftover"]) == pytest.approx(Decimal(0), abs=Decimal("0.01"))


def test_builder_plan_errors(api_client: TestClient, ids: dict[str, int]) -> None:
    post = api_client.post
    assert post("/api/allocations/plan", json={"amount": "100"}).status_code == 422  # no weights
    assert post("/api/allocations/plan", json={"amount": "-1"}).status_code == 422
    zero = {"amount": "0", "fund_weights": [{"instrument_id": ids["VTI"], "weight": "1"}]}
    assert post("/api/allocations/plan", json=zero).status_code == 422  # buy-only needs cash
    assert post("/api/allocations/plan", json=zero | {"allow_sell": True}).status_code == 200
    _one_category(ids)
    unticked = _cat_body(ids, "value", [])
    assert post("/api/allocations/plan", json=unticked).status_code == 422


@settings(
    max_examples=15, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture]
)
@given(
    cash=st.decimals(min_value=0, max_value=100000, places=2, allow_nan=False),
    w=st.integers(min_value=0, max_value=100),
    fractional=st.booleans(),
)
def test_builder_plan_never_overspends(
    api_client: TestClient, ids: dict[str, int], cash: Decimal, w: int, fractional: bool
) -> None:
    body = {
        "amount": str(cash + Decimal("0.01")),
        "ccy": "EUR",
        "fractional": fractional,
        "fund_weights": [
            {"instrument_id": ids["VTI"], "weight": str(w)},
            {"instrument_id": ids["BND"], "weight": str(100 - w)},
        ],
    }
    plan = api_client.post("/api/allocations/plan", json=body).json()
    s = plan["summary"]
    assert Decimal(s["leftover"]) >= 0
    assert Decimal(s["buying"]) <= Decimal(body["amount"]) + Decimal("1e-9")
