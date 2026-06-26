"""Tests for the Overview standalone "Currency · EUR ↔ USD" box HTML.

Exercises the three behaviours the box guarantees regardless of display currency:

* the "Currency effect today" panel always speaks **EUR** (no USD "$0 + long
  text" branch);
* a third stat shows the FX move **since the session open** while the market is
  live and **since the close** once it has shut;
* the market-hours / overnight split is reordered so the *currently-live* leg is
  on top — market hours while open, overnight once shut — and the frozen "last"
  leg survives below it.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from types import SimpleNamespace

from sqlalchemy.orm import Session

from investment_dashboard.repositories import intraday_repo
from investment_dashboard.ui.pages.overview import _currency_box_html

# 2024-06-03 is a Monday. 20:00 UTC = 16:00 ET (market just closed); 15:00 UTC =
# 11:00 ET (market open). Two intraday FX samples bracket the session: the open
# anchor (1.00) and the close anchor (1.25).
_CLOSED = datetime(2024, 6, 3, 20, 0, tzinfo=UTC)
_OPEN = datetime(2024, 6, 3, 15, 0, tzinfo=UTC)


def _seed_fx_samples(session: Session) -> None:
    intraday_repo.insert_sample(
        session, datetime(2024, 6, 3, 13, 30), Decimal("1000.00"), fx_eur_usd=Decimal("1.00")
    )
    intraday_repo.insert_sample(
        session, datetime(2024, 6, 3, 14, 0), Decimal("800.00"), fx_eur_usd=Decimal("1.25")
    )
    session.flush()


def _metrics() -> SimpleNamespace:
    # Live 1.30, prior settle 1.20, USD book $130,000. net EUR FX move today =
    # 130000/1.30 − 130000/1.20 = −€8,333.33 (a non-zero swing ⇒ effect shown).
    return SimpleNamespace(
        daily_growth_fx_eur_usd=Decimal("1.30"),
        daily_growth_fx_eur_usd_prev=Decimal("1.20"),
        total_value_usd=Decimal("130000"),
    )


class TestCurrencyEffectAlwaysEur:
    def test_usd_display_shows_eur_effect_not_dollar_zero(self, session: Session) -> None:
        _seed_fx_samples(session)
        html = _currency_box_html(session, _metrics(), display_ccy="USD", now=_CLOSED)
        assert html is not None
        assert "Currency effect today" in html
        # The old USD branch ("$0" + "priced in dollars …") must be gone.
        assert "$0" not in html
        assert "priced in dollars" not in html
        # The genuine EUR P/L figure is shown instead.
        assert "inv-fx-effect-net" in html
        assert "\u20ac" in html  # a euro figure is present

    def test_eur_and_usd_display_show_the_same_effect_figure(self, session: Session) -> None:
        _seed_fx_samples(session)
        eur_html = _currency_box_html(session, _metrics(), display_ccy="EUR", now=_CLOSED)
        usd_html = _currency_box_html(session, _metrics(), display_ccy="USD", now=_CLOSED)
        assert eur_html is not None
        assert usd_html is not None
        # Both carry the same euro net-effect span — the effect no longer depends
        # on the display currency.
        assert eur_html.count("inv-fx-effect-net") == usd_html.count("inv-fx-effect-net") == 1


class TestThirdStat:
    def test_closed_market_shows_since_close(self, session: Session) -> None:
        _seed_fx_samples(session)
        html = _currency_box_html(session, _metrics(), display_ccy="EUR", now=_CLOSED)
        assert html is not None
        assert "Since close" in html
        assert "Since open" not in html

    def test_open_market_shows_since_open(self, session: Session) -> None:
        _seed_fx_samples(session)
        html = _currency_box_html(session, _metrics(), display_ccy="EUR", now=_OPEN)
        assert html is not None
        assert "Since open" in html
        assert "Since close" not in html


class TestSplitOrdering:
    def test_closed_market_puts_live_overnight_on_top(self, session: Session) -> None:
        _seed_fx_samples(session)
        html = _currency_box_html(session, _metrics(), display_ccy="EUR", now=_CLOSED)
        assert html is not None
        # Both legs render, with the live overnight leg above the last market-hours leg.
        assert "Overnight" in html
        assert "Market hours" in html
        assert html.index("Overnight") < html.index("Market hours")
        # The live/last affordance is present.
        assert ">live<" in html
        assert ">last<" in html

    def test_open_market_puts_live_market_hours_on_top_and_keeps_overnight(
        self, session: Session
    ) -> None:
        _seed_fx_samples(session)
        html = _currency_box_html(session, _metrics(), display_ccy="EUR", now=_OPEN)
        assert html is not None
        # The overnight slice survives the market start (it is not dropped) but now
        # sits *below* the live market-hours leg.
        assert "Market hours" in html
        assert "Overnight" in html
        assert html.index("Market hours") < html.index("Overnight")
        assert ">live<" in html
        assert ">last<" in html
