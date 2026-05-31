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

_PROVIDER = "yfinance"


def _record_status(status: str, message: str) -> None:
    """Lazy wrapper around provider_status.record to avoid a circular import.

    ``services/__init__.py`` eagerly imports ``prices_service`` which imports
    this adapter; importing ``services.provider_status`` at module load time
    would re-enter the half-initialised ``services`` package. Importing inside
    the function avoids that and the lookup cost is negligible compared to a
    network round-trip.
    """
    from investment_dashboard.services.provider_status import record  # noqa: PLC0415

    record(_PROVIDER, status, message)  # type: ignore[arg-type]  # str→Literal narrowing


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

    try:
        result = _download_window(download, symbols, start, end)
    except YFinanceError as exc:
        _record_status(
            "error",
            f"Download failed for {len(symbols)} symbol(s): {exc}",
        )
        raise

    # If any symbol came back empty (typical for "today" requests during
    # trading hours, or for tickers yfinance just briefly hiccupped on),
    # retry just those symbols with a wider lookback so the caller always
    # gets the most recent available close instead of nothing. Skip the
    # retry if the original window was already wider than the fallback.
    missing = [s for s in symbols if not result.get(s)]
    used_fallback = False
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
            try:
                fallback = _download_window(download, missing, fallback_start, end)
            except YFinanceError as exc:
                _record_status(
                    "error",
                    f"Fallback download failed for {missing}: {exc}",
                )
                raise
            used_fallback = True
            for symbol, closes in fallback.items():
                if closes:
                    result[symbol] = closes

    still_missing = [s for s in symbols if not result.get(s)]
    if not still_missing:
        msg = f"Fetched {len(symbols)} symbol(s) for {start}..{end}"
        if used_fallback:
            msg += " (last-close fallback used)"
        _record_status("ok", msg)
    elif len(still_missing) == len(symbols):
        _record_status(
            "error",
            f"No data returned for any of {len(symbols)} symbol(s); "
            f"first missing: {still_missing[:5]}",
        )
    else:
        _record_status(
            "partial",
            f"{len(symbols) - len(still_missing)}/{len(symbols)} symbol(s) returned data; "
            f"missing: {still_missing[:5]}" + ("…" if len(still_missing) > 5 else ""),
        )

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

    # ``group_by="ticker"`` makes yfinance return a column ``MultiIndex``
    # *even for a single ticker* (``(symbol, "Close")``), so a one-symbol
    # fetch must still be read as ``frame[symbol]["Close"]``. The earlier
    # ``len(symbols) == 1`` short-circuit (``frame["Close"]``) raised a
    # silently-swallowed ``KeyError`` for every single-symbol fetch — which
    # is exactly the benchmark/analytics path (VT, VTI, …). We branch on the
    # actual column shape instead so both grouped and ungrouped frames work.
    columns = getattr(frame, "columns", None)
    import pandas as pd  # noqa: PLC0415

    is_grouped = isinstance(columns, pd.MultiIndex)

    for symbol in symbols:
        try:
            close_series = frame[symbol]["Close"] if is_grouped else frame["Close"]
        except KeyError:
            log.warning("yfinance returned no rows for symbol %s", symbol)
            continue

        for ts, value in close_series.dropna().items():
            day = ts.date() if hasattr(ts, "date") else ts
            # Round-trip through repr to keep the precision yfinance gave us
            # without picking up float-representation noise.
            result[symbol][day] = Decimal(repr(float(value)))

    return result


def fetch_latest_close(
    symbol: str,
    *,
    lookback_days: int = 7,
    ticker_factory: Any = None,
) -> PriceRecord | None:
    """Convenience helper: return the most recent available close for ``symbol``.

    ``yfinance`` doesn't expose a "last close" endpoint, so we fetch a small
    window and pick the latest row. Returns ``None`` if nothing is available
    in that window (e.g., delisted ticker, network failure tolerated upstream).

    Some CBOE yield tickers (notably ``^IRX``, the 13-week T-bill yield) come
    back as *empty frames* from ``yfinance.download`` even though they're alive
    and well on the ``Ticker.history`` endpoint. When the bulk-download path
    yields nothing we therefore retry via ``Ticker(symbol).history`` before
    giving up. ``ticker_factory`` lets tests inject a fake ``yf.Ticker``.
    """
    end = date.today() + timedelta(days=1)
    start = end - timedelta(days=max(lookback_days, 1))
    closes = fetch_closes([symbol], start, end).get(symbol, {})
    if not closes:
        closes = _history_closes(symbol, start, end, ticker_factory=ticker_factory)
    if not closes:
        return None
    latest_day = max(closes)
    return PriceRecord(symbol=symbol, date=latest_day, close=closes[latest_day])


def _history_closes(
    symbol: str,
    start: date,
    end: date,
    *,
    ticker_factory: Any = None,
) -> dict[date, Decimal]:
    """Fallback price fetch via ``Ticker.history`` for tickers that the bulk
    ``download`` endpoint returns empty for (e.g. ``^IRX``)."""
    factory = ticker_factory or yf.Ticker
    try:
        ticker = factory(symbol)
        frame = ticker.history(
            start=start.isoformat(),
            end=end.isoformat(),
            auto_adjust=False,
            actions=False,
        )
    except Exception as exc:  # pragma: no cover - network churn
        log.warning("yfinance Ticker.history fallback failed for %s: %s", symbol, exc)
        return {}

    if frame is None or getattr(frame, "empty", True):
        return {}

    closes: dict[date, Decimal] = {}
    try:
        close_series = frame["Close"]
    except (KeyError, TypeError):
        return {}
    for ts, value in close_series.dropna().items():
        if not hasattr(ts, "date"):
            # The index is normally a pandas Timestamp; anything without a
            # ``.date()`` can't be a valid date key, so skip it rather than
            # store a non-date key the callers would never match.
            continue
        closes[ts.date()] = Decimal(repr(float(value)))
    return closes


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
    #: Market-data grouping label — yfinance's fund ``category`` (e.g.
    #: ``"Large Blend"``) or, for single equities, the ``sector``
    #: (e.g. ``"Technology"``). ``None`` when yfinance publishes neither.
    category: str | None = None


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
    # Funds expose ``category`` (e.g. "Large Blend"); single equities expose
    # ``sector`` (e.g. "Technology"). Prefer the former, fall back to the latter.
    raw_category = info.get("category") or info.get("sector")
    return InstrumentInfo(
        symbol=symbol,
        long_name=(str(long_name).strip() or None) if long_name else None,
        quote_type=(str(info.get("quoteType")).upper() if info.get("quoteType") else None),
        currency=(str(currency).upper() if currency else None),
        expense_ratio=expense_ratio,
        category=(str(raw_category).strip() or None) if raw_category else None,
    )
