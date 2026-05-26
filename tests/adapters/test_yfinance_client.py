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
