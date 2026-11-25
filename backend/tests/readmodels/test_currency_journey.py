"""7.4 lane C: the journey read model, the money trail and the journey fields on G1."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from investment_dashboard.readmodels import currency_journey as cj
from investment_dashboard.readmodels import journey_fields, money_trail
from investment_dashboard.services import diagnostics_service as diag

from . import journey_g1 as g1

D = Decimal


def _lines(view: dict) -> dict[str, Decimal]:
    return {line["key"]: D(line["eur"]) for line in view["bridge"]["lines"]}


# --------------------------------------------------------------------- the bridge


def test_bridge_hand_values_and_total() -> None:
    eur = cj.build_journey_both(g1.inputs())["eur"]
    # C1 at ECB 1.25 costs 0; C2 1,000/1.25 - 1,000 = -200; C3 600/1.25 - 500 = -20;
    # CB1 -2.
    assert _lines(eur) == {
        "conversion_cost": D("-222.00"),
        "waiting": D("65.45"),  # C3's $600 idle: 600/1.10 - 600/1.25
        "cash": D("1.09"),  # the $10 dividend: 10/1.10 - 8
        "holdings": D("223.64"),
        "realised": D("-24.00"),
    }
    assert D(eur["bridge"]["total_eur"]) == sum(_lines(eur).values())


def test_bridge_total_is_currency_still_in_dollars_plus_cash_outs() -> None:
    inp = g1.inputs()
    j = cj.build_journey(inp)
    tiles = sum((b.currency_eur or D(0) for b in (j.usd_account, j.broker_cash, j.invested)), D(0))
    backs = sum((c.currency_eur + c.conversion_cost_eur for c in j.cash_outs), D(0))
    assert j.bridge_total is not None
    assert abs(j.bridge_total - (tiles + backs)) <= D("0.03")  # five lines, each to the cent


def test_identity_bridge_total_equals_lifetime_fx_pnl_exactly() -> None:
    for kw in ({}, {"sale": "160"}, {"back": False}, {"rate_now": D("0.97")}):
        inp = g1.inputs(**kw)
        both = cj.build_journey_both(inp)
        life = journey_fields.lifetime_fields(inp)
        assert life["fx_pnl_eur"] == both["eur"]["bridge"]["total_eur"], kw
        assert life["breakeven_rate"] is not None
        assert D(life["breakeven_rate"]) == cj.your_rates(inp)[0]


def test_lifetime_fields() -> None:
    life = journey_fields.lifetime_fields(g1.inputs())
    assert life["your_rate"] == "1.1400"  # 2,850 / 2,500
    assert life["ecb_avg"] == "1.2500"
    assert life["conversion_cost_eur"] == "-222.00"
    assert D(life["realised_eur"]) == D("38")
    assert life["vs_impact_note"]
    assert journey_fields.lifetime_fields(g1.inputs(back=False))["realised_eur"] is None


def test_no_live_rate_no_bridge() -> None:
    both = cj.build_journey_both(g1.inputs(rate_now=None))
    assert both["eur"]["bridge"] is None
    assert both["eur"]["stats"]["invested"]["eur_now"] is None
    assert both["eur"]["stats"]["invested"]["eur_cost"] == "1840.00"


# ------------------------------------------------------------------ conservation


def test_journey_stats_conservation() -> None:
    inp = g1.inputs()
    j = cj.build_journey(inp)
    state = inp.snapshot.state
    put_in = sum((b.eur_cost for b in inp.conversions), D(0))
    income = D(8)
    sale_market = sum(state.sale_market_eur.values(), D(0))
    out = (
        j.usd_account.eur_cost
        + j.broker_cash.eur_cost
        + j.invested.eur_cost
        + sum((c.orig_eur + c.market_eur for c in j.cash_outs), D(0))
        + state.fees_eur
    )
    assert out == put_in + income + sale_market  # 2,500 + 8 + 64
    # Dollars: converted + income + gain = still here + spent at cost + sent back.
    usd_now = j.usd_account.usd + j.broker_cash.usd + j.invested.cost_native
    sent = sum((c.usd_sent for c in j.cash_outs), D(0))
    assert usd_now + sent == D(2850) + D(10) + D(80)


def test_four_tiles_always_and_back_in_euros() -> None:
    both = cj.build_journey_both(g1.inputs())
    for view in both.values():
        assert set(view["stats"]) == {"usd_account", "broker_cash", "invested", "your_rate"}
    back = both["eur"]["back_in_euros"]
    assert back == {
        "count": 1,
        "eur_received": "198.00",
        "orig_eur": "160.00",
        "realised_eur": "38.00",
    }
    assert cj.build_journey_both(g1.inputs(back=False))["eur"]["back_in_euros"] is None
    empty = cj.empty_journey_both()
    assert empty["eur"]["bridge"] is None


def test_idle_dollars() -> None:
    idle = cj.build_journey_both(g1.inputs())["eur"]["idle"]
    assert idle == [{"conversion_id": 3, "date": "2026-03-01", "usd": "600.00", "days": 61}]


# ------------------------------------------------------------------ the USD view


def test_usd_view_hides_euro_only_lines() -> None:
    usd = cj.build_journey_both(g1.inputs())["usd"]
    assert usd["bridge"] is None
    for key in ("usd_account", "broker_cash", "invested"):
        tile = usd["stats"][key]
        assert tile["usd"] is not None
        assert tile["eur_cost"] is None
        assert tile["eur_now"] is None
        assert tile["currency_eur"] is None
    assert usd["stats"]["invested"]["market_eur"] is None
    assert usd["stats"]["invested"]["usd"] == "2405.00"


def test_usd_view_is_rate_independent() -> None:
    """Scaling every ECB rate and the live rate never moves a dollar figure."""
    base = cj.build_journey_both(g1.inputs())["usd"]
    for scale in (D("0.8"), D("1.3")):
        other = cj.build_journey_both(g1.inputs(ecb_scale=scale))["usd"]
        assert other["stats"]["usd_account"] == base["stats"]["usd_account"]
        assert other["stats"]["broker_cash"] == base["stats"]["broker_cash"]
        assert other["stats"]["invested"] == base["stats"]["invested"]
        assert other["idle"] == base["idle"]


# --------------------------------------------------------------------- cash-outs


def test_cash_out_eur_identity_and_usd_side() -> None:
    (co,) = cj.build_journey_both(g1.inputs())["eur"]["cash_outs"]
    e = co["eur"]
    assert (e["put_in"], e["market"], e["currency"], e["conversion_cost"], e["realised"]) == (
        "160.00",
        "64.00",
        "-24.00",
        "-2.00",
        "38.00",
    )
    assert D(e["realised"]) == D(e["market"]) + D(e["currency"]) + D(e["conversion_cost"])
    u = co["usd"]
    # The $280 sent: $200 of C1's dollars (EUR 160 at C1's own 1.25) plus the $80 gain.
    assert (u["put_in"], u["market"], u["realised"]) == ("200.00", "80.00", "80.00")
    assert D(u["realised_pct"]) == D("0.4")
    assert "points a year less in euros" in co["note"]


def test_cash_out_loss_g2() -> None:
    (co,) = cj.build_journey_both(g1.inputs(sale="160"))["eur"]["cash_outs"]
    e = co["eur"]
    assert D(e["realised"]) == D("-48.00")
    assert D(e["realised"]) == D(e["market"]) + D(e["currency"]) + D(e["conversion_cost"])
    assert co["usd"]["put_in"] == "200.00"
    assert co["usd"]["realised"] == "-40.00"


def test_cash_out_usd_side_never_from_eur() -> None:
    """Rate independence: the dollar side does not move when every EUR rate moves."""
    base = cj.build_journey_both(g1.inputs())["eur"]["cash_outs"][0]["usd"]
    for scale in (D("0.5"), D("1.7")):
        other = cj.build_journey_both(g1.inputs(ecb_scale=scale))["eur"]["cash_outs"][0]["usd"]
        assert other == base


def test_preview_matches_the_saved_cash_out() -> None:
    inp = g1.inputs(back=False)
    pre = cj.build_preview(
        inp,
        usd_sent=D(280),
        eur_received=D(198),
        fees_eur=D(0),
        on=date(2026, 4, 10),
        withdrawal_id=206,
    )
    saved = cj.build_journey_both(g1.inputs())["eur"]["cash_outs"][0]
    assert pre["conversion_id"] is None
    assert pre["eur"] == saved["eur"]
    assert pre["usd"] == saved["usd"]
    assert pre["flagged"] is False


def test_preview_with_too_many_dollars_is_flagged() -> None:
    pre = cj.build_preview(
        g1.inputs(back=False),
        usd_sent=D(5000),
        eur_received=D(3500),
        fees_eur=D(5),
        on=date(2026, 4, 10),
        withdrawal_id=206,
    )
    assert pre["flagged"] is True
    assert pre["fees_eur"] == "5.00"


# ------------------------------------------------------------------------ trails


def test_trail_buy_b2_shows_two_paths() -> None:
    trail = money_trail.build_trail(g1.inputs(), "buy", 202)
    assert trail is not None
    assert len(trail["paths"]) == 2
    assert trail["more_paths"] == 0
    first, second = trail["paths"]
    assert first["usd_share"] == "0.7500"
    assert second["usd_share"] == "0.2500"
    assert first["steps"][0]["link"] == "/conversions?highlight=1"
    assert second["steps"][0]["link"] == "/conversions?highlight=2"
    deposited = [s for s in first["steps"] if s["key"] == "deposited"]
    assert deposited[0]["link"] == "/transactions?txn=101"
    assert [s["key"] for s in first["steps"]][-2:] == ["bought", "worth_now"]
    split = trail["split"]
    total = D(split["total_eur"])
    assert total == D(split["market_eur"]) + D(split["currency_eur"]) + D(
        split["conversion_cost_eur"]
    )
    assert total == D("150.00")  # $1,100 / 1.10 - book EUR 850


def test_every_trail_detail_fits_and_kinds_resolve() -> None:
    inp = g1.inputs()
    cases = [
        ("deposit", 101),
        ("deposit", 102),
        ("buy", 201),
        ("buy", 202),
        ("buy", 203),
        ("sell", 204),
        ("withdrawal", 206),
        ("conversion", 1),
        ("conversion", 3),
        ("conversion", 301),
    ]
    for kind, id_ in cases:
        trail = money_trail.build_trail(inp, kind, id_)
        assert trail is not None, (kind, id_)
        assert trail["paths"], (kind, id_)
        for p in trail["paths"]:
            for s in p["steps"]:
                assert s["detail"] is None or len(s["detail"]) <= money_trail.DETAIL_MAX
    assert money_trail.build_trail(inp, "buy", 999) is None
    assert money_trail.build_trail(inp, "buy", 101) is None


def test_sell_trail_reaches_back_in_euros() -> None:
    trail = money_trail.build_trail(g1.inputs(), "sell", 204)
    assert trail is not None
    keys = [s["key"] for s in trail["paths"][0]["steps"]]
    assert keys == ["sent", "converted", "sold", "withdrawn", "back"]
    back = money_trail.build_trail(g1.inputs(), "conversion", 301)
    assert back is not None
    assert back["split"]["total_eur"] == "38.00"


# ----------------------------------------------------------------- journey fields


def test_holding_fields() -> None:
    inp = g1.inputs()
    # Y: C1 EUR 600 ($750) + C2 EUR 250 ($250) = $1,000 / EUR 850.
    assert journey_fields.peek_your_rate(inp, g1.Y) == "1.1765"
    facts = journey_fields.key_facts_fields(inp, g1.Y, growth_eur=D("0.17"), growth_usd=D("0.10"))
    assert facts["ecb_buy_avg"] == "1.0500"
    assert D(facts["fx_effect_pp"]) == D("0.07")
    assert journey_fields.holdings_fx_your_rate(inp) == "1.1400"


def test_tranche_and_transaction_fields() -> None:
    inp = g1.inputs()
    row = journey_fields.tranche_fields(
        inp, account_id=g1.ACC, instrument_id=g1.Y, cost_native=D(500), value_native=D(550)
    )
    assert D(row["cost_eur"]) == D(425)
    assert row["back_in_euros"] is None
    assert D(row["gain_eur"]) == D(550) / D("1.10") - D(425)
    sold = journey_fields.tranche_fields(
        inp,
        account_id=g1.ACC,
        instrument_id=g1.X,
        cost_native=D(200),
        value_native=None,
        sell_txn_id=204,
    )
    assert sold["back_in_euros"] is True
    still = journey_fields.tranche_fields(
        g1.inputs(back=False),
        account_id=g1.ACC,
        instrument_id=g1.X,
        cost_native=D(200),
        value_native=None,
        sell_txn_id=204,
    )
    assert still["back_in_euros"] is False
    txns = inp.txns
    assert journey_fields.transaction_fields(inp, txns[101]) == {
        "eur_basis": "your_rate",
        "trail_kind": "deposit",
    }
    assert journey_fields.transaction_fields(inp, txns[202]) == {
        "eur_basis": "pool",
        "trail_kind": "buy",
    }
    assert journey_fields.transaction_fields(inp, txns[206])["trail_kind"] == "withdrawal"


def test_cashed_out_eur() -> None:
    inp = g1.inputs()
    assert journey_fields.cashed_out_eur(inp) == D(198)
    assert journey_fields.cashed_out_eur(inp, date(2026, 5, 1), date(2026, 5, 31)) == D(0)
    assert journey_fields.cashed_out_by_period(inp, by="month") == {"2026-04": D(198)}


# ----------------------------------------------------------------- Data Health


def test_data_health_journey_checks() -> None:
    inp = g1.inputs()
    idle = diag.journey_idle_dollars(inp)
    assert (idle.key, idle.severity, idle.count) == ("idle_dollars", "warning", 1)
    assert diag.journey_uncovered_buys(inp).severity == "ok"
    assert diag.journey_conversion_back_uncovered(inp).severity == "ok"
    waiting = diag.journey_withdrawals_not_converted(g1.inputs(back=False))
    assert (waiting.severity, waiting.count) == ("info", 1)
    assert diag.journey_withdrawals_not_converted(inp).severity == "ok"
    neg = diag.journey_negative_broker_cash({"Broker A (USD)": D("-12.50"), "B": D(0)})
    assert (neg.severity, neg.count) == ("warning", 1)
