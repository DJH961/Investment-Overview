"""yfinance market-data adapter.

Wraps ``yfinance.download`` with our preferred defaults:

* ``auto_adjust=False`` — we track dividends as ledger rows ourselves; raw
  closes are required so we don't double-count them.
* Decimal returns — no float drift downstream.
* Per-symbol grouping that tolerates missing or empty frames gracefully.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

import yfinance as yf

log = logging.getLogger(__name__)

# yfinance prints one ERROR-level line per symbol on its own logger whenever a
# download returns no rows ("$XXX: possibly delisted; no price data found ...")
# plus a noisy summary block. That fires constantly during US trading hours
# when the day's bar hasn't been published yet, and again for symbols that
# legitimately have no yfinance ticker (e.g. ``VMFXX``/``SPAXX`` sweeps). We
# already log a single meaningful warning per empty symbol below, so silence
# yfinance's stderr noise at import time. Use CRITICAL rather than disabling
# propagation so genuinely fatal yfinance issues still surface.
logging.getLogger("yfinance").setLevel(logging.CRITICAL)

# When yfinance returns no rows for a requested window we retry just those
# symbols with this many extra calendar days of lookback. That guarantees
# callers get the most recent available close — the user's "last close price"
# fallback — even when the live bar hasn't published yet.
_FALLBACK_LOOKBACK_DAYS = 10


class YFinanceError(RuntimeError):
    """Raised when yfinance returns a fundamentally unusable payload."""


@dataclass(frozen=True)
class PriceRecord:
    """One day's close for one symbol, in the symbol's native currency."""

    symbol: str
    date: date
    close: Decimal


def fetch_closes(
    symbols: list[str],
    start: date,
    end: date,
    *,
    downloader: Any = None,
) -> dict[str, dict[date, Decimal]]:
    """Return ``{symbol: {date: close_decimal}}`` for the half-open range.

    ``end`` follows yfinance's exclusive convention; we pass it through as-is.
    Symbols absent from the result are returned with empty dicts so callers
    can detect "asked but not delivered" without try/except.

    Parameters
    ----------
    symbols
        Tickers in yfinance form (e.g. ``"VTI"``, ``"EXS1.DE"``).
    start, end
        Inclusive start, exclusive end.
    downloader
        Optional callable matching ``yfinance.download``'s signature, for
        injection in tests.
    """
    if end <= start:
        raise ValueError(f"end ({end}) must be strictly after start ({start})")
    if not symbols:
        return {}

    download = downloader or yf.download

    result = _download_window(download, symbols, start, end)

    # If any symbol came back empty (typical for "today" requests during
    # trading hours, or for tickers yfinance just briefly hiccupped on),
    # retry just those symbols with a wider lookback so the caller always
    # gets the most recent available close instead of nothing. Skip the
    # retry if the original window was already wider than the fallback.
    missing = [s for s in symbols if not result.get(s)]
    if missing:
        fallback_start = end - timedelta(days=_FALLBACK_LOOKBACK_DAYS)
        if fallback_start < start:
            log.info(
                "yfinance empty for %s in %s..%s; retrying from %s for last-close fallback",
                missing,
                start,
                end,
                fallback_start,
            )
            fallback = _download_window(download, missing, fallback_start, end)
            for symbol, closes in fallback.items():
                if closes:
                    result[symbol] = closes

    return result


def _download_window(
    download: Any,
    symbols: list[str],
    start: date,
    end: date,
) -> dict[str, dict[date, Decimal]]:
    """Single yfinance ``download`` call, parsed into the adapter's shape."""
    try:
        frame = download(
            tickers=symbols,
            start=start.isoformat(),
            end=end.isoformat(),
            auto_adjust=False,
            actions=False,
            progress=False,
            group_by="ticker",
            threads=False,
        )
    except Exception as exc:
        raise YFinanceError(f"yfinance.download failed: {exc}") from exc

    result: dict[str, dict[date, Decimal]] = {s: {} for s in symbols}

    if frame is None or getattr(frame, "empty", True):
        log.warning("yfinance returned no data for %s..%s symbols=%s", start, end, symbols)
        return result

    for symbol in symbols:
        try:
            close_series = frame["Close"] if len(symbols) == 1 else frame[symbol]["Close"]
        except KeyError:
            log.warning("yfinance returned no rows for symbol %s", symbol)
            continue

        for ts, value in close_series.dropna().items():
            day = ts.date() if hasattr(ts, "date") else ts
            # Round-trip through repr to keep the precision yfinance gave us
            # without picking up float-representation noise.
            result[symbol][day] = Decimal(repr(float(value)))

    return result


def fetch_latest_close(symbol: str, *, lookback_days: int = 7) -> PriceRecord | None:
    """Convenience helper: return the most recent available close for ``symbol``.

    ``yfinance`` doesn't expose a "last close" endpoint, so we fetch a small
    window and pick the latest row. Returns ``None`` if nothing is available
    in that window (e.g., delisted ticker, network failure tolerated upstream).
    """
    end = date.today() + timedelta(days=1)
    start = end - timedelta(days=max(lookback_days, 1))
    closes = fetch_closes([symbol], start, end).get(symbol, {})
    if not closes:
        return None
    latest_day = max(closes)
    return PriceRecord(symbol=symbol, date=latest_day, close=closes[latest_day])
