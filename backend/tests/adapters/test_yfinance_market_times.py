"""yfinance adapter (7.3.1): the market time rides along with the chart answer.

The per-symbol chart requests run in parallel through ``Ticker.history``, so the
live tick no longer needs a serial ``Ticker.info`` round trip per symbol.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any

import pandas as pd
import pytest

from investment_dashboard.adapters import yfinance_client as yc
from investment_dashboard.adapters.yfinance_client import (
    fetch_closes,
    fetch_market_times,
)

#: 2024-01-04 20:26:40 UTC as epoch seconds (the chart ``meta.regularMarketTime``).
_MARKET_EPOCH = 1_704_400_000
_MARKET_TIME = datetime(2024, 1, 4, 20, 26, 40)


class _FakeTicker:
    """``yf.Ticker`` stand-in: a daily frame in exchange time plus the chart ``meta``."""

    def __init__(self, symbol: str) -> None:
        self.symbol = symbol
        self._price_history: Any = None

    def history(self, **_kwargs: Any) -> pd.DataFrame:
        if self.symbol == "BAD":
            raise RuntimeError("chart endpoint down")
        tz = "Europe/Berlin" if self.symbol.endswith(".DE") else "America/New_York"
        meta = {"regularMarketTime": _MARKET_EPOCH}
        self._price_history = type("PH", (), {"_history_metadata": meta})()
        if self.symbol == "EMPTY":
            return pd.DataFrame()
        idx = pd.DatetimeIndex(pd.to_datetime(["2024-01-02", "2024-01-03"])).tz_localize(tz)
        return pd.DataFrame({"Close": [10.0, 11.0]}, index=idx)


@pytest.fixture
def fake_ticker(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(yc.yf, "Ticker", _FakeTicker)


@pytest.mark.usefixtures("fake_ticker")
def test_closes_keep_local_dates_and_market_times() -> None:
    times: dict[str, datetime] = {}
    closes = fetch_closes(
        ["VTI", "EXS1.DE", "EMPTY"], date(2024, 1, 2), date(2024, 1, 4), market_times=times
    )
    # Different exchange time zones still line up on their own trading dates.
    assert closes["VTI"] == {date(2024, 1, 2): Decimal("10.0"), date(2024, 1, 3): Decimal("11.0")}
    assert closes["EXS1.DE"] == closes["VTI"]
    # The market time comes with the chart answer, even for a symbol with no bars.
    assert times == dict.fromkeys(["VTI", "EXS1.DE", "EMPTY"], _MARKET_TIME)


@pytest.mark.usefixtures("fake_ticker")
def test_one_failing_symbol_does_not_sink_the_batch() -> None:
    closes = fetch_closes(["BAD", "VTI"], date(2024, 1, 2), date(2024, 1, 4))
    assert closes["VTI"]
    assert closes["BAD"] == {}


@pytest.mark.usefixtures("fake_ticker")
def test_every_symbol_failing_is_an_empty_answer_like_yf_download() -> None:
    from investment_dashboard.services import provider_status

    provider_status.reset()
    assert fetch_closes(["BAD"], date(2024, 1, 2), date(2024, 1, 4)) == {"BAD": {}}
    event = provider_status.get_status("yfinance")
    assert event is not None
    assert event.status == "error"
    provider_status.reset()


def test_an_injected_downloader_leaves_market_times_alone() -> None:
    times: dict[str, datetime] = {}
    fetch_closes(
        ["VTI"],
        date(2024, 1, 2),
        date(2024, 1, 4),
        downloader=lambda **_k: pd.DataFrame(),
        market_times=times,
    )
    assert times == {}


def test_expected_gap_skips_the_wider_last_close_retry() -> None:
    windows: list[tuple[str, list[str]]] = []

    def fake_download(**kwargs: Any) -> pd.DataFrame:
        windows.append((kwargs["start"], list(kwargs["tickers"])))
        return pd.DataFrame()

    fetch_closes(
        ["VFIAX", "VTI"],
        date(2024, 1, 4),
        date(2024, 1, 5),
        downloader=fake_download,
        expected_gaps={"VFIAX"},
    )
    # Only VTI is retried over the wider window; the NAV fund is just waiting.
    assert windows == [("2024-01-04", ["VFIAX", "VTI"]), ("2023-12-26", ["VTI"])]


def test_market_times_only_quotes_symbols_without_a_known_time() -> None:
    asked: list[str] = []
    known = {"VTI": datetime(2024, 6, 24, 19, 59), "OTHER": datetime(2024, 1, 1)}

    def quoter(symbol: str) -> datetime:
        asked.append(symbol)
        return datetime(2024, 6, 24, 20, 0)

    out = fetch_market_times(["VTI", "VXUS"], known=known, quoter=quoter)
    assert asked == ["VXUS"]
    assert out == {"VTI": datetime(2024, 6, 24, 19, 59), "VXUS": datetime(2024, 6, 24, 20, 0)}
