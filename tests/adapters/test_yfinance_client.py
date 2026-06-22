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


def test_fetch_closes_passes_auto_adjust_flag() -> None:
    """``adjusted`` toggles yfinance's ``auto_adjust`` so the benchmark overlay
    can request a total-return (dividend-adjusted) series while held
    instruments keep raw closes."""
    seen: dict[str, object] = {}

    def fake_download(**kwargs: Any) -> pd.DataFrame:
        seen["auto_adjust"] = kwargs.get("auto_adjust")
        return _single_symbol_frame()

    fetch_closes(["VTI"], date(2024, 1, 2), date(2024, 1, 4), downloader=fake_download)
    assert seen["auto_adjust"] is False

    fetch_closes(
        ["VTI"], date(2024, 1, 2), date(2024, 1, 4), downloader=fake_download, adjusted=True
    )
    assert seen["auto_adjust"] is True


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


def test_fetch_latest_close_uses_history_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    """``^IRX`` comes back empty from the bulk download but works via
    ``Ticker.history``; ``fetch_latest_close`` must retry through it."""
    import investment_dashboard.adapters.yfinance_client as yc

    monkeypatch.setattr(yc, "fetch_closes", lambda *a, **k: {"^IRX": {}})

    class FakeTicker:
        def __init__(self, symbol: str) -> None:
            self.symbol = symbol

        def history(self, **_: Any) -> pd.DataFrame:
            idx = pd.to_datetime(["2026-05-28", "2026-05-29"])
            return pd.DataFrame({"Open": [5.18, 5.20], "Close": [5.19, 5.21]}, index=idx)

    rec = yc.fetch_latest_close("^IRX", ticker_factory=FakeTicker)
    assert rec is not None
    assert rec.symbol == "^IRX"
    assert rec.date == date(2026, 5, 29)
    assert rec.close == Decimal(repr(5.21))


def test_fetch_latest_close_returns_none_when_history_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import investment_dashboard.adapters.yfinance_client as yc

    monkeypatch.setattr(yc, "fetch_closes", lambda *a, **k: {"^IRX": {}})

    class EmptyTicker:
        def __init__(self, symbol: str) -> None:
            self.symbol = symbol

        def history(self, **_: Any) -> pd.DataFrame:
            return pd.DataFrame()

    assert yc.fetch_latest_close("^IRX", ticker_factory=EmptyTicker) is None


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


def _splits_multi_frame() -> pd.DataFrame:
    idx = pd.to_datetime(["2024-01-02", "2024-01-03", "2024-01-04"])
    cols = pd.MultiIndex.from_tuples(
        [
            ("SCHD", "Close"),
            ("SCHD", "Stock Splits"),
            ("VGT", "Close"),
            ("VGT", "Stock Splits"),
        ]
    )
    data = [
        [80.0, 0.0, 500.0, 0.0],
        [81.0, 3.0, 505.0, 0.0],  # SCHD 3-for-1 on 2024-01-03
        [27.0, 0.0, 250.0, 2.0],  # VGT 2-for-1 on 2024-01-04
    ]
    return pd.DataFrame(data, index=idx, columns=cols)


def test_fetch_splits_multi_symbol() -> None:
    from investment_dashboard.adapters.yfinance_client import fetch_splits

    def fake_download(**_: Any) -> pd.DataFrame:
        return _splits_multi_frame()

    out = fetch_splits(
        ["SCHD", "VGT"], date(2024, 1, 2), date(2024, 1, 5), downloader=fake_download
    )

    # Only the non-zero split rows are returned, as Decimal ratios.
    assert out["SCHD"] == {date(2024, 1, 3): Decimal("3.0")}
    assert out["VGT"] == {date(2024, 1, 4): Decimal("2.0")}


def test_fetch_splits_single_symbol() -> None:
    from investment_dashboard.adapters.yfinance_client import fetch_splits

    idx = pd.to_datetime(["2024-01-02", "2024-01-03"])
    frame = pd.DataFrame({"Close": [80.0, 81.0], "Stock Splits": [0.0, 4.0]}, index=idx)

    def fake_download(**_: Any) -> pd.DataFrame:
        return frame

    out = fetch_splits(["SCHD"], date(2024, 1, 2), date(2024, 1, 4), downloader=fake_download)
    assert out["SCHD"] == {date(2024, 1, 3): Decimal("4.0")}


def test_fetch_splits_empty_frame() -> None:
    from investment_dashboard.adapters.yfinance_client import fetch_splits

    def fake_download(**_: Any) -> pd.DataFrame:
        return pd.DataFrame()

    out = fetch_splits(["SCHD"], date(2024, 1, 2), date(2024, 1, 4), downloader=fake_download)
    assert out == {"SCHD": {}}


def _intraday_frame() -> pd.DataFrame:
    """Two 30-minute bars for one symbol with a tz-aware index (UTC)."""
    idx = pd.to_datetime(["2024-06-03 13:30:00+00:00", "2024-06-03 14:00:00+00:00"], utc=True)
    cols = pd.MultiIndex.from_tuples([("ACME", "Close"), ("ACME", "Open")])
    return pd.DataFrame([[100.0, 99.0], [110.0, 109.0]], index=idx, columns=cols)


def test_fetch_intraday_closes_normalises_to_naive_utc() -> None:
    from datetime import datetime

    from investment_dashboard.adapters.yfinance_client import fetch_intraday_closes

    seen: dict[str, object] = {}

    def fake_download(**kwargs: Any) -> pd.DataFrame:
        seen["interval"] = kwargs.get("interval")
        seen["start"] = kwargs.get("start")
        seen["end"] = kwargs.get("end")
        return _intraday_frame()

    out = fetch_intraday_closes(
        ["ACME"], date(2024, 6, 3), interval="30m", downloader=fake_download
    )

    assert seen["interval"] == "30m"
    # end is exclusive in yfinance, so the window spans the whole session day.
    assert seen["start"] == "2024-06-03"
    assert seen["end"] == "2024-06-04"
    assert out["ACME"][datetime(2024, 6, 3, 13, 30)] == Decimal(repr(100.0))
    assert out["ACME"][datetime(2024, 6, 3, 14, 0)] == Decimal(repr(110.0))
    # Stored keys are naive (tz stripped after conversion to UTC).
    assert all(ts.tzinfo is None for ts in out["ACME"])


def test_fetch_intraday_closes_empty_symbols_is_noop() -> None:
    from investment_dashboard.adapters.yfinance_client import fetch_intraday_closes

    assert fetch_intraday_closes([], date(2024, 6, 3)) == {}


def test_fetch_market_times_coerces_and_skips_unavailable() -> None:
    from datetime import UTC, datetime

    from investment_dashboard.adapters.yfinance_client import fetch_market_times

    # 2024-06-24 19:59:00 UTC.
    epoch = datetime(2024, 6, 24, 19, 59, tzinfo=UTC)

    def fake_quoter(symbol: str):  # type: ignore[no-untyped-def]
        return {"VTI": epoch, "GONE": None}.get(symbol)

    out = fetch_market_times(["VTI", "GONE"], quoter=fake_quoter)

    # The available symbol is timed (naive UTC); the unavailable one is absent.
    assert out == {"VTI": datetime(2024, 6, 24, 19, 59)}
    assert out["VTI"].tzinfo is None


def test_fetch_market_times_swallows_quoter_errors() -> None:
    from datetime import datetime

    from investment_dashboard.adapters.yfinance_client import fetch_market_times

    def boom(symbol: str):  # type: ignore[no-untyped-def]
        if symbol == "BAD":
            raise RuntimeError("quote endpoint down")
        return datetime(2024, 6, 24, 20, 0)

    out = fetch_market_times(["BAD", "OK"], quoter=boom)

    # A failing symbol never breaks the batch; the healthy one still resolves.
    assert out == {"OK": datetime(2024, 6, 24, 20, 0)}


def test_fetch_market_times_empty_symbols_is_noop() -> None:
    from investment_dashboard.adapters.yfinance_client import fetch_market_times

    assert fetch_market_times([]) == {}


def test_coerce_market_time_parses_epoch_seconds() -> None:
    from datetime import datetime

    from investment_dashboard.adapters.yfinance_client import _coerce_market_time

    # 1719259140 == 2024-06-24 19:59:00 UTC.
    assert _coerce_market_time(1719259140) == datetime(2024, 6, 24, 19, 59)
    assert _coerce_market_time(None) is None
    assert _coerce_market_time("not-a-time") is None
