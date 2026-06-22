"""Unit tests for the Daily Growth caption builder."""

from __future__ import annotations

from datetime import date, datetime
from zoneinfo import ZoneInfo

from investment_dashboard.services.daily_growth_view import build_daily_growth_caption

NY = ZoneInfo("America/New_York")
TODAY = date(2024, 6, 24)  # a Monday


def _caption(**overrides):  # type: ignore[no-untyped-def]
    kwargs = {
        "last_date": TODAY,
        "display_ccy": "EUR",
        "today": TODAY,
        "now": datetime(2024, 6, 24, 15, 42, tzinfo=NY),
        "tz": NY,
        "market_open": True,
    }
    kwargs.update(overrides)
    return build_daily_growth_caption(**kwargs)


def test_no_data_degrades_cleanly() -> None:
    cap = _caption(last_date=None)
    assert cap.as_of_text == "awaiting two priced days"
    assert cap.is_live is False
    assert cap.combined() == "awaiting two priced days"


def test_market_open_is_time_stamped_and_live() -> None:
    cap = _caption()
    assert cap.is_live is True
    assert cap.as_of_text == "as of 15:42"
    # Tight caption: just the live flag, no exchange-rate detail.
    assert cap.combined() == "as of 15:42 \u00b7 live"


def test_market_open_but_no_today_print_is_not_live() -> None:
    # We have an older last print even though the session is technically open.
    cap = _caption(last_date=date(2024, 6, 21), market_open=True)
    assert cap.is_live is False
    assert cap.as_of_text == "as of Fri 21 Jun"


def test_closed_today_reads_as_today() -> None:
    cap = _caption(market_open=False)
    assert cap.is_live is False
    assert cap.as_of_text == "as of today"
    # Not live -> no trailing flag and no FX detail.
    assert cap.combined() == "as of today"


def test_closed_past_date_is_formatted() -> None:
    cap = _caption(last_date=date(2024, 6, 20), market_open=False)
    assert cap.as_of_text == "as of Thu 20 Jun"


def test_combined_appends_live_only_when_live() -> None:
    live = _caption()
    assert live.combined().endswith(" \u00b7 live")
    closed = _caption(market_open=False)
    assert "live" not in closed.combined()
