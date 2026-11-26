# ruff: noqa: PT018
"""A conversion back to EUR (7.4) never leaks into the EUR -> USD figures.

One synthetic ledger with an EUR -> USD conversion and a USD -> EUR one; each
consumer of the conversion rows is checked against the same ledger without the
conversion back. The back row's own cost follows ``fx_spread`` in its direction
(the G1 cash-out CB1: $280 -> EUR 198 at ECB 1.40, so EUR 2 of cost).
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.domain import fx_spread
from investment_dashboard.models import Account, Transaction
from investment_dashboard.readmodels import currency_deposits, deposits
from investment_dashboard.repositories import fx_repo
from investment_dashboard.services import (
    diagnostics_service,
    fx_conversion_service,
    fx_cost_service,
    recurring_service,
)

D = Decimal
TODAY = date(2026, 6, 30)


def _seed(session: Session) -> Account:
    usd = Account(broker="vanguard", account_label="V", native_currency="USD")
    session.add(usd)
    session.flush()
    fx_repo.upsert_rates(
        session,
        {date(2026, 1, 1): D("1.25"), date(2026, 4, 10): D("1.40"), date(2026, 5, 10): D("1.40")},
    )
    session.add(
        Transaction(
            account_id=usd.id,
            date=date(2026, 1, 5),
            kind="deposit",
            net_native=D("1250"),
            source="manual",
        )
    )
    session.flush()
    return usd


def _to_usd(session: Session) -> None:
    fx_conversion_service.create_conversion(
        session,
        on=date(2026, 1, 1),
        eur_sent=D("1000"),
        usd_received=D("1240"),
        fees_eur=D("3"),
        provider="wise",
    )


def _back(session: Session, on: date = date(2026, 4, 10), fees: str = "0") -> int:
    row = fx_conversion_service.create_conversion(
        session,
        on=on,
        eur_sent=D("198"),
        usd_received=D("280"),
        fees_eur=D(fees),
        provider="wise",
        from_ccy="USD",
        to_ccy="EUR",
    )
    session.flush()
    return row.id


def _figures(session: Session) -> dict[str, Any]:
    report = fx_cost_service.cost_report(session)
    return {
        "costs": [(c.id, c.cost_eur) for c in fx_cost_service.conversion_costs(session)],
        "summary": report.summary,
        "provider": fx_cost_service.provider_avg_off_pct(session, "wise"),
        "deposit_costs": fx_cost_service.deposit_costs(session),
        "pool": fx_conversion_service.pool_report(session).result,
        "conversions_in_pool": [
            c.id for c in fx_conversion_service.pool_report(session).conversions
        ],
        "usd_deposits": currency_deposits.usd_deposits(session),
        "deposit_info": deposits._conversion_info(session),
    }


def test_cost_pool_and_deposit_figures_ignore_the_conversion_back(session: Session) -> None:
    _seed(session)
    _to_usd(session)
    before = _figures(session)
    back_id = _back(session)
    assert _figures(session) == before
    (cost,) = fx_cost_service.conversion_costs(session, direction="to_eur")
    assert cost.id == back_id
    # $280 at ECB 1.40 = EUR 200; EUR 198 received: EUR 2 cost (= -CashOut.conversion_cost_eur)
    assert (cost.ecb_eur, cost.spread_eur, cost.cost_eur) == (D("200"), D("2"), D("2"))
    assert cost.all_in_rate == D("280") / D("198")
    assert cost.off_pct is not None and cost.off_pct < 0  # fewer euros than the reference


def test_back_cost_fees_work_like_the_other_direction() -> None:
    c = fx_spread.conversion_cost(
        fx_spread.Conversion(
            id=1,
            date=date(2026, 4, 10),
            eur_sent=D("198"),
            usd_received=D("280"),
            fees_eur=D("1"),
            provider=None,
            ecb_rate=D("1.40"),
            ecb_rate_date=date(2026, 4, 10),
            direction="to_eur",
        )
    )
    assert c.cost_eur == D("3") and c.spread_eur == D("2") and c.fees_eur == D("1")
    assert c.spread_usd == D("280") - D("198") * D("1.40")
    assert c.fees_usd == D("1.40")
    assert c.all_in_rate == D("280") / D("197")


def test_api_lists_both_directions_and_filters(session: Session) -> None:
    from investment_dashboard.api import fx_conversions as api

    _seed(session)
    _to_usd(session)
    back_id = _back(session)
    rows = api.list_conversions(session, direction=None)
    by_id = {r.id: r for r in rows}
    assert by_id[back_id].direction == "to_eur"
    assert D(by_id[back_id].remaining_usd) == 0
    assert D(by_id[back_id].cost_eur or "0") == D("2")
    assert [r.id for r in api.list_conversions(session, direction="to_eur")] == [back_id]
    assert back_id not in {r.id for r in api.list_conversions(session, direction="to_usd")}
    assert all(r.conversion_id != back_id for r in api.pool(session).remaining)


def test_only_a_conversion_back_means_no_conversions_for_deposits(session: Session) -> None:
    _seed(session)
    _back(session)
    item = diagnostics_service.check_unconverted_deposits(session)
    assert item.severity == "ok" and "No currency conversions" in item.detail
    assert deposits._conversion_info(session) == {}
    assert fx_conversion_service.effective_eur_overrides(session) == {}


def test_recurring_ignores_conversions_back(session: Session) -> None:
    _seed(session)
    for month in (3, 4, 5, 6):
        _back(session, on=date(2026, month, 10))
    kinds = {s.kind for s in recurring_service.suggest_routine(session, today=TODAY)}
    assert "conversion" not in kinds


def test_recap_counts_conversions_back_with_a_split(session: Session) -> None:
    from investment_dashboard.readmodels import recap

    _seed(session)
    _to_usd(session)
    _back(session, fees="1")
    april = recap.build(session, period="2026-04")["EUR"]
    assert D(april["conversion_cost"]) == D("3")  # EUR 2 spread + EUR 1 fee
    assert april["conversions"] == 1
    split = april["conversion_cost_by_direction"]
    assert split["to_usd"] == {"cost": None, "count": 0}
    assert D(split["to_eur"]["cost"]) == D("3") and split["to_eur"]["count"] == 1
    year = recap.build(session, period="2026")["EUR"]
    assert year["conversions"] == 2
    by = year["conversion_cost_by_direction"]
    assert D(year["conversion_cost"]) == D(by["to_usd"]["cost"]) + D(by["to_eur"]["cost"])


def test_rate_markers_carry_the_direction(session: Session) -> None:
    from investment_dashboard.readmodels import currency_rate

    _seed(session)
    _to_usd(session)
    back_id = _back(session)
    markers = currency_rate._markers(session, date(2026, 1, 1), TODAY)
    by_id = {m["conversion_id"]: m for m in markers}
    back = by_id[back_id]
    assert (back["direction"], back["from_ccy"], back["to_ccy"]) == ("to_eur", "USD", "EUR")
    assert (D(back["amount_from"]), D(back["amount_to"])) == (D("280"), D("198"))
    assert back["kind"] == "below_reference"  # fewer euros than the ECB fixing gave
    assert {m["direction"] for m in markers} == {"to_usd", "to_eur"}


def test_conversions_section_has_the_back_direction(session: Session) -> None:
    from investment_dashboard.readmodels import fx_costs

    _seed(session)
    _to_usd(session)
    without = fx_costs.build_costs_both(session, "all", TODAY)
    assert without["EUR"]["back_to_eur"] is None
    back_id = _back(session)
    sides = fx_costs.build_costs_both(session, "all", TODAY)
    eur = sides["EUR"]
    assert {k: v for k, v in eur.items() if k != "back_to_eur"} == {
        k: v for k, v in without["EUR"].items() if k != "back_to_eur"
    }
    back = eur["back_to_eur"]
    assert back["summary"]["count"] == 1 and D(back["summary"]["cost"]) == D("2")
    assert [(r["id"], r["direction"]) for r in back["rows"]] == [(back_id, "to_eur")]
    assert [p["provider"] for p in back["by_provider"] if p["count"]] == ["wise"]
    assert all(r["direction"] == "to_usd" for r in eur["rows"])
    usd_back = sides["USD"]["back_to_eur"]
    assert D(usd_back["summary"]["cost"]) == D("280") - D("198") * D("1.40")
