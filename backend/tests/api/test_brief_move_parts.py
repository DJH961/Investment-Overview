"""The Brief's session move: parts sum to the headline, on the hero's basis."""

from __future__ import annotations

from decimal import Decimal

from investment_dashboard.readmodels.brief import _move

# The fixture's numbers: official 7,006.33, estimate 8,010.00 (the hero's headline),
# of which the currency part is -2,255.30.
OVERVIEW = {
    "kpis": {
        "daily_move": "7006.33",
        "daily_growth_pct": "0.0055",
        "daily_growth_as_of": "2026-06-30",
        "estimate": {"daily_move": "8010.00", "daily_growth_pct": "0.0063"},
    },
    "day_split": {
        "price_move": "8010.00",
        "currency_move": "-2255.30",
        "overnight": False,
        "estimated": True,
    },
    "movers": None,
}


def _sum(move: dict[str, object]) -> Decimal:
    return Decimal(str(move["price_move"])) + Decimal(str(move["currency_move"] or "0"))


def test_estimated_euro_move_uses_the_heros_total_and_parts_sum() -> None:
    move = _move(OVERVIEW, "2026-06-30", "EUR")
    assert move["day_move"] == "8010.00"
    assert move["day_move_pct"] == "0.0063"
    assert move["estimated"] is True
    assert move["currency_move"] == "-2255.30"
    assert move["price_move"] == "10265.30"
    assert _sum(move) == Decimal(str(move["day_move"]))


def test_usd_view_has_no_currency_leg_and_market_is_the_whole_move() -> None:
    move = _move(OVERVIEW, "2026-06-30", "USD")
    assert move["currency_move"] is None
    assert move["price_move"] == move["day_move"] == "8010.00"


def test_overnight_currency_is_beside_the_total_not_in_it() -> None:
    shut = {
        **OVERVIEW,
        "day_split": {**OVERVIEW["day_split"], "overnight": True, "estimated": False},
    }
    move = _move(shut, "2026-06-30", "EUR")
    assert move["day_move"] == "8010.00"
    assert move["price_move"] == "8010.00"
    assert move["currency_move"] == "-2255.30"
    assert move["currency_overnight"] is True
    assert move["day_move_pct"] == "0.0055"  # not estimated: the official percentage
