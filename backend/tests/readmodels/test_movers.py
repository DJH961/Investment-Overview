"""Tests for the Today's movers (winners/losers) leaderboard builder."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from investment_dashboard.readmodels.queries.overview_query import (
    HoldingCard,
    MoverEstimate,
    build_movers,
)

_TODAY = date(2024, 6, 3)
_PREV = date(2024, 6, 2)


def _estimate(
    twin: str,
    *,
    move_eur: Decimal | None,
    pct_eur: Decimal | None,
    move_usd: Decimal | None = None,
    pct_usd: Decimal | None = None,
    as_of: date | None = _TODAY,
) -> MoverEstimate:
    return MoverEstimate(
        twin_symbol=twin,
        move_eur=move_eur,
        move_usd=move_usd if move_usd is not None else move_eur,
        pct_eur=pct_eur,
        pct_usd=pct_usd if pct_usd is not None else pct_eur,
        as_of=as_of,
    )


def _card(
    symbol: str,
    *,
    move_eur: Decimal | None,
    pct_eur: Decimal | None,
    pct_usd: Decimal | None = None,
    move_usd: Decimal | None = None,
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
        daily_growth_usd=pct_usd if pct_usd is not None else pct_eur,
        daily_move_eur=move_eur,
        daily_move_usd=move_usd if move_usd is not None else move_eur,
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


def test_movers_top_percent_pick_uses_display_currency() -> None:
    # AAA is the bigger % gainer in EUR; BBB is the bigger % gainer in USD.
    cards = [
        _card("BIG", move_eur=Decimal("900"), pct_eur=Decimal("0.01"), pct_usd=Decimal("0.01")),
        _card("AAA", move_eur=Decimal("50"), pct_eur=Decimal("0.08"), pct_usd=Decimal("0.03")),
        _card("BBB", move_eur=Decimal("40"), pct_eur=Decimal("0.05"), pct_usd=Decimal("0.09")),
    ]
    assert [e.symbol for e in build_movers(cards, "EUR").winners] == ["BIG", "AAA"]
    assert [e.symbol for e in build_movers(cards, "USD").winners] == ["BIG", "BBB"]


def test_pending_fund_competes_on_its_twin_estimate_and_names_the_twin() -> None:
    """A late NAV is lagging, not absent: rank it on the estimate and say whose."""
    fund = _card(
        "FUND",
        move_eur=Decimal("5"),
        pct_eur=Decimal("0.001"),
        daily_as_of=_PREV,
        daily_is_stale=True,
    )
    live = _card("LIVE", move_eur=Decimal("300"), pct_eur=Decimal("0.03"))
    movers = build_movers(
        [fund, live],
        "EUR",
        {fund.instrument_id: _estimate("VOO", move_eur=Decimal("900"), pct_eur=Decimal("0.02"))},
    )
    # It beats the live holding on money, and does so on the ESTIMATE (900), never
    # on its own stale last-published move (5).
    assert [(e.symbol, e.reason) for e in movers.winners] == [
        ("FUND", "total"),
        ("LIVE", "percent"),
    ]
    top = movers.winners[0]
    assert top.twin == "VOO"
    assert top.move_eur == Decimal("900")
    assert top.pct_eur == Decimal("0.02")
    # The board is dated by the session being estimated, not the fund's last print.
    assert movers.basis_date == _TODAY
    assert movers.eligible_count == 2
    # A holding with no estimate is untouched.
    assert movers.winners[1].twin is None


def test_pending_fund_can_be_a_loser_on_its_estimate() -> None:
    """The side is decided by the estimated EUR move, not the stale official one."""
    fund = _card(
        "FUND",
        move_eur=Decimal("40"),
        pct_eur=Decimal("0.004"),
        daily_as_of=_PREV,
        daily_is_stale=True,
    )
    movers = build_movers(
        [fund],
        "EUR",
        {fund.instrument_id: _estimate("VOO", move_eur=Decimal("-700"), pct_eur=Decimal("-0.03"))},
    )
    assert movers.winners == []
    assert [(e.symbol, e.twin) for e in movers.losers] == [("FUND", "VOO")]


def test_pending_fund_stays_out_when_its_estimate_is_flat_or_unusable() -> None:
    """No usable estimate means no entry — never a fallback to the stale print."""
    flat = _card(
        "FLAT",
        move_eur=Decimal("900"),
        pct_eur=Decimal("0.5"),
        daily_as_of=_PREV,
        daily_is_stale=True,
    )
    gone = _card(
        "GONE",
        move_eur=Decimal("800"),
        pct_eur=Decimal("0.4"),
        daily_as_of=_PREV,
        daily_is_stale=True,
    )
    movers = build_movers(
        [flat, gone],
        "EUR",
        {
            flat.instrument_id: _estimate("VOO", move_eur=Decimal("0"), pct_eur=Decimal("0")),
            gone.instrument_id: _estimate("IVV", move_eur=None, pct_eur=None),
        },
    )
    assert movers.winners == []
    assert movers.losers == []
    assert movers.eligible_count == 0


def test_estimated_top_percent_pick_uses_display_currency() -> None:
    """An estimate is FX-variant too: the "top %" pick must follow the screen."""
    big = _card("BIG", move_eur=Decimal("900"), pct_eur=Decimal("0.01"))
    a = _card(
        "AAA", move_eur=Decimal("1"), pct_eur=Decimal("0"), daily_as_of=_PREV, daily_is_stale=True
    )
    b = _card(
        "BBB", move_eur=Decimal("1"), pct_eur=Decimal("0"), daily_as_of=_PREV, daily_is_stale=True
    )
    est = {
        a.instrument_id: _estimate(
            "VOO",
            move_eur=Decimal("50"),
            pct_eur=Decimal("0.08"),
            move_usd=Decimal("55"),
            pct_usd=Decimal("0.03"),
        ),
        b.instrument_id: _estimate(
            "IVV",
            move_eur=Decimal("40"),
            pct_eur=Decimal("0.05"),
            move_usd=Decimal("44"),
            pct_usd=Decimal("0.09"),
        ),
    }
    cards = [big, a, b]
    assert [e.symbol for e in build_movers(cards, "EUR", est).winners] == ["BIG", "AAA"]
    assert [e.symbol for e in build_movers(cards, "USD", est).winners] == ["BIG", "BBB"]
