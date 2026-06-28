"""Tests for the Holdings "Current FX" tile provenance label.

``_format_fx_as_of`` mirrors the Overview FX box's "as of …" / "EOD FX" stamp in
a single compact line, so the dedicated FX tile is just as transparent about
which day's EUR/USD rate it is showing.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta, timezone

from investment_dashboard.services.fx_service import FxAsOf
from investment_dashboard.ui.pages.holdings import _format_fx_as_of


def test_none_when_no_rate() -> None:
    assert _format_fx_as_of(None) is None


def test_live_spot_with_timestamp_reads_as_of_time() -> None:
    today = date(2024, 6, 3)
    observed = datetime(2024, 6, 3, 18, 42, tzinfo=UTC)
    info = FxAsOf(as_of=today, source="live", observed_at=observed)
    assert _format_fx_as_of(info, today=today) == "as of 18:42"
    # On a +2h viewer clock the same instant reads 20:42.
    assert _format_fx_as_of(info, today=today, tz=timezone(timedelta(hours=2))) == "as of 20:42"


def test_live_spot_without_timestamp_falls_back_to_today() -> None:
    today = date(2024, 6, 3)
    info = FxAsOf(as_of=today, source="live", observed_at=None)
    assert _format_fx_as_of(info, today=today) == "as of today"


def test_eod_same_day_is_tagged_eod_today() -> None:
    today = date(2024, 6, 3)
    label = _format_fx_as_of(FxAsOf(as_of=today, source="eod"), today=today)
    assert label == "EOD · today"


def test_eod_older_shows_settled_date() -> None:
    today = date(2024, 6, 3)
    friday = date(2024, 5, 31)
    label = _format_fx_as_of(FxAsOf(as_of=friday, source="eod"), today=today)
    assert label == "EOD · 31 May"
