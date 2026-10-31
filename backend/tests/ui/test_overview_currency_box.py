"""Tests for the Overview standalone "Currency · EUR ↔ USD" box HTML.

Exercises the behaviours the box guarantees:

* the currency panel reframes by display currency — **EUR** display shows the
  book's "Currency effect since yesterday" (always in EUR), **USD** display shows
  "Investing power since yesterday" (the dollars the owner's regular EUR
  investment buys now vs yesterday's close), because the portfolio FX effect is
  exactly $0 in dollars;
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

from datetime import UTC, date, datetime, timezone
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


class TestCurrencyPanelByDisplay:
    """The currency panel reframes by display currency: EUR shows the book's EUR
    currency effect; USD shows the *investing power* of the owner's regular EUR
    investment (the dollars it buys now vs yesterday's close), because the
    portfolio FX effect is exactly $0 in dollars."""

    def test_eur_display_shows_eur_currency_effect(self, session: Session) -> None:
        _seed_fx_samples(session)
        html = _currency_box_html(session, _metrics(), display_ccy="EUR", now=_CLOSED)
        assert html is not None
        assert "Currency effect since yesterday" in html
        assert "Investing power since yesterday" not in html
        assert "inv-fx-effect-net" in html
        assert "\u20ac" in html  # a euro figure is present

    def test_usd_display_shows_investing_power_not_zero(self, session: Session) -> None:
        _seed_fx_samples(session)
        html = _currency_box_html(session, _metrics(), display_ccy="USD", now=_CLOSED)
        assert html is not None
        # USD reframes to investing power, not the EUR currency effect …
        assert "Investing power since yesterday" in html
        assert "Currency effect since yesterday" not in html
        # … and never the old misleading "$0".
        assert "$0" not in html
        assert "priced in dollars" not in html
        # The regular EUR amount buys more dollars now than at *yesterday's open* —
        # the panel is re-anchored to the session open in the (plain weekday) closed
        # regime so it agrees with the headline's "since last open" stat rather than
        # the settled previous close. With the default €100 and the seeded open
        # anchor of 1.00: 100·(1.30−1.00) = +$30.00. The panel mirrors the EUR
        # currency-effect visualisation exactly (no explanatory note), keeping cents
        # because the swing is two digits or less.
        assert "inv-fx-effect-net" in html
        assert "+$30.00" in html
        assert "inv-fx-effect-note" not in html
        assert "now buys" not in html
        # The configured regular amount (default €100) and the dollars it buys at
        # today's live 1.30 rate (100·1.30 = $130.00) are both shown so the swing
        # has a visible base.
        assert "inv-fx-effect-amount" in html
        assert "Regular \u20ac100" in html
        assert "$130.00 today" in html

    def test_eur_and_usd_panels_differ(self, session: Session) -> None:
        _seed_fx_samples(session)
        eur_html = _currency_box_html(session, _metrics(), display_ccy="EUR", now=_CLOSED)
        usd_html = _currency_box_html(session, _metrics(), display_ccy="USD", now=_CLOSED)
        assert eur_html is not None
        assert usd_html is not None
        # The panel now genuinely depends on the display currency.
        assert "Currency effect since yesterday" in eur_html
        assert "Investing power since yesterday" in usd_html


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


class TestClosedWeekdayReanchorsToSessionOpen:
    """On a regular weekday after the close the headline "Today" stat reads "since
    last open", so the currency-effect panel total must be anchored to that same
    session **open** — not the settled previous close — or the money figure and the
    headline disagree in scale and even in sign (the disconnect this fixes). The
    re-anchoring also makes the frozen "Market hours" leg the real last-session
    open→close move rather than a near-zero prior-close→close residual.

    Seed: open anchor 1.00, close anchor 1.25; metrics live 1.30, prev settle 1.20,
    USD book $130,000. Anchored to the open the net is 130000/1.30 − 130000/1.00 =
    −€30,000, split into overnight (close→now) 130000/1.30 − 130000/1.25 = −€4,000
    and market hours (open→close) the −€26,000 remainder. Anchored to the settled
    prev close it would instead read −€8,333.33 with a tiny −€4,333.33 market-hours
    residual — the buggy figures, which must be absent.
    """

    def test_eur_effect_total_is_session_open_anchored(self, session: Session) -> None:
        _seed_fx_samples(session)
        html = _currency_box_html(session, _metrics(), display_ccy="EUR", now=_CLOSED)
        assert html is not None
        assert "\u2212\u20ac30,000.00" in html  # session-open anchored net
        assert "8,333" not in html  # not the settled-prev-close anchor

    def test_market_hours_leg_is_the_real_open_to_close_move(self, session: Session) -> None:
        _seed_fx_samples(session)
        html = _currency_box_html(session, _metrics(), display_ccy="EUR", now=_CLOSED)
        assert html is not None
        assert "\u2212\u20ac26,000.00" in html  # genuine open→close market-hours move
        assert "\u2212\u20ac4,000.00" in html  # live overnight (close→now) leg
        assert "4,333" not in html  # not the near-zero prev-close→close residual

    def test_investing_power_is_session_open_anchored(self, session: Session) -> None:
        _seed_fx_samples(session)
        html = _currency_box_html(session, _metrics(), display_ccy="USD", now=_CLOSED)
        assert html is not None
        # Default €100 · (1.30 − 1.00 open) = +$30.00, not the +$10.00 the settled
        # prev-close (1.20) anchor would give.
        assert "+$30.00" in html
        assert "+$10.00" not in html


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
    evening through Monday's 09:30 open), the spot-FX weekend close is treated as a
    *pause*: Friday's session stays the previous session, so the box keeps the whole
    Friday session view — the two-leg split (Friday's market-hours leg + the live
    overnight drift since its close), the "Since close" stat — with no "Market closed"
    badge (forex is live again)."""

    def test_sunday_evening_keeps_the_friday_session_view(self, session: Session) -> None:
        _seed_friday_fx_samples(session)
        html = _currency_box_html(session, _metrics(), display_ccy="EUR", now=_SUNDAY_EVENING)
        assert html is not None
        # Forex is live again: no "closed" badge.
        assert "Market closed" not in html
        # Friday stays the previous session: the two-leg split survives (it is not a
        # single-overnight collapse, and not a holiday).
        assert "Market hours" in html
        assert "Overnight" in html
        assert "Market holiday" not in html
        # Live overnight drift on top, Friday's frozen market-hours leg below.
        assert html.index("Overnight") < html.index("Market hours")
        assert ">live<" in html
        assert ">last<" in html
        # The third "Since close" stat is kept (full three-stat session view).
        assert "Since close" in html
        assert "since last open" in html
        assert "inv-fx-box-stats-pair" not in html

    def test_monday_preopen_keeps_the_friday_session_view(self, session: Session) -> None:
        _seed_friday_fx_samples(session)
        html = _currency_box_html(session, _metrics(), display_ccy="EUR", now=_MONDAY_PREOPEN)
        assert html is not None
        assert "Market closed" not in html
        assert "Market hours" in html
        assert "Overnight" in html
        assert "Since close" in html
        assert "inv-fx-box-stats-pair" not in html


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

    def test_july_fourth_investing_power_single_bar_in_usd(self, session: Session) -> None:
        _seed_fx_samples(session)
        html = _currency_box_html(session, _metrics(), display_ccy="USD", now=_US_HOLIDAY)
        assert html is not None
        # USD reframes to investing power, still a single "Market holiday" bar (no
        # fresh session to split) carrying the whole +$10.00 buying-power swing.
        assert "Investing power since yesterday" in html
        assert "Market holiday" in html
        assert "Market hours" not in html
        assert "+$10.00" in html


class TestHorizontalLayout:
    """The box lays out horizontally: a two-column body with the rate stats on the
    left (``inv-fx-box-main``) and the currency-effect / investing-power panel on
    the right, so it fills the full width instead of stacking into a tall column."""

    def test_body_is_two_column_when_effect_present(self, session: Session) -> None:
        _seed_fx_samples(session)
        html = _currency_box_html(session, _metrics(), display_ccy="EUR", now=_CLOSED)
        assert html is not None
        assert "inv-fx-box-body" in html
        assert "inv-fx-box-main" in html
        # With an effect panel the body is the full two-column layout (not the
        # single-column fallback).
        assert "inv-fx-box-body-single" not in html
        # The stats (left) precede the effect panel (right) in source order.
        assert html.index("inv-fx-box-main") < html.index("inv-fx-effect")

    def test_body_single_column_when_no_effect(self, session: Session) -> None:
        # No USD book value ⇒ no effect panel ⇒ the body stays full-width single
        # column rather than reserving an empty right-hand column.
        _seed_fx_samples(session)
        metrics = SimpleNamespace(
            daily_growth_fx_eur_usd=Decimal("1.30"),
            daily_growth_fx_eur_usd_prev=Decimal("1.20"),
            total_value_usd=None,
        )
        html = _currency_box_html(session, metrics, display_ccy="EUR", now=_CLOSED)
        assert html is not None
        assert "inv-fx-box-body-single" in html
        assert "inv-fx-effect" not in html


class TestDivergeTagPlacement:
    """The live/last/paused tag rides under the value in a right-hand value cell
    (``inv-fx-diverge-valcell``), never inline with the status label — so a long
    status word ("Market hours") can't be pushed onto a second line by the tag."""

    def test_tag_in_value_cell_not_in_label(self, session: Session) -> None:
        _seed_fx_samples(session)
        html = _currency_box_html(session, _metrics(), display_ccy="EUR", now=_CLOSED)
        assert html is not None
        assert "inv-fx-diverge-valcell" in html
        # The tag follows the value inside the value cell, not the label span.
        assert "inv-fx-diverge-value" in html
        assert html.index("inv-fx-diverge-value") < html.index("inv-fx-diverge-tag")


class TestRegimeAwareTitles:
    """The currency-effect / investing-power panel titles name the real reference
    they measure against, mirroring the web companion's ``effectSincePhrase``."""

    def test_weekend_overnight_title_says_since_friday(self, session: Session) -> None:
        _seed_friday_fx_samples(session)
        html = _currency_box_html(session, _metrics(), display_ccy="EUR", now=_SUNDAY_EVENING)
        assert html is not None
        # Friday stays the previous session (the weekend close is a pause) ⇒ the
        # currency effect is named "since Friday".
        assert "Currency effect since Friday" in html
        assert "Currency effect since yesterday" not in html

    def test_frozen_weekend_title_and_today_label_name_the_settled_day(
        self, session: Session
    ) -> None:
        _seed_friday_fx_samples(session)
        html = _currency_box_html(session, _metrics(), display_ccy="EUR", now=_SUNDAY_MORNING)
        assert html is not None
        # Sunday looking back at Friday: the effect is "on Friday", and the "Today"
        # stat is relabelled to the settled weekday rather than reading "Today".
        assert "Currency effect on Friday" in html
        assert ">Friday<" in html


class TestPausedTag:
    """While spot FX is frozen at the weekend close the leading leg is tagged
    "paused", never "live" — it is not trading."""

    def test_frozen_weekend_leading_leg_is_paused(self, session: Session) -> None:
        _seed_friday_fx_samples(session)
        html = _currency_box_html(session, _metrics(), display_ccy="EUR", now=_SATURDAY)
        assert html is not None
        assert ">paused<" in html
        assert ">live<" not in html
        # The frozen "last" leg still survives below.
        assert ">last<" in html


class TestAsOfStamp:
    """The rate stat carries an honest "as of …" / "EOD FX" provenance stamp so the
    desktop is as transparent as the web companion about which day's EUR/USD rate
    it is showing (transparency / correctness)."""

    def test_eod_rate_stamps_as_of_date_and_eod_tag(self, session: Session) -> None:
        from investment_dashboard.repositories import fx_repo
        from investment_dashboard.services import fx_service

        fx_service.clear_live_spot()
        # A settled ECB fixing on Friday 2024-05-31; no live spot ⇒ the displayed
        # rate is the keyless end-of-day reference, so the box says so.
        fx_repo.upsert_rates(
            session, {date(2024, 5, 31): Decimal("1.0845")}, base="EUR", quote="USD"
        )
        session.flush()
        _seed_fx_samples(session)

        html = _currency_box_html(session, _metrics(), display_ccy="USD", now=_CLOSED)
        assert html is not None
        assert "inv-fx-box-asof" in html
        assert "as of 31 May 2024" in html
        assert ">EOD FX<" in html

    def test_live_spot_stamps_as_of_today_without_eod_tag(self, session: Session) -> None:
        from investment_dashboard.repositories import fx_repo
        from investment_dashboard.services import fx_service

        fx_service.clear_live_spot()
        today = _CLOSED.date()
        fx_repo.upsert_rates(session, {today: Decimal("1.30")}, base="EUR", quote="USD")
        session.flush()
        # A legacy spot without a capture instant falls back to the day label.
        fx_service.set_live_spot("USD", Decimal("1.30"), observed_on=today, observed_at=None)
        # Force the timestampless legacy shape (set_live_spot defaults to now()).
        fx_service._LIVE_SPOT["USD"] = fx_service.LiveSpot(
            observed_on=today, rate=Decimal("1.30"), observed_at=None
        )
        _seed_fx_samples(session)

        try:
            html = _currency_box_html(session, _metrics(), display_ccy="USD", now=_CLOSED)
        finally:
            fx_service.clear_live_spot()
        assert html is not None
        assert "as of Today" in html
        assert ">EOD FX<" not in html

    def test_live_spot_stamps_the_live_time(self, session: Session) -> None:
        from datetime import timedelta

        from investment_dashboard.repositories import fx_repo
        from investment_dashboard.services import fx_service

        fx_service.clear_live_spot()
        today = _CLOSED.date()
        fx_repo.upsert_rates(session, {today: Decimal("1.30")}, base="EUR", quote="USD")
        session.flush()
        # Observed at 18:42 UTC — the box stamps that live time, just like the web.
        observed = datetime(2024, 6, 3, 18, 42, tzinfo=UTC)
        fx_service.set_live_spot("USD", Decimal("1.30"), observed_on=today, observed_at=observed)
        _seed_fx_samples(session)

        try:
            html = _currency_box_html(session, _metrics(), display_ccy="USD", now=_CLOSED)
            # On a +2h viewer clock the same instant reads 20:42.
            html_tz = _currency_box_html(
                session,
                _metrics(),
                display_ccy="USD",
                now=_CLOSED,
                tz=timezone(timedelta(hours=2)),
            )
        finally:
            fx_service.clear_live_spot()
        assert html is not None
        assert html_tz is not None
        assert "as of 18:42" in html
        assert ">EOD FX<" not in html
        assert "as of 20:42" in html_tz
