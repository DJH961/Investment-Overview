"""Tests for :mod:`investment_dashboard.domain.session_fx`.

The Python twin of ``web/test/session-fx.test.ts``: which rate the live 1D/1W
graphs anchor to across the market-hours boundary, and how today's FX revaluation
splits into its market-hours and overnight slices. Pure Decimal maths.
"""

from __future__ import annotations

from decimal import Decimal

from investment_dashboard.domain.session_fx import (
    FxBuyingPowerSplit,
    FxEffectSplit,
    fx_buying_power_split,
    fx_effect_split,
    graph_anchor_fx,
)


def d(value: str | int) -> Decimal:
    return Decimal(str(value))


class TestGraphAnchorFx:
    def test_uses_live_rate_while_open(self) -> None:
        fx = graph_anchor_fx(market_open=True, live_fx=d("1.08"), session_close_fx=d("1.05"))
        assert fx == d("1.08")

    def test_freezes_to_session_close_once_shut(self) -> None:
        fx = graph_anchor_fx(market_open=False, live_fx=d("1.08"), session_close_fx=d("1.05"))
        assert fx == d("1.05")

    def test_falls_back_to_live_when_no_close_rate(self) -> None:
        fx = graph_anchor_fx(market_open=False, live_fx=d("1.08"), session_close_fx=None)
        assert fx == d("1.08")

    def test_freezes_to_settled_prev_when_no_captured_close(self) -> None:
        # App not live at 16:00 ET / cold start: no captured session close, but the
        # settled prior close is a stable rate to freeze to instead of the live spot.
        fx = graph_anchor_fx(
            market_open=False,
            live_fx=d("1.08"),
            session_close_fx=None,
            settled_prev_fx=d("1.0725"),
        )
        assert fx == d("1.0725")

    def test_prefers_captured_close_over_settled_prev(self) -> None:
        fx = graph_anchor_fx(
            market_open=False,
            live_fx=d("1.08"),
            session_close_fx=d("1.0775"),
            settled_prev_fx=d("1.0725"),
        )
        assert fx == d("1.0775")

    def test_ignores_non_positive_settled_prev(self) -> None:
        fx = graph_anchor_fx(
            market_open=False,
            live_fx=d("1.08"),
            session_close_fx=None,
            settled_prev_fx=d("0"),
        )
        assert fx == d("1.08")

    def test_uses_live_while_open_even_with_settled_prev(self) -> None:
        fx = graph_anchor_fx(
            market_open=True,
            live_fx=d("1.08"),
            session_close_fx=d("1.05"),
            settled_prev_fx=d("1.0725"),
        )
        assert fx == d("1.08")

    def test_none_when_neither_available(self) -> None:
        assert graph_anchor_fx(market_open=False, live_fx=None, session_close_fx=None) is None


class TestFxEffectSplit:
    def test_whole_move_is_market_hours_while_open_without_open_fx(self) -> None:
        # No session-open anchor yet (e.g. cold start mid-session): the whole move
        # falls back into the live market-hours leg and the overnight leg is unknown
        # (None) so the UI hides the split rather than inventing a zero counterpart.
        split = fx_effect_split(
            market_open=True,
            total_value_usd=d("108000"),
            live_fx=d("1.08"),
            session_close_fx=None,
            today_fx_move_eur=d("120"),
        )
        assert split.total_eur == d("120")
        assert split.overnight_eur is None
        assert split.market_hours_eur == d("120")

    def test_open_market_carves_live_market_hours_and_keeps_last_overnight(self) -> None:
        # Market open. Today's whole FX move (prior close -> now) is +120 EUR. The
        # session opened at 1.07; live now 1.08. The live market-hours slice is the
        # drift since the open; last night's overnight slice survives as the
        # remainder so it does not fold to zero at the market start.
        split = fx_effect_split(
            market_open=True,
            total_value_usd=d("108000"),
            live_fx=d("1.08"),
            session_open_fx=d("1.07"),
            session_close_fx=None,
            today_fx_move_eur=d("120"),
        )
        expected_market = d("108000") / d("1.08") - d("108000") / d("1.07")
        assert split.market_hours_eur == expected_market
        assert split.overnight_eur == d("120") - expected_market
        # The two legs always sum back to the day's whole move.
        assert split.market_hours_eur + split.overnight_eur == d("120")

    def test_isolates_overnight_drift_once_shut(self) -> None:
        # USD book of $108,000. Closed at 1.08 -> EUR 100,000; live now 1.10 ->
        # EUR 98,181.82. Overnight slice = 98,181.82 - 100,000 = -1,818.18.
        split = fx_effect_split(
            market_open=False,
            total_value_usd=d("108000"),
            live_fx=d("1.10"),
            session_close_fx=d("1.08"),
            today_fx_move_eur=d("-1500"),
        )
        assert split.overnight_eur is not None
        assert abs(float(split.overnight_eur) - (108000 / 1.10 - 108000 / 1.08)) < 1e-6
        assert split.market_hours_eur is not None
        # Market-hours slice is the remainder of the day's FX move.
        assert split.market_hours_eur == d("-1500") - split.overnight_eur

    def test_overnight_positive_when_euro_weakens_after_close(self) -> None:
        # Live rate LOWER than close => each USD buys back MORE euros => EUR value
        # rises => positive overnight slice.
        split = fx_effect_split(
            market_open=False,
            total_value_usd=d("108000"),
            live_fx=d("1.06"),
            session_close_fx=d("1.08"),
            today_fx_move_eur=d("0"),
        )
        assert split.overnight_eur is not None
        assert split.overnight_eur > 0

    def test_nulls_when_usd_or_rate_pair_missing(self) -> None:
        no_usd = fx_effect_split(
            market_open=False,
            total_value_usd=None,
            live_fx=d("1.08"),
            session_close_fx=d("1.05"),
            today_fx_move_eur=d("50"),
        )
        assert no_usd.overnight_eur is None
        # market_hours falls back to the whole move when overnight is unknown.
        assert no_usd.market_hours_eur == d("50")

        no_close = fx_effect_split(
            market_open=False,
            total_value_usd=d("108000"),
            live_fx=d("1.08"),
            session_close_fx=None,
            today_fx_move_eur=d("50"),
        )
        assert no_close.overnight_eur is None

    def test_propagates_null_move_as_null_total(self) -> None:
        split = fx_effect_split(
            market_open=False,
            total_value_usd=d("108000"),
            live_fx=d("1.08"),
            session_close_fx=d("1.05"),
            today_fx_move_eur=None,
        )
        assert split.total_eur is None
        assert split.market_hours_eur is None

    def test_returns_dataclass(self) -> None:
        split = fx_effect_split(
            market_open=True,
            total_value_usd=None,
            live_fx=None,
            session_close_fx=None,
            today_fx_move_eur=None,
        )
        assert isinstance(split, FxEffectSplit)


class TestFxBuyingPowerSplit:
    """The USD investing-power twin: how many more/fewer dollars a fixed EUR
    notional buys now versus yesterday's close, split into market-hours and
    overnight legs. Mirrors ``fxBuyingPowerSplit`` in the web companion."""

    def test_net_buying_power_is_amount_times_rate_change(self) -> None:
        # €100 at 1.30 vs 1.20 prior close ⇒ 100·(1.30−1.20) = +$10 to invest.
        split = fx_buying_power_split(
            market_open=True,
            amount_eur=d(100),
            live_fx=d("1.30"),
            prev_fx=d("1.20"),
            session_close_fx=None,
            session_open_fx=d("1.25"),
        )
        assert split.total_usd == d("10.00")
        # Live leg = market hours since the open: 100·(1.30−1.25) = +$5.
        assert split.market_hours_usd == d("5.00")
        # Frozen overnight = remainder so the two always sum to the total.
        assert split.overnight_usd == d("5.00")

    def test_overnight_leg_is_live_once_shut(self) -> None:
        # Closed: live leg = overnight since the close 100·(1.30−1.25)=+$5;
        # frozen market-hours = remainder.
        split = fx_buying_power_split(
            market_open=False,
            amount_eur=d(100),
            live_fx=d("1.30"),
            prev_fx=d("1.20"),
            session_close_fx=d("1.25"),
        )
        assert split.total_usd == d("10.00")
        assert split.overnight_usd == d("5.00")
        assert split.market_hours_usd == d("5.00")

    def test_negative_when_euro_weakens(self) -> None:
        # Euro weaker (1.10 < 1.20) ⇒ the same euros buy fewer dollars: −$10.
        split = fx_buying_power_split(
            market_open=True,
            amount_eur=d(100),
            live_fx=d("1.10"),
            prev_fx=d("1.20"),
            session_close_fx=None,
            session_open_fx=d("1.15"),
        )
        assert split.total_usd == d("-10.00")
        assert split.market_hours_usd == d("-5.00")
        assert split.overnight_usd == d("-5.00")

    def test_whole_move_in_live_leg_when_anchor_missing(self) -> None:
        # No session open anchor ⇒ the whole move falls into the live leg and the
        # frozen counterpart is None so the UI hides the split.
        split = fx_buying_power_split(
            market_open=True,
            amount_eur=d(100),
            live_fx=d("1.30"),
            prev_fx=d("1.20"),
            session_close_fx=None,
            session_open_fx=None,
        )
        assert split.total_usd == d("10.00")
        assert split.market_hours_usd == d("10.00")
        assert split.overnight_usd is None

    def test_nulls_when_amount_or_rate_pair_missing(self) -> None:
        no_amount = fx_buying_power_split(
            market_open=True,
            amount_eur=None,
            live_fx=d("1.30"),
            prev_fx=d("1.20"),
            session_close_fx=None,
            session_open_fx=d("1.25"),
        )
        assert no_amount.total_usd is None
        assert no_amount.market_hours_usd is None
        no_prev = fx_buying_power_split(
            market_open=False,
            amount_eur=d(100),
            live_fx=d("1.30"),
            prev_fx=None,
            session_close_fx=d("1.25"),
        )
        assert no_prev.total_usd is None

    def test_non_positive_amount_degrades_to_null(self) -> None:
        split = fx_buying_power_split(
            market_open=True,
            amount_eur=d(0),
            live_fx=d("1.30"),
            prev_fx=d("1.20"),
            session_close_fx=None,
            session_open_fx=d("1.25"),
        )
        assert split.total_usd is None

    def test_returns_dataclass(self) -> None:
        split = fx_buying_power_split(
            market_open=True,
            amount_eur=None,
            live_fx=None,
            prev_fx=None,
            session_close_fx=None,
        )
        assert isinstance(split, FxBuyingPowerSplit)
