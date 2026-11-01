"""Allocations read-model: buckets, drift and saving a target."""

from __future__ import annotations

from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from api._seed import RATE_NOW, seed_ledger
from investment_dashboard.readmodels import allocations
from investment_dashboard.readmodels.queries.overview_query import allocation_treemap
from investment_dashboard.services.positions_service import compute_positions

D = Decimal


def test_buckets_match_the_overview_treemap(session: Session) -> None:
    seed_ledger(session)
    body = allocations.build(session, ccy="EUR")
    treemap = {d.label: d.value_eur for d in allocation_treemap(compute_positions(session))}
    buckets = {b["label"]: D(b["value"]) for b in body["current_by_category"]}
    assert buckets.keys() == treemap.keys()
    for label, value in treemap.items():
        assert buckets[label] == pytest.approx(value, rel=D("1e-9"))
    assert sum(D(b["pct"]) for b in body["current_by_category"]) == pytest.approx(D(1))


def test_usd_values_are_spot_conversions_pct_is_not(session: Session) -> None:
    seed_ledger(session)
    eur = allocations.build(session, ccy="EUR")
    usd = allocations.build(session, ccy="USD")
    assert D(usd["total_value"]) == pytest.approx(D(eur["total_value"]) * RATE_NOW, rel=D("1e-9"))
    assert eur["current_by_category"][0]["pct"] == usd["current_by_category"][0]["pct"]


def test_save_target_normalises_and_flags_no_buy(session: Session) -> None:
    ids = seed_ledger(session)
    saved = allocations.save_target(
        session,
        target_id=None,
        name="mix",
        active=True,
        allow_sell=True,
        display_currency="USD",
        items=[(ids["VTI"], D("1"), False), (ids["BND"], D("3"), True)],
    )
    weights = {i["symbol"]: D(i["weight_pct"]) for i in saved["items"]}
    assert weights == {"VTI": D("0.25"), "BND": D("0.75")}
    assert saved["allow_sell"] is True
    assert saved["display_currency"] == "USD"
    assert {i["symbol"]: i["no_buy"] for i in saved["items"]} == {"VTI": False, "BND": True}


def test_save_target_validation(session: Session) -> None:
    ids = seed_ledger(session)

    def save(**overrides: object) -> dict:  # type: ignore[type-arg]
        kwargs: dict = {  # type: ignore[type-arg]
            "target_id": None,
            "name": "a",
            "active": False,
            "allow_sell": False,
            "display_currency": None,
            "items": [(ids["VTI"], D("1"), False)],
        }
        kwargs.update(overrides)
        return allocations.save_target(session, **kwargs)

    with pytest.raises(allocations.AllocationInputError, match="Name"):
        save(name="  ")
    with pytest.raises(allocations.AllocationInputError, match="Unknown instrument"):
        save(items=[(999, D("1"), False)])
    with pytest.raises(allocations.AllocationInputError, match="negative"):
        save(items=[(ids["VTI"], D("-1"), False)])
    with pytest.raises(allocations.AllocationInputError, match="positive"):
        save(items=[(ids["VTI"], D("0"), False)])
    save()
    with pytest.raises(allocations.AllocationConflictError):
        save()


def test_save_target_with_id_updates_in_place(session: Session) -> None:
    ids = seed_ledger(session)
    first = allocations.save_target(
        session,
        target_id=None,
        name="mix",
        active=True,
        allow_sell=False,
        display_currency=None,
        items=[(ids["VTI"], D("1"), False), (ids["BND"], D("1"), False)],
    )
    second = allocations.save_target(
        session,
        target_id=first["id"],
        name="renamed",
        active=False,
        allow_sell=True,
        display_currency="EUR",
        items=[(ids["VTI"], D("1"), True)],
    )
    assert second["id"] == first["id"]
    assert second["name"] == "renamed"
    assert [i["symbol"] for i in second["items"]] == ["VTI"]
    assert second["items"][0]["no_buy"] is True
    assert len(allocations.serialize_targets(session)) == 1
