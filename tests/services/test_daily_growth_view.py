"""Unit tests for the Daily Growth caption builder."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from investment_dashboard.services.daily_growth_view import build_daily_growth_caption

NY = ZoneInfo("America/New_York")
TODAY = date(2024, 6, 24)  # a Monday


def _caption(**overrides):  # type: ignore[no-untyped-def]
    kwargs = {
        "last_date": TODAY,
        "prev_date": date(2024, 6, 21),
        "eur_usd_last": Decimal("1.08"),
        "eur_usd_prev": Decimal("1.07"),
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
    assert cap.fx_text is None
    assert cap.is_live is False


def test_market_open_is_time_stamped_and_live() -> None:
    cap = _caption()
    assert cap.is_live is True
    assert cap.as_of_text == "as of 15:42"
    assert cap.fx_text is not None
    assert "live FX" in cap.fx_text


def test_market_open_but_no_today_print_is_not_live() -> None:
    # We have an older last print even though the session is technically open.
    cap = _caption(last_date=date(2024, 6, 21), market_open=True)
    assert cap.is_live is False
    assert cap.as_of_text == "as of Fri 21 Jun"


def test_closed_today_reads_as_today() -> None:
    cap = _caption(market_open=False)
    assert cap.is_live is False
    assert cap.as_of_text == "as of today"
    assert cap.fx_text is not None
    assert "end-of-day FX" in cap.fx_text


def test_closed_past_date_is_formatted() -> None:
    cap = _caption(last_date=date(2024, 6, 20), market_open=False)
    assert cap.as_of_text == "as of Thu 20 Jun"


def test_eur_user_quotes_usd_in_eur() -> None:
    cap = _caption(display_ccy="EUR")
    assert cap.fx_text is not None
    # 1 USD = 1/1.08 = 0.9259 EUR, rising vs 1/1.07 = 0.9346 → a fall.
    assert cap.fx_text.startswith("1 USD = 0.9259 EUR")
    assert "\u2212" in cap.fx_text  # proper minus: USD got cheaper in EUR


def test_usd_user_quotes_eur_in_usd() -> None:
    cap = _caption(display_ccy="USD")
    assert cap.fx_text is not None
    # 1 EUR = 1.08 USD, up from 1.07 → positive change.
    assert cap.fx_text.startswith("1 EUR = 1.0800 USD")
    assert "+" in cap.fx_text


def test_missing_prev_rate_omits_change() -> None:
    cap = _caption(eur_usd_prev=None, display_ccy="USD")
    assert cap.fx_text is not None
    assert cap.fx_text.startswith("1 EUR = 1.0800 USD")
    assert "(" not in cap.fx_text  # no change parenthetical


def test_combined_joins_parts() -> None:
    cap = _caption(display_ccy="USD")
    combined = cap.combined()
    assert combined.startswith("as of 15:42 \u00b7 1 EUR = 1.0800 USD")
