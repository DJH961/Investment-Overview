"""Tests for the Today's movers (winners/losers) leaderboard builder."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from investment_dashboard.ui.pages._overview_query import (
    HoldingCard,
    build_movers,
)

_TODAY = date(2024, 6, 3)
_PREV = date(2024, 6, 2)


def _card(
    symbol: str,
    *,
    move_eur: Decimal | None,
    pct_eur: Decimal | None,
    daily_as_of: date | None = _TODAY,
    daily_is_stale: bool = False,
) -> HoldingCard:
    """A minimal HoldingCard carrying only the fields build_movers reads."""
    return HoldingCard(
        instrument_id=abs(hash(symbol)) % 100000,
        symbol=symbol,
        name=f"{symbol} Fund",
        category="",
        native_currency="EUR",
        is_money_market=False,
        value_warning=False,
        price_data_warning=False,
        shares=Decimal("1"),
        current_price_native=Decimal("1"),
        avg_price_native=Decimal("1"),
        expense_ratio=None,
        value_eur=Decimal("1000"),
        value_usd=Decimal("1100"),
        cost_basis_eur=Decimal("0"),
        cost_basis_usd=Decimal("0"),
        capital_gain_eur=None,
        capital_gain_usd=None,
        total_growth_eur=None,
        total_growth_usd=None,
        xirr_eur=None,
        xirr_usd=None,
        daily_growth_eur=pct_eur,
        daily_growth_usd=pct_eur,
        daily_move_eur=move_eur,
        daily_move_usd=move_eur,
        ytd_growth_eur=None,
        ytd_growth_usd=None,
        weight=None,
        price_as_of=daily_as_of,
        updated_at=None,
        daily_growth_as_of=daily_as_of,
        daily_is_stale=daily_is_stale,
    )


def test_movers_pick_biggest_money_and_biggest_percent_each_side() -> None:
    movers = build_movers(
        [
            _card("AAA", move_eur=Decimal("500"), pct_eur=Decimal("0.01")),
            _card("BBB", move_eur=Decimal("50"), pct_eur=Decimal("0.08")),
            _card("CCC", move_eur=Decimal("-400"), pct_eur=Decimal("-0.02")),
            _card("DDD", move_eur=Decimal("-20"), pct_eur=Decimal("-0.09")),
        ]
    )
    assert [(e.symbol, e.reason) for e in movers.winners] == [
        ("AAA", "total"),
        ("BBB", "percent"),
    ]
    assert [(e.symbol, e.reason) for e in movers.losers] == [
        ("CCC", "total"),
        ("DDD", "percent"),
    ]
    assert movers.eligible_count == 4
    assert movers.basis_date == _TODAY


def test_movers_percentage_runner_up_when_one_holding_tops_both() -> None:
    movers = build_movers(
        [
            _card("TOP", move_eur=Decimal("900"), pct_eur=Decimal("0.10")),
            _card("RUN", move_eur=Decimal("100"), pct_eur=Decimal("0.05")),
            _card("LOW", move_eur=Decimal("80"), pct_eur=Decimal("0.01")),
        ]
    )
    assert [(e.symbol, e.reason) for e in movers.winners] == [
        ("TOP", "total"),
        ("RUN", "percent"),
    ]
    assert movers.losers == []


def test_movers_exclude_lagging_holdings() -> None:
    movers = build_movers(
        [
            _card("LIVE", move_eur=Decimal("300"), pct_eur=Decimal("0.03")),
            _card(
                "LAG",
                move_eur=Decimal("999"),
                pct_eur=Decimal("0.5"),
                daily_as_of=_PREV,
                daily_is_stale=True,
            ),
        ]
    )
    assert [e.symbol for e in movers.winners] == ["LIVE"]
    assert movers.eligible_count == 1
    assert movers.basis_date == _TODAY


def test_movers_ignore_flat_and_missing_moves() -> None:
    movers = build_movers(
        [
            _card("FLAT", move_eur=Decimal("0"), pct_eur=Decimal("0")),
            _card("NONE", move_eur=None, pct_eur=None),
        ]
    )
    assert movers.winners == []
    assert movers.losers == []
    assert movers.eligible_count == 0
    assert movers.basis_date is None


def test_movers_single_entry_per_side_when_only_one_mover() -> None:
    movers = build_movers(
        [
            _card("ONLY", move_eur=Decimal("200"), pct_eur=Decimal("0.02")),
            _card("DOWN", move_eur=Decimal("-10"), pct_eur=Decimal("-0.001")),
        ]
    )
    assert [e.symbol for e in movers.winners] == ["ONLY"]
    assert [e.symbol for e in movers.losers] == ["DOWN"]
