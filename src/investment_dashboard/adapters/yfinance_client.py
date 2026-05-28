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

    # yfinance accepts either a list or whitespace-separated string. We pass
    # a list for clarity. group_by="ticker" yields a top-level column per
    # symbol when len(symbols) > 1; for a single symbol the layout is flat.
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


@dataclass(frozen=True)
class InstrumentInfo:
    """Subset of yfinance's ``Ticker.info`` we care about for enrichment.

    ``quote_type`` is yfinance's raw classification (``ETF``, ``EQUITY``,
    ``MUTUALFUND``, ``INDEX``, ``CURRENCY``, …). The enrichment service
    is responsible for mapping it onto our ledger taxonomy
    (``etf`` / ``stock`` / ``mutual_fund`` / …). Any field may be
    ``None`` when yfinance does not publish it for that symbol.
    """

    symbol: str
    long_name: str | None
    quote_type: str | None
    currency: str | None
    expense_ratio: Decimal | None


def fetch_instrument_info(
    symbol: str,
    *,
    ticker_factory: Any = None,
) -> InstrumentInfo | None:
    """Return what yfinance knows about ``symbol`` for enrichment.

    ``ticker_factory`` lets tests inject a fake ``yf.Ticker``. The
    function returns ``None`` rather than raising when yfinance gives
    us an empty / unusable ``info`` dict — enrichment must degrade
    gracefully so a single dead symbol doesn't poison the whole
    import.
    """
    factory = ticker_factory or yf.Ticker
    try:
        info: dict[str, Any] = factory(symbol).info or {}
    except Exception as exc:  # pragma: no cover - network/yfinance churn
        log.warning("yfinance Ticker(%s).info failed: %s", symbol, exc)
        return None
    if not info:
        return None

    raw_ter = info.get("annualReportExpenseRatio")
    expense_ratio: Decimal | None
    if raw_ter is None:
        expense_ratio = None
    else:
        try:
            # yfinance returns the TER as a decimal fraction (0.0003 = 3bps).
            expense_ratio = Decimal(repr(float(raw_ter)))
        except (TypeError, ValueError, ArithmeticError):
            expense_ratio = None

    long_name = info.get("longName") or info.get("shortName")
    currency = info.get("currency")
    return InstrumentInfo(
        symbol=symbol,
        long_name=(str(long_name).strip() or None) if long_name else None,
        quote_type=(str(info.get("quoteType")).upper() if info.get("quoteType") else None),
        currency=(str(currency).upper() if currency else None),
        expense_ratio=expense_ratio,
    )
