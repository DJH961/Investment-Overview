"""Tests for :mod:`investment_dashboard.domain.session_fx`.

The Python twin of ``web/test/session-fx.test.ts``: which rate the live 1D/1W
graphs anchor to across the market-hours boundary, and how today's FX revaluation
splits into its market-hours and overnight slices. Pure Decimal maths.
"""

from __future__ import annotations

from decimal import Decimal

from investment_dashboard.domain.session_fx import (
    FxEffectSplit,
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
    def test_whole_move_is_market_hours_while_open(self) -> None:
        split = fx_effect_split(
            market_open=True,
            total_value_usd=d("108000"),
            live_fx=d("1.08"),
            session_close_fx=None,
            today_fx_move_eur=d("120"),
        )
        assert split.total_eur == d("120")
        assert split.overnight_eur == d("0")
        assert split.market_hours_eur == d("120")

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
