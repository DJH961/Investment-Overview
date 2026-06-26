"""Tests for the Overview standalone "Currency · EUR ↔ USD" box HTML.

Exercises the three behaviours the box guarantees regardless of display currency:

* the "Currency effect since yesterday" panel always speaks **EUR** (no USD "$0 +
  long text" branch);
* the "Today" stat re-bases by market state (since the prior close while open,
  since *this* session's open once a trading day has shut) so it never mirrors the
  "Since open/close" stat;
* a third stat shows the FX move **since the session open** while the market is
  live and **since the close** once it has shut;
* the market-hours / overnight split is reordered so the *currently-live* leg is
  on top — market hours while open, overnight once shut — and the frozen "last"
  leg survives below it;
* on a non-market day the split collapses to a single "Market holiday" bar.
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
        assert "Currency effect since yesterday" in html
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


# 2024-06-07 is a Friday. Seed that session so the weekend "frozen Friday" view
# has genuine open/close FX anchors to freeze to (the weekend `now` resolves its
# session back to this Friday via ``last_session_date``). 13:30 UTC = 09:30 ET
# (open anchor, 1.00); 19:30 UTC = 15:30 ET (close anchor, 1.25).
def _seed_friday_fx_samples(session: Session) -> None:
    intraday_repo.insert_sample(
        session, datetime(2024, 6, 7, 13, 30), Decimal("1000.00"), fx_eur_usd=Decimal("1.00")
    )
    intraday_repo.insert_sample(
        session, datetime(2024, 6, 7, 19, 30), Decimal("800.00"), fx_eur_usd=Decimal("1.25")
    )
    session.flush()


# Weekend forex-close instants (all resolve their session back to Friday 06-07).
# Forex shuts Fri 17:00 ET (21:00 UTC EDT) and reopens Sun 17:00 ET (21:00 UTC).
_FRI_AFTER_CLOSE = datetime(2024, 6, 7, 21, 30, tzinfo=UTC)  # Fri 17:30 ET
_SATURDAY = datetime(2024, 6, 8, 15, 0, tzinfo=UTC)  # Sat 11:00 ET
_SUNDAY_MORNING = datetime(2024, 6, 9, 14, 0, tzinfo=UTC)  # Sun 10:00 ET (forex still shut)
_SUNDAY_EVENING = datetime(2024, 6, 9, 22, 0, tzinfo=UTC)  # Sun 18:00 ET (forex reopened)
_MONDAY_PREOPEN = datetime(2024, 6, 10, 12, 0, tzinfo=UTC)  # Mon 08:00 ET (before 09:30 open)

# 2024-07-04 (Thursday) is Independence Day: a US market holiday that is *not* an
# FX holiday, so forex trades while the NYSE is shut. 15:00 UTC = 11:00 ET.
_US_HOLIDAY = datetime(2024, 7, 4, 15, 0, tzinfo=UTC)


class TestTodayStatRebases:
    """The "Today" stat must not just mirror the "Since open/close" stat: it uses
    a market-state-dependent baseline (prior close while open, *this* session's
    open once a trading day has shut)."""

    def test_open_market_today_is_since_last_close(self, session: Session) -> None:
        _seed_fx_samples(session)
        html = _currency_box_html(session, _metrics(), display_ccy="EUR", now=_OPEN)
        assert html is not None
        assert "since last close" in html
        assert "since last open" not in html

    def test_closed_trading_day_today_is_since_last_open(self, session: Session) -> None:
        _seed_fx_samples(session)
        html = _currency_box_html(session, _metrics(), display_ccy="EUR", now=_CLOSED)
        assert html is not None
        # Closed on a trading day re-bases "Today" to this morning's open …
        assert "since last open" in html
        assert "since last close" not in html
        # … which is genuinely different from the "Since close" third stat, so the
        # two percentage values are no longer identical.
        assert "Since close" in html


class TestForexWeekendFreeze:
    """Over the spot-FX weekend close (Fri 17:00 ET → Sun 17:00 ET) the box freezes
    to the *whole Friday session view*, badged "Market closed", exactly as it looked
    at 17:01 ET — Saturday and Sunday morning must look like Friday after close, not
    like a "Market holiday"."""

    def test_friday_after_close_is_frozen_session_view(self, session: Session) -> None:
        _seed_friday_fx_samples(session)
        html = _currency_box_html(session, _metrics(), display_ccy="EUR", now=_FRI_AFTER_CLOSE)
        assert html is not None
        # Badged closed, with the "frozen / reopens" caption.
        assert "Market closed" in html
        assert "inv-fx-box-closed" in html
        assert "Frozen at Friday" in html
        assert "reopens" in html
        # The full Friday session view survives: the "Since close" third stat and
        # the two-leg split — and it is NOT relabelled a holiday.
        assert "Since close" in html
        assert "Market hours" in html
        assert "Overnight" in html
        assert "Market holiday" not in html

    def test_saturday_looks_like_friday_after_close(self, session: Session) -> None:
        _seed_friday_fx_samples(session)
        html = _currency_box_html(session, _metrics(), display_ccy="EUR", now=_SATURDAY)
        assert html is not None
        assert "Market closed" in html
        assert "Since close" in html
        assert "Market hours" in html
        # The old behaviour (Saturday => "Market holiday") is gone.
        assert "Market holiday" not in html

    def test_sunday_morning_still_frozen(self, session: Session) -> None:
        _seed_friday_fx_samples(session)
        html = _currency_box_html(session, _metrics(), display_ccy="EUR", now=_SUNDAY_MORNING)
        assert html is not None
        assert "Market closed" in html
        assert "Market holiday" not in html


class TestWeekendOvernight:
    """Once forex reopens Sunday 17:00 ET but no US session has opened yet (Sunday
    evening through Monday's 09:30 open), the only honest move is the single overnight
    drift since Friday's close: one number, no second stat, no two-leg split, and no
    "Market closed" badge."""

    def test_sunday_evening_is_single_overnight(self, session: Session) -> None:
        _seed_friday_fx_samples(session)
        html = _currency_box_html(session, _metrics(), display_ccy="EUR", now=_SUNDAY_EVENING)
        assert html is not None
        # Forex is live again: no "closed" badge.
        assert "Market closed" not in html
        # A single "Overnight" bar, not the two-leg split, and not a holiday.
        assert "Overnight" in html
        assert "Market hours" not in html
        assert "Market holiday" not in html
        # The third "Since open/close" stat is dropped (clean two-stat row).
        assert "Since close" not in html
        assert "Since open" not in html
        assert "inv-fx-box-stats-pair" in html
        assert "overnight" in html

    def test_monday_preopen_is_single_overnight(self, session: Session) -> None:
        _seed_friday_fx_samples(session)
        html = _currency_box_html(session, _metrics(), display_ccy="EUR", now=_MONDAY_PREOPEN)
        assert html is not None
        assert "Market closed" not in html
        assert "Overnight" in html
        assert "Market hours" not in html
        assert "inv-fx-box-stats-pair" in html


class TestUsMarketHoliday:
    """A US market holiday that is *not* an FX holiday (e.g. 4th of July) keeps the
    "Market holiday" wording: forex trades, the NYSE is shut, so it is a single
    overnight number — but labelled as the holiday, not a weekend overnight."""

    def test_july_fourth_keeps_market_holiday_wording(self, session: Session) -> None:
        _seed_fx_samples(session)
        html = _currency_box_html(session, _metrics(), display_ccy="EUR", now=_US_HOLIDAY)
        assert html is not None
        # The single-bar overnight view, kept under the "Market holiday" label.
        assert "Market holiday" in html
        assert "Market hours" not in html
        assert "Overnight" not in html
        # Forex is open on a US holiday: no weekend "Market closed" badge.
        assert "Market closed" not in html
        # "Today" is the pure overnight drift, and the third stat is dropped.
        assert "overnight" in html
        assert "Since close" not in html
        assert "Since open" not in html
        assert "inv-fx-box-stats-pair" in html
