"""Tests for the Calculator view's pure builder logic (no rendering).

These exercise the state-machine methods of ``_CalculatorView`` directly —
``__init__`` and the ``_build_*`` / ``_preset_saved`` helpers never touch the
NiceGUI render tree on their success paths, so they can be unit-tested.
"""

from __future__ import annotations

from decimal import Decimal

from investment_dashboard.ui.pages._calculator_query import (
    CalcCategory,
    CalcData,
    CalcInstrument,
)
from investment_dashboard.ui.pages.calculator import _CalculatorPayload, _CalculatorView

ZERO = Decimal(0)


def _payload(
    data: CalcData,
    *,
    active_weights: dict[int, Decimal] | None = None,
    active_no_buy: set[int] | None = None,
    active_allow_sell: bool = False,
    active_display_currency: str | None = None,
) -> _CalculatorPayload:
    return _CalculatorPayload(
        data=data,
        active_weights=active_weights or {},
        active_no_buy=active_no_buy or set(),
        active_allow_sell=active_allow_sell,
        active_display_currency=active_display_currency,
    )


def _instr(iid: int, symbol: str, category: str, value: Decimal, pct: Decimal) -> CalcInstrument:
    return CalcInstrument(
        instrument_id=iid,
        symbol=symbol,
        name=symbol,
        category=category,
        current_value_eur=value,
        current_pct=pct,
        price_eur=Decimal(10),
    )


def _data() -> CalcData:
    # US: VTI (75%). International: VXUS (held) + VEU (unheld).
    vti = _instr(1, "VTI", "US", Decimal(3000), Decimal(75))
    vxus = _instr(2, "VXUS", "International", Decimal(1000), Decimal(25))
    veu = _instr(3, "VEU", "International", ZERO, ZERO)
    cats = [
        CalcCategory("US", Decimal(3000), Decimal(75), [vti]),
        CalcCategory("International", Decimal(1000), Decimal(25), [vxus, veu]),
    ]
    return CalcData(
        instruments=[vti, vxus, veu],
        categories=cats,
        fx_rate_usd_per_eur=Decimal("1.25"),
        default_currency="EUR",
    )


def _view() -> _CalculatorView:
    return _CalculatorView(_payload(_data()))


def test_unticked_member_gets_no_weight_invested_picks_up_slack() -> None:
    view = _view()
    view.mode = "category"
    view.cat_targets = {"US": 50.0, "International": 50.0}
    view.cat_split = {"US": "equal", "International": "equal"}
    # Untick VEU (id 3) in International — it should get NO target; the ticked
    # member (VXUS) absorbs the whole category %, and VEU naturally dilutes.
    view.cat_selected["International"].discard(3)

    built = view._build_category_weights()
    assert built is not None
    weights, no_buy = built
    # VXUS (ticked) takes the full 50 % of the International category.
    assert weights[2] == Decimal(50)
    assert weights[1] == Decimal(50)
    # VEU (unticked) gets no target at all — not raised proportionally.
    assert 3 not in weights
    # Nothing is flagged no-buy any more: unticked funds are simply excluded.
    assert no_buy == set()


def test_category_with_target_but_no_ticked_funds_is_rejected() -> None:
    view = _view()
    view.mode = "category"
    view.cat_targets = {"US": 50.0, "International": 50.0}
    # Untick every International member while it still has a positive target.
    view.cat_selected["International"].clear()

    assert view._build_category_weights() is None


def test_all_ticked_yields_no_no_buy() -> None:
    view = _view()
    view.mode = "category"
    view.cat_targets = {"US": 100.0}
    built = view._build_category_weights()
    assert built is not None
    _weights, no_buy = built
    assert no_buy == set()


def test_fund_mode_returns_empty_no_buy() -> None:
    view = _view()
    view.mode = "fund"
    view.fund_targets = {1: 60.0, 2: 40.0}
    built = view._build_weights()
    assert built is not None
    weights, no_buy = built
    assert weights == {1: Decimal(60), 2: Decimal(40)}
    assert no_buy == set()


def test_preset_saved_reconstructs_category_targets() -> None:
    # A saved per-fund target loads back grouped by category, in category mode.
    view = _CalculatorView(
        _payload(
            _data(),
            active_weights={1: Decimal(60), 2: Decimal("30"), 3: Decimal(10)},
        )
    )
    # _preset_saved calls _render_builder at the end; stub it out so no UI runs.
    view._render_builder = lambda: None  # type: ignore[method-assign]
    view._preset_saved()
    assert view.mode == "category"
    assert view.cat_targets == {"US": 60.0, "International": 40.0}
    # Saved plan carried VEU too, so it stays ticked in International.
    assert view.cat_selected["International"] == {2, 3}
    assert view.cat_selected["US"] == {1}


def test_preset_saved_restores_no_buy_and_settings() -> None:
    # A saved target that marked VEU (id 3) no-buy and was built in USD with the
    # rebalance toggle on should reload with VEU un-ticked and those settings.
    view = _CalculatorView(
        _payload(
            _data(),
            active_weights={1: Decimal(60), 2: Decimal("30"), 3: Decimal(10)},
            active_no_buy={3},
            active_allow_sell=True,
            active_display_currency="USD",
        )
    )
    view._render_builder = lambda: None  # type: ignore[method-assign]
    view._render_summary = lambda: None  # type: ignore[method-assign]
    view._preset_saved()
    # VEU still counts toward the 40 % International target but is un-ticked.
    assert view.cat_targets == {"US": 60.0, "International": 40.0}
    assert view.cat_selected["International"] == {2}
    assert view.cat_selected["US"] == {1}
    # Settings round-trip.
    assert view.allow_sell is True
    assert view.display_ccy == "USD"
