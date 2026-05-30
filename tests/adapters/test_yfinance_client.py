"""Unit tests for the yfinance adapter, with the downloader monkey-patched."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

import pandas as pd
import pytest

from investment_dashboard.adapters.yfinance_client import (
    YFinanceError,
    fetch_closes,
)


def _multi_symbol_frame() -> pd.DataFrame:
    idx = pd.to_datetime(["2024-01-02", "2024-01-03", "2024-01-04"])
    cols = pd.MultiIndex.from_tuples(
        [
            ("VTI", "Close"),
            ("VTI", "Open"),
            ("VOO", "Close"),
            ("VOO", "Open"),
        ]
    )
    data = [
        [240.10, 239.0, 440.50, 439.0],
        [241.55, 240.5, 442.10, 440.0],
        [240.90, 241.0, 441.30, 441.5],
    ]
    return pd.DataFrame(data, index=idx, columns=cols)


def _single_symbol_frame() -> pd.DataFrame:
    idx = pd.to_datetime(["2024-01-02", "2024-01-03"])
    return pd.DataFrame({"Open": [240.0, 241.0], "Close": [240.10, 241.55]}, index=idx)


def test_fetch_closes_multi_symbol() -> None:
    def fake_download(**_: Any) -> pd.DataFrame:
        return _multi_symbol_frame()

    out = fetch_closes(["VTI", "VOO"], date(2024, 1, 2), date(2024, 1, 5), downloader=fake_download)

    assert set(out.keys()) == {"VTI", "VOO"}
    assert out["VTI"][date(2024, 1, 2)] == Decimal(repr(240.10))
    assert out["VOO"][date(2024, 1, 4)] == Decimal(repr(441.30))
    for sym in out:
        for value in out[sym].values():
            assert isinstance(value, Decimal)


def test_fetch_closes_single_symbol() -> None:
    def fake_download(**_: Any) -> pd.DataFrame:
        return _single_symbol_frame()

    out = fetch_closes(["VTI"], date(2024, 1, 2), date(2024, 1, 4), downloader=fake_download)

    assert list(out["VTI"].keys()) == [date(2024, 1, 2), date(2024, 1, 3)]
    assert out["VTI"][date(2024, 1, 3)] == Decimal(repr(241.55))


def test_fetch_closes_single_symbol_grouped_frame() -> None:
    """yfinance with ``group_by='ticker'`` returns a MultiIndex even for one
    ticker — the benchmark/analytics path. The adapter must read it as
    ``frame[symbol]['Close']`` rather than the bare ``frame['Close']``.
    """

    def fake_download(**_: Any) -> pd.DataFrame:
        idx = pd.to_datetime(["2024-01-02", "2024-01-03"])
        cols = pd.MultiIndex.from_tuples([("VT", "Open"), ("VT", "Close")])
        return pd.DataFrame([[239.0, 240.10], [240.5, 241.55]], index=idx, columns=cols)

    out = fetch_closes(["VT"], date(2024, 1, 2), date(2024, 1, 4), downloader=fake_download)

    assert list(out["VT"].keys()) == [date(2024, 1, 2), date(2024, 1, 3)]
    assert out["VT"][date(2024, 1, 3)] == Decimal(repr(241.55))


def test_fetch_closes_empty_frame() -> None:
    def fake_download(**_: Any) -> pd.DataFrame:
        return pd.DataFrame()

    out = fetch_closes(["VTI", "VOO"], date(2024, 1, 2), date(2024, 1, 5), downloader=fake_download)
    assert out == {"VTI": {}, "VOO": {}}


def test_fetch_closes_missing_symbol_in_frame() -> None:
    """If yfinance returns data for only a subset, the missing one is empty."""

    def fake_download(**_: Any) -> pd.DataFrame:
        # Only VTI is present.
        idx = pd.to_datetime(["2024-01-02"])
        cols = pd.MultiIndex.from_tuples([("VTI", "Close")])
        return pd.DataFrame([[240.10]], index=idx, columns=cols)

    out = fetch_closes(
        ["VTI", "MISSING"], date(2024, 1, 2), date(2024, 1, 5), downloader=fake_download
    )
    assert out["VTI"][date(2024, 1, 2)] == Decimal(repr(240.10))
    assert out["MISSING"] == {}


def test_fetch_closes_validates_range() -> None:
    with pytest.raises(ValueError, match="strictly after"):
        fetch_closes(["VTI"], date(2024, 1, 5), date(2024, 1, 2))


def test_fetch_closes_empty_symbols() -> None:
    assert fetch_closes([], date(2024, 1, 1), date(2024, 1, 2)) == {}


def test_fetch_closes_downloader_error() -> None:
    def boom(**_: Any) -> pd.DataFrame:
        raise RuntimeError("yfinance down")

    with pytest.raises(YFinanceError):
        fetch_closes(["VTI"], date(2024, 1, 1), date(2024, 1, 5), downloader=boom)


@pytest.mark.network
def test_fetch_closes_live_smoke() -> None:
    # SPY is liquid enough to almost always have history available.
    out = fetch_closes(["SPY"], date(2024, 1, 2), date(2024, 1, 6))
    assert "SPY" in out
    assert any(isinstance(v, Decimal) for v in out["SPY"].values())


def test_fetch_closes_falls_back_to_wider_window_when_empty() -> None:
    """If the requested window is empty, retry with a wider lookback."""
    calls: list[tuple[date, date, tuple[str, ...]]] = []

    def fake_download(**kwargs: Any) -> pd.DataFrame:
        start = date.fromisoformat(kwargs["start"])
        end = date.fromisoformat(kwargs["end"])
        tickers = tuple(kwargs["tickers"])
        calls.append((start, end, tickers))
        # First (narrow) call returns nothing — emulates "today's bar not yet
        # published". Second (widened) call returns a last-close row.
        if (end - start).days <= 1:
            return pd.DataFrame()
        idx = pd.to_datetime(["2026-05-27"])
        cols = pd.MultiIndex.from_tuples([("VTI", "Close"), ("VOO", "Close")])
        return pd.DataFrame([[240.10, 440.50]], index=idx, columns=cols)

    out = fetch_closes(
        ["VTI", "VOO"], date(2026, 5, 28), date(2026, 5, 29), downloader=fake_download
    )

    assert len(calls) == 2, "expected a fallback download call"
    assert out["VTI"][date(2026, 5, 27)] == Decimal(repr(240.10))
    assert out["VOO"][date(2026, 5, 27)] == Decimal(repr(440.50))


def test_fetch_closes_fallback_only_for_missing_symbols() -> None:
    """The retry should only ask for symbols that were missing."""
    calls: list[tuple[str, ...]] = []

    def fake_download(**kwargs: Any) -> pd.DataFrame:
        tickers = tuple(kwargs["tickers"])
        calls.append(tickers)
        if tickers == ("VTI", "VOO"):
            # Initial call: only VTI has data.
            idx = pd.to_datetime(["2026-05-28"])
            cols = pd.MultiIndex.from_tuples([("VTI", "Close")])
            return pd.DataFrame([[241.00]], index=idx, columns=cols)
        # Fallback call: should be just VOO.
        idx = pd.to_datetime(["2026-05-27"])
        return pd.DataFrame({"Close": [440.50]}, index=idx)

    out = fetch_closes(
        ["VTI", "VOO"], date(2026, 5, 28), date(2026, 5, 29), downloader=fake_download
    )

    assert calls[0] == ("VTI", "VOO")
    assert calls[1] == ("VOO",), "fallback should only refetch the missing symbol"
    assert out["VTI"][date(2026, 5, 28)] == Decimal(repr(241.00))
    assert out["VOO"][date(2026, 5, 27)] == Decimal(repr(440.50))


def test_fetch_closes_no_fallback_when_window_already_wide() -> None:
    """If the requested window is already wider than the fallback, don't retry."""
    calls: list[Any] = []

    def fake_download(**kwargs: Any) -> pd.DataFrame:
        calls.append(kwargs)
        return pd.DataFrame()

    out = fetch_closes(["VTI"], date(2024, 1, 1), date(2024, 6, 1), downloader=fake_download)
    assert len(calls) == 1
    assert out == {"VTI": {}}


def test_yfinance_logger_silenced_on_import() -> None:
    """The noisy yfinance stderr logger must be muted at module import."""
    import logging as _logging

    assert _logging.getLogger("yfinance").level >= _logging.CRITICAL


def test_fetch_closes_records_ok_status() -> None:
    from investment_dashboard.services import provider_status

    provider_status.reset()

    def fake_download(**_: Any) -> pd.DataFrame:
        return _single_symbol_frame()

    fetch_closes(["VTI"], date(2024, 1, 2), date(2024, 1, 4), downloader=fake_download)

    event = provider_status.get_status("yfinance")
    assert event is not None
    assert event.status == "ok"
    assert "1 symbol" in event.message
    provider_status.reset()


def test_fetch_closes_records_partial_status() -> None:
    from investment_dashboard.services import provider_status

    provider_status.reset()

    def fake_download(**_: Any) -> pd.DataFrame:
        # Only VTI present; MISSING absent — even after the fallback retry.
        idx = pd.to_datetime(["2024-01-02"])
        cols = pd.MultiIndex.from_tuples([("VTI", "Close")])
        return pd.DataFrame([[240.10]], index=idx, columns=cols)

    fetch_closes(["VTI", "MISSING"], date(2024, 1, 2), date(2024, 1, 5), downloader=fake_download)

    event = provider_status.get_status("yfinance")
    assert event is not None
    assert event.status == "partial"
    assert "MISSING" in event.message
    provider_status.reset()


def test_fetch_closes_records_error_on_full_failure() -> None:
    from investment_dashboard.services import provider_status

    provider_status.reset()

    def fake_download(**_: Any) -> pd.DataFrame:
        return pd.DataFrame()

    fetch_closes(["VTI", "VOO"], date(2024, 1, 2), date(2024, 1, 5), downloader=fake_download)

    event = provider_status.get_status("yfinance")
    assert event is not None
    assert event.status == "error"
    provider_status.reset()


def test_fetch_closes_records_error_on_download_exception() -> None:
    from investment_dashboard.services import provider_status

    provider_status.reset()

    def boom(**_: Any) -> pd.DataFrame:
        raise RuntimeError("yfinance down")

    with pytest.raises(YFinanceError):
        fetch_closes(["VTI"], date(2024, 1, 2), date(2024, 1, 5), downloader=boom)

    event = provider_status.get_status("yfinance")
    assert event is not None
    assert event.status == "error"
    assert "yfinance down" in event.message
    provider_status.reset()
