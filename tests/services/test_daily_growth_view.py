"""Unit tests for the Daily Growth caption builder."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from investment_dashboard.services.daily_growth_view import build_daily_growth_caption

NY = ZoneInfo("America/New_York")
CET = ZoneInfo("Europe/Berlin")
TODAY = date(2024, 6, 24)  # a Monday


def _caption(**overrides):  # type: ignore[no-untyped-def]
    kwargs = {
        "last_date": TODAY,
        "fx_eur_usd": Decimal("1.08"),
        "display_ccy": "EUR",
        "today": TODAY,
        "tz": NY,
        "market_open": True,
    }
    kwargs.update(overrides)
    return build_daily_growth_caption(**kwargs)


def test_no_data_degrades_cleanly() -> None:
    cap = _caption(last_date=None)
    assert cap.as_of_text == "awaiting two priced days"
    assert cap.fx_text is None
    assert cap.is_live is False
    assert cap.combined() == "awaiting two priced days"


def test_live_says_live_only() -> None:
    cap = _caption()
    assert cap.is_live is True
    # Live: the single state word "live", no "today" and no clock; FX trails.
    assert cap.as_of_text == "live"
    assert cap.updated_text is None
    assert cap.combined() == "live \u00b7 \u20ac1\u2248$1.0800"


def test_today_closed_says_today_and_stamps_the_market_close_time() -> None:
    # Settled, but today's close is in: lead with "today"; stamp when the price
    # is from (the regular-session close, 16:00 ET -> the display timezone).
    cap = _caption(market_open=False)
    assert cap.is_live is False
    assert cap.as_of_text == "today"
    assert cap.updated_text == "as of 16:00"
    assert "live" not in cap.combined()


def test_today_closed_close_time_is_in_display_timezone() -> None:
    # A CET user reads the 16:00 ET close as their local 22:00.
    cap = _caption(market_open=False, tz=CET)
    assert cap.as_of_text == "today"
    assert cap.updated_text == "as of 22:00"


def test_today_closed_stamps_the_provider_pull_time() -> None:
    # Settled, but today's close is in: stamp when the price is from — the
    # moment we last pulled it from the provider (a naive UTC instant), shown
    # in the display timezone.
    pulled = datetime(2024, 6, 24, 20, 7)  # 20:07 UTC == 16:07 ET (EDT)
    cap = _caption(market_open=False, price_observed_at=pulled)
    assert cap.is_live is False
    assert cap.as_of_text == "today"
    assert cap.updated_text == "as of 16:07"
    assert "live" not in cap.combined()


def test_today_closed_pull_time_is_in_display_timezone() -> None:
    # A CET user reads the same 20:07 UTC pull as their local 22:07.
    pulled = datetime(2024, 6, 24, 20, 7)
    cap = _caption(market_open=False, tz=CET, price_observed_at=pulled)
    assert cap.as_of_text == "today"
    assert cap.updated_text == "as of 22:07"


def test_today_closed_falls_back_to_session_close_without_pull_time() -> None:
    # No saved pull time -> fall back to the modelled regular-session close.
    cap = _caption(market_open=False, price_observed_at=None)
    assert cap.as_of_text == "today"
    assert cap.updated_text == "as of 16:00"


def test_live_ignores_pull_time_and_says_live() -> None:
    pulled = datetime(2024, 6, 24, 19, 30)
    cap = _caption(price_observed_at=pulled)
    assert cap.is_live is True
    assert cap.as_of_text == "live"
    assert cap.updated_text is None


def test_today_closed_prefers_market_time_and_trails_pull_time() -> None:
    # Settled, today's close is in: lead with "today", dated by the *exchange*
    # market time (when the price is from), with our pull instant trailing as
    # "updated".
    market = datetime(2024, 6, 24, 19, 59)  # 19:59 UTC == 21:59 CET
    pulled = datetime(2024, 6, 24, 20, 16)  # 20:16 UTC == 22:16 CET
    cap = _caption(market_open=False, tz=CET, price_market_at=market, price_observed_at=pulled)
    assert cap.is_live is False
    assert cap.as_of_text == "today"
    assert cap.updated_text == "as of 21:59 \u00b7 updated 22:16"
    assert (
        cap.combined()
        == "today \u00b7 as of 21:59 \u00b7 updated 22:16 \u00b7 \u20ac1\u2248$1.0800"
    )


def test_today_closed_market_time_without_pull_time_has_no_updated() -> None:
    market = datetime(2024, 6, 24, 19, 59)
    cap = _caption(market_open=False, tz=CET, price_market_at=market, price_observed_at=None)
    assert cap.as_of_text == "today"
    assert cap.updated_text == "as of 21:59"
    assert "updated" not in cap.combined()


def test_today_closed_falls_back_to_pull_time_without_market_time() -> None:
    # No provider market time -> date by the pull instant, with no separate
    # "updated" stamp (it would echo the "as of").
    pulled = datetime(2024, 6, 24, 20, 7)
    cap = _caption(market_open=False, tz=CET, price_market_at=None, price_observed_at=pulled)
    assert cap.as_of_text == "today"
    assert cap.updated_text == "as of 22:07"


def test_live_ignores_market_time_and_says_live() -> None:
    market = datetime(2024, 6, 24, 15, 59)
    cap = _caption(price_market_at=market, price_observed_at=datetime(2024, 6, 24, 16, 1))
    assert cap.is_live is True
    assert cap.as_of_text == "live"
    assert cap.updated_text is None


def test_market_open_but_no_today_print_is_not_live() -> None:
    # We have an older last print even though the session is technically open.
    cap = _caption(last_date=date(2024, 6, 21), market_open=True)
    assert cap.is_live is False
    assert cap.as_of_text == "as of Fri 21 Jun"


def test_closed_past_date_is_formatted() -> None:
    cap = _caption(last_date=date(2024, 6, 20), market_open=False)
    assert cap.as_of_text == "as of Thu 20 Jun"


def test_fx_detail_is_tight_and_display_relative() -> None:
    # No comparison mark -> spot only, no percentage move.
    # EUR user sees how much USD one euro buys (the rate as-is)…
    eur = _caption()
    assert eur.fx_text == "\u20ac1\u2248$1.0800"
    # …USD user sees how much EUR one dollar buys (the inverse).
    usd = _caption(display_ccy="USD")
    assert usd.fx_text == "$1\u2248\u20ac0.9259"


def test_fx_detail_appends_percentage_move_versus_prior_day() -> None:
    # USD user reads the inverse rate (€ per $), so a rising EUR shows as a
    # falling figure with a proper minus glyph and no absolute number.
    usd = _caption(display_ccy="USD", fx_eur_usd=Decimal("1.08"), fx_eur_usd_prev=Decimal("1.07"))
    assert usd.fx_text == "$1\u2248\u20ac0.9259 (\u22120.93%)"
    # EUR user reads the rate as-is ($ per €): EUR rose 1.0700 → 1.0800 → +0.93%.
    eur = _caption(fx_eur_usd=Decimal("1.08"), fx_eur_usd_prev=Decimal("1.07"))
    assert eur.fx_text == "\u20ac1\u2248$1.0800 (+0.93%)"


def test_fx_percentage_omitted_without_prior_mark() -> None:
    assert "%" not in (_caption(fx_eur_usd_prev=None).fx_text or "")
    assert "%" not in (_caption(fx_eur_usd_prev=Decimal("0")).fx_text or "")


def test_fx_detail_omitted_when_no_mark() -> None:
    cap = _caption(fx_eur_usd=None)
    assert cap.fx_text is None
    assert cap.combined() == "live"
    # A zero/negative mark is treated as missing, too.
    assert _caption(fx_eur_usd=Decimal("0")).fx_text is None


def test_combined_leads_with_live_only_when_live() -> None:
    live = _caption()
    assert live.combined().startswith("live \u00b7 ")
    closed = _caption(market_open=False)
    assert "live" not in closed.combined()
    assert closed.combined().startswith("today \u00b7 ")
