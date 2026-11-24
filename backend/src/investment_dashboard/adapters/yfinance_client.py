"""yfinance market-data adapter.

Wraps ``yfinance.download`` with our preferred defaults:

* ``auto_adjust=False`` — we track dividends as ledger rows ourselves; raw
  closes are required so we don't double-count them.
* Decimal returns — no float drift downstream.
* Per-symbol grouping that tolerates missing or empty frames gracefully.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Collection, Mapping, MutableMapping
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

import yfinance as yf

from investment_dashboard.adapters._retry import retry_call

log = logging.getLogger(__name__)

_PROVIDER = "yfinance"

#: Bounded retry budget for transient yfinance download failures. yfinance
#: hides the underlying HTTP status, so we retry any download exception a
#: small number of times with backoff before surfacing a ``YFinanceError``.
#: Boosted (4 attempts / 0.75 s base + jitter) so a transient blip is absorbed
#: in-call and never needlessly escalates to the Tiingo secondary fallback —
#: see ``legacy/v5:docs/tiingo_fallback_plan.md`` ("Retry-before-escalate").
_DOWNLOAD_ATTEMPTS = 4
#: Base backoff for the download retry; jitter de-correlates concurrent retries.
_DOWNLOAD_BACKOFF_SECONDS = 0.75
_DOWNLOAD_JITTER = 0.25


def _record_status(status: str, message: str) -> None:
    """Lazy wrapper around provider_status.record to avoid a circular import.

    ``services/__init__.py`` eagerly imports ``prices_service`` which imports
    this adapter; importing ``services.provider_status`` at module load time
    would re-enter the half-initialised ``services`` package. Importing inside
    the function avoids that and the lookup cost is negligible compared to a
    network round-trip.
    """
    from investment_dashboard.adapters.provider_status import record  # noqa: PLC0415

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

#: How many tickers to name inline in a status message before truncating, so the
#: connectivity log says *which* symbols were pulled without growing unbounded
#: for a full-portfolio refresh.
_STATUS_SYMBOL_LIMIT = 12

#: Parallel chart requests for one batch (yfinance's own ``threads=True`` uses a
#: similar pool). Yahoo serves each symbol's window as its own request, so a
#: serial batch costs one round trip per symbol; this caps it at a few.
_FETCH_WORKERS = 8


def _format_symbols(symbols: list[str]) -> str:
    """Render a tickers list for a status message (sorted, capped, deduped).

    Names up to :data:`_STATUS_SYMBOL_LIMIT` symbols inline so the connectivity
    log shows exactly *what* was fetched, then summarises the remainder as
    "… +N more" to keep the line short on a full-portfolio refresh.
    """
    unique = sorted(dict.fromkeys(symbols))
    if len(unique) <= _STATUS_SYMBOL_LIMIT:
        return ", ".join(unique)
    shown = ", ".join(unique[:_STATUS_SYMBOL_LIMIT])
    return f"{shown}, … +{len(unique) - _STATUS_SYMBOL_LIMIT} more"


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
    adjusted: bool = False,
    expected_gaps: Collection[str] = (),
    market_times: MutableMapping[str, datetime] | None = None,
) -> dict[str, dict[date, Decimal]]:
    """Return ``{symbol: {date: close_decimal}}`` for the half-open range.

    ``expected_gaps`` names symbols the caller expects may legitimately return
    nothing yet (mutual funds before their NAV posts); an empty answer for them
    is logged at INFO and never marks the provider status as partial/error, and
    they skip the wider last-close retry (waiting for a NAV is not a hiccup).

    ``market_times``, when given, is filled with ``{symbol: market_time}`` (naive
    UTC) from the same chart responses that carry the closes, so the caller does
    not need a second, per-symbol ``Ticker.info`` round trip for it (see
    :func:`fetch_market_times`). Only the default (real yfinance) path fills it;
    an injected ``downloader`` leaves it untouched.

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
    adjusted
        When ``True`` the closes are dividend- and split-adjusted
        (``auto_adjust=True``), i.e. a *total-return* series. The default
        ``False`` keeps raw closes — required for held instruments whose
        dividends we already track as ledger rows (adjusting would
        double-count them). Pass ``True`` only for instruments we never hold
        and whose distributions are *not* in the ledger (e.g. the benchmark
        overlay), so "what if I'd bought the index?" reflects its real
        total return rather than price alone.
    """
    if end <= start:
        raise ValueError(f"end ({end}) must be strictly after start ({start})")
    if not symbols:
        return {}

    download = downloader or _history_downloader(market_times)

    try:
        result = _download_window(
            download, symbols, start, end, adjusted=adjusted, expected_gaps=expected_gaps
        )
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
    missing = [s for s in symbols if not result.get(s) and s not in expected_gaps]
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
                fallback = _download_window(
                    download,
                    missing,
                    fallback_start,
                    end,
                    adjusted=adjusted,
                    expected_gaps=expected_gaps,
                )
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

    # Symbols the caller expects to lag (NAV funds before their NAV posts) are
    # waiting, not failing: they must not turn the provider status into an error.
    still_missing = [s for s in symbols if not result.get(s) and s not in expected_gaps]
    delivered = sum(1 for s in symbols if result.get(s))
    if not still_missing:
        msg = f"Fetched {len(symbols)} symbol(s) for {start}..{end}: {_format_symbols(symbols)}"
        if used_fallback:
            msg += " (last-close fallback used)"
        _record_status("ok", msg)
    elif delivered == 0:
        _record_status(
            "error",
            f"No data returned for any of {len(symbols)} symbol(s); "
            f"first missing: {still_missing[:5]}",
        )
    else:
        _record_status(
            "partial",
            f"{delivered}/{len(symbols)} symbol(s) returned data; "
            f"missing: {still_missing[:5]}" + ("…" if len(still_missing) > 5 else ""),
        )

    return result


def _history_downloader(market_times: MutableMapping[str, datetime] | None) -> Any:
    """A ``yfinance.download``-compatible callable that also records market times.

    ``yfinance.download`` asks Yahoo's chart endpoint once per symbol and throws
    the response's ``meta`` away. That ``meta`` carries ``regularMarketTime`` (when
    the price was struck), which we used to fetch again per symbol through
    ``Ticker.info``, serially, on every tick. This does the same per-symbol chart
    requests through ``Ticker.history`` on a small thread pool and keeps the
    market time from each answer.
    """

    def download(**kwargs: Any) -> Any:
        return _history_download(market_times=market_times, **kwargs)

    return download


def _history_download(
    *,
    tickers: list[str],
    start: str,
    end: str,
    auto_adjust: bool = False,
    actions: bool = False,
    interval: str = "1d",
    market_times: MutableMapping[str, datetime] | None = None,
    ticker_factory: Any = None,
    **_ignored: Any,
) -> Any:
    """Per-symbol ``Ticker.history`` calls in parallel, assembled like ``yf.download``.

    Returns a ``(symbol, field)`` column ``MultiIndex`` frame (empty when nothing
    came back). Daily bars are re-indexed to naive exchange-local dates, as
    ``yf.download`` does for daily intervals, so symbols on different exchanges
    line up by trading date. A symbol that errors is simply absent, as with
    ``yf.download``, which never raises for one symbol's failure either.
    """
    import pandas as pd  # noqa: PLC0415

    factory = ticker_factory or yf.Ticker
    symbols = list(dict.fromkeys(tickers))

    def one(symbol: str) -> tuple[Any, datetime | None]:
        ticker = factory(symbol)
        frame = ticker.history(
            start=start,
            end=end,
            interval=interval,
            auto_adjust=auto_adjust,
            actions=actions,
            raise_errors=False,
        )
        meta = getattr(getattr(ticker, "_price_history", None), "_history_metadata", None)
        when = (
            _coerce_market_time(meta.get("regularMarketTime")) if isinstance(meta, dict) else None
        )
        return frame, when

    def guarded(symbol: str) -> tuple[Any, datetime | None]:
        try:
            return one(symbol)
        except Exception as exc:  # one bad symbol must not sink the batch
            log.debug("yfinance chart request failed for %s: %s", symbol, exc)
            return None, None

    if not symbols:
        return pd.DataFrame()
    workers = max(1, min(_FETCH_WORKERS, len(symbols)))
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="yf-chart") as pool:
        answers = list(pool.map(guarded, symbols))

    parts: dict[str, Any] = {}
    for symbol, (answer, when) in zip(symbols, answers, strict=True):
        if when is not None and market_times is not None:
            market_times[symbol] = when
        if answer is None or getattr(answer, "empty", True):
            continue
        frame = answer
        if interval[-1] not in ("m", "h") and getattr(frame.index, "tz", None) is not None:
            frame = frame.copy()
            frame.index = frame.index.tz_localize(None)
        parts[symbol] = frame
    if not parts:
        return pd.DataFrame()
    return pd.concat(parts, axis=1)


def _download_window(
    download: Any,
    symbols: list[str],
    start: date,
    end: date,
    *,
    adjusted: bool = False,
    expected_gaps: Collection[str] = (),
) -> dict[str, dict[date, Decimal]]:
    """Single yfinance ``download`` call, parsed into the adapter's shape."""
    try:
        frame = retry_call(
            lambda: download(
                tickers=symbols,
                start=start.isoformat(),
                end=end.isoformat(),
                auto_adjust=adjusted,
                actions=False,
                progress=False,
                group_by="ticker",
                threads=True,
            ),
            attempts=_DOWNLOAD_ATTEMPTS,
            backoff_seconds=_DOWNLOAD_BACKOFF_SECONDS,
            jitter=_DOWNLOAD_JITTER,
            description="yfinance.download",
        )
    except Exception as exc:
        raise YFinanceError(f"yfinance.download failed: {exc}") from exc

    result: dict[str, dict[date, Decimal]] = {s: {} for s in symbols}

    if frame is None or getattr(frame, "empty", True):
        # An empty answer is routine when every symbol asked for is one the caller
        # expects to lag (a fund whose NAV posts hours after the close).
        level = logging.INFO if symbols and set(symbols) <= set(expected_gaps) else logging.WARNING
        log.log(level, "yfinance returned no data for %s..%s symbols=%s", start, end, symbols)
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


def fetch_splits(
    symbols: list[str],
    start: date,
    end: date,
    *,
    downloader: Any = None,
) -> dict[str, dict[date, Decimal]]:
    """Return ``{symbol: {date: ratio}}`` of stock splits in ``[start, end)``.

    ``ratio`` is ``shares_after / shares_before`` (``2`` for a 2-for-1 split,
    ``0.5`` for a 1-for-2 reverse split). Symbols with no split in the window
    map to an empty dict. Splits are authoritative corporate actions from the
    feed, needed because yfinance back-adjusts an instrument's whole price
    history by every split — even ones after the user sold the holding, which
    therefore never appear as a ledger ``split`` transaction.

    Parameters mirror :func:`fetch_closes`; ``downloader`` injects a stub
    matching ``yfinance.download`` in tests.
    """
    if end <= start:
        raise ValueError(f"end ({end}) must be strictly after start ({start})")
    if not symbols:
        return {}

    download = downloader or yf.download
    try:
        frame = retry_call(
            lambda: download(
                tickers=symbols,
                start=start.isoformat(),
                end=end.isoformat(),
                auto_adjust=False,
                actions=True,
                progress=False,
                group_by="ticker",
                threads=True,
            ),
            attempts=_DOWNLOAD_ATTEMPTS,
            backoff_seconds=_DOWNLOAD_BACKOFF_SECONDS,
            jitter=_DOWNLOAD_JITTER,
            description="yfinance.download (splits)",
        )
    except Exception as exc:
        raise YFinanceError(f"yfinance.download (splits) failed: {exc}") from exc

    result: dict[str, dict[date, Decimal]] = {s: {} for s in symbols}
    if frame is None or getattr(frame, "empty", True):
        return result

    import pandas as pd  # noqa: PLC0415

    columns = getattr(frame, "columns", None)
    is_grouped = isinstance(columns, pd.MultiIndex)
    for symbol in symbols:
        try:
            splits = frame[symbol]["Stock Splits"] if is_grouped else frame["Stock Splits"]
        except KeyError:
            continue
        for ts, value in splits.dropna().items():
            ratio = Decimal(repr(float(value)))
            if ratio <= 0:
                continue  # 0.0 marks "no split that day"
            day = ts.date() if hasattr(ts, "date") else ts
            result[symbol][day] = ratio
    return result


def fetch_ex_dividend_dates(
    symbols: list[str],
    start: date,
    end: date,
    *,
    downloader: Any = None,
) -> dict[str, list[date]]:
    """Return ``{symbol: [ex_date, ...]}`` of dividends the feed saw in ``[start, end)``.

    Only the dates are returned (the ledger holds the amounts). Used by the ledger
    completeness check (v7 P7); never called from a request path.
    """
    if end <= start:
        raise ValueError(f"end ({end}) must be strictly after start ({start})")
    if not symbols:
        return {}

    download = downloader or yf.download
    try:
        frame = retry_call(
            lambda: download(
                tickers=symbols,
                start=start.isoformat(),
                end=end.isoformat(),
                auto_adjust=False,
                actions=True,
                progress=False,
                group_by="ticker",
                threads=True,
            ),
            attempts=_DOWNLOAD_ATTEMPTS,
            backoff_seconds=_DOWNLOAD_BACKOFF_SECONDS,
            jitter=_DOWNLOAD_JITTER,
            description="yfinance.download (dividends)",
        )
    except Exception as exc:
        raise YFinanceError(f"yfinance.download (dividends) failed: {exc}") from exc

    result: dict[str, list[date]] = {s: [] for s in symbols}
    if frame is None or getattr(frame, "empty", True):
        return result

    import pandas as pd  # noqa: PLC0415

    columns = getattr(frame, "columns", None)
    is_grouped = isinstance(columns, pd.MultiIndex)
    for symbol in symbols:
        try:
            dividends = frame[symbol]["Dividends"] if is_grouped else frame["Dividends"]
        except KeyError:
            continue
        for ts, value in dividends.dropna().items():
            if float(value) <= 0:
                continue  # 0.0 marks "no dividend that day"
            result[symbol].append(ts.date() if hasattr(ts, "date") else ts)
    return result


def fetch_intraday_closes(
    symbols: list[str],
    day: date,
    *,
    interval: str = "30m",
    downloader: Any = None,
) -> dict[str, dict[datetime, Decimal]]:
    """Return ``{symbol: {bar_time_utc: close}}`` of intraday bars on ``day``.

    Used to *reconstruct* the most recent trading session's portfolio curve when
    the app was closed for part (or all) of it — e.g. logging in late in the day,
    after the close, or over a weekend. ``interval`` is a yfinance bar width
    (``"30m"`` by default; the dashboard passes its own reconstruction
    granularity). Bar timestamps are normalised to **naive UTC** so they store
    and compare uniformly with the live intraday samples.

    yfinance only serves intraday history for roughly the last 60 days, so this
    is for the *recent* session, not deep history. Symbols with no intraday data
    in the window map to an empty dict. ``downloader`` injects a stub matching
    ``yfinance.download`` in tests.
    """
    return fetch_intraday_closes_range(symbols, day, day, interval=interval, downloader=downloader)


def fetch_intraday_closes_range(
    symbols: list[str],
    start_day: date,
    end_day: date,
    *,
    interval: str = "30m",
    downloader: Any = None,
) -> dict[str, dict[datetime, Decimal]]:
    """Return ``{symbol: {bar_time_utc: close}}`` over ``[start_day, end_day]``.

    Multi-day variant of :func:`fetch_intraday_closes` used by the Overview "1W"
    curve, which needs each recent session's intraday bars in one download rather
    than a separate request per day. Inclusive of both endpoints; bar timestamps
    are naive UTC. yfinance only serves intraday history for roughly the last 60
    days, so ``start_day`` should be recent. ``downloader`` injects a stub
    matching ``yfinance.download`` in tests.
    """
    if not symbols or end_day < start_day:
        return {s: {} for s in symbols}

    download = downloader or yf.download
    # yfinance treats ``end`` as exclusive; +1 day captures the whole last session.
    try:
        frame = retry_call(
            lambda: download(
                tickers=symbols,
                start=start_day.isoformat(),
                end=(end_day + timedelta(days=1)).isoformat(),
                interval=interval,
                auto_adjust=False,
                actions=False,
                progress=False,
                group_by="ticker",
                threads=True,
            ),
            attempts=_DOWNLOAD_ATTEMPTS,
            backoff_seconds=_DOWNLOAD_BACKOFF_SECONDS,
            jitter=_DOWNLOAD_JITTER,
            description="yfinance.download (intraday)",
        )
    except Exception as exc:
        raise YFinanceError(f"yfinance.download (intraday) failed: {exc}") from exc

    result: dict[str, dict[datetime, Decimal]] = {s: {} for s in symbols}
    if frame is None or getattr(frame, "empty", True):
        return result

    import pandas as pd  # noqa: PLC0415

    columns = getattr(frame, "columns", None)
    is_grouped = isinstance(columns, pd.MultiIndex)
    for symbol in symbols:
        try:
            close_series = frame[symbol]["Close"] if is_grouped else frame["Close"]
        except KeyError:
            continue
        for ts, value in close_series.dropna().items():
            result[symbol][_to_naive_utc(ts)] = Decimal(repr(float(value)))
    return result


def _to_naive_utc(ts: Any) -> datetime:
    """Normalise a (possibly tz-aware) pandas/py timestamp to a naive UTC datetime."""
    as_dt = ts.to_pydatetime() if hasattr(ts, "to_pydatetime") else ts
    if isinstance(as_dt, datetime) and as_dt.tzinfo is not None:
        return as_dt.astimezone(UTC).replace(tzinfo=None)
    return as_dt


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


#: yfinance forex symbol for the EUR→USD pair (USD per 1 EUR). Keyless — the
#: free, no-token alternative to Twelve Data for the desktop app, whose live
#: EUR/USD spot powers the FX-aware "today" figures (the web companion keeps
#: using its own Twelve Data key). FX trades ~24/5, so intraday this row is
#: dated today during the trading week and Friday's close over the weekend.
EUR_USD_YF_SYMBOL = "EURUSD=X"


def fetch_eur_usd_spot(
    *,
    lookback_days: int = 7,
    ticker_factory: Any = None,
) -> PriceRecord | None:
    """Return the latest available EUR→USD spot (USD per 1 EUR), or ``None``.

    Thin wrapper over :func:`fetch_latest_close` for :data:`EUR_USD_YF_SYMBOL`;
    the returned record's ``date`` is the observation day, which the FX service
    uses to decide whether the rate is fresh enough to overlay as *today's* live
    mark (vs. falling back to the ECB daily close).
    """
    return fetch_latest_close(
        EUR_USD_YF_SYMBOL, lookback_days=lookback_days, ticker_factory=ticker_factory
    )


def fetch_eur_usd_intraday(
    day: date,
    *,
    interval: str = "15m",
    downloader: Any = None,
) -> dict[datetime, Decimal]:
    """Return ``{bar_time_utc: eur_usd_close}`` of intraday EUR→USD bars on ``day``.

    Sources the ``EURUSD=X`` ticker at the ~15-minute granularity the Overview
    "1 Day" curve is reconstructed at, so each back-filled portfolio point can be
    converted at the *actual rate struck at that minute* rather than a single
    uniform spot. USD is the booked currency, so this is what lets the EUR view
    legitimately diverge from the FX-free USD view as the rate moves through the
    session. (Historical *end-of-day* FX is sourced from the ECB reference rates,
    not yfinance — this intraday path is only for the live session's curve.)

    Best-effort: an empty mapping (no data / a quiet weekend row) leaves callers
    to forward-fill or fall back to the day's settled rate. Bar timestamps are
    naive UTC, matching the portfolio samples they align with.
    """
    bars = fetch_intraday_closes([EUR_USD_YF_SYMBOL], day, interval=interval, downloader=downloader)
    return dict(bars.get(EUR_USD_YF_SYMBOL, {}))


def fetch_eur_usd_intraday_range(
    start_day: date,
    end_day: date,
    *,
    interval: str = "15m",
    downloader: Any = None,
) -> dict[datetime, Decimal]:
    """Return ``{bar_time_utc: eur_usd_close}`` of EUR→USD bars over a date range.

    Multi-day variant of :func:`fetch_eur_usd_intraday` used by the Overview "1W"
    curve so each plotted point can be converted at the rate actually struck at
    that minute (USD stays FX-free, EUR is derived). Best-effort: an empty mapping
    leaves callers to forward-fill / fall back to the day's settled rate.
    """
    bars = fetch_intraday_closes_range(
        [EUR_USD_YF_SYMBOL], start_day, end_day, interval=interval, downloader=downloader
    )
    return dict(bars.get(EUR_USD_YF_SYMBOL, {}))


def _coerce_market_time(value: Any) -> datetime | None:
    """Normalise a yfinance market-time value to a naive-UTC ``datetime``.

    yfinance publishes ``regularMarketTime`` as epoch seconds (an ``int``), but
    different versions/symbols occasionally hand back a ``datetime`` or a pandas
    ``Timestamp``. Anything unparseable degrades to ``None`` so the caller simply
    omits the symbol. The naive-UTC shape matches the price cache's storage
    convention for ``last_refreshed_at``.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(UTC).replace(tzinfo=None) if value.tzinfo else value
    try:
        return datetime.fromtimestamp(int(value), tz=UTC).replace(tzinfo=None)
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def _regular_market_time(symbol: str, *, ticker_factory: Any = None) -> datetime | None:
    """Read yfinance's ``regularMarketTime`` for ``symbol`` (best-effort)."""
    factory = ticker_factory or yf.Ticker
    info: dict[str, Any] = factory(symbol).info or {}
    return _coerce_market_time(info.get("regularMarketTime"))


def fetch_market_times(
    symbols: list[str],
    *,
    known: Mapping[str, datetime] | None = None,
    quoter: Any = None,
) -> dict[str, datetime]:
    """Return ``{symbol: market_time}`` — *when each price is from* (naive UTC).

    The "market time" is the moment the price the provider is currently serving
    was last struck on the exchange (yfinance's ``regularMarketTime``), as
    opposed to *when we pulled it*. For a mutual fund it is the instant the day's
    NAV was published, which is exactly the stamp the user wants to watch for.

    ``known`` holds the times the price download already returned (see
    ``fetch_closes(market_times=...)``); only the symbols missing from it are
    asked for one by one through ``Ticker.info``, in parallel.

    Best-effort and isolated: any symbol the provider can't time (or that errors)
    is simply absent from the result, so callers transparently fall back to the
    pull time or the modelled regular-session close. ``quoter`` injects a
    ``(symbol) -> datetime | None`` stub in tests.
    """
    if not symbols:
        return {}
    out: dict[str, datetime] = {}
    for symbol, when in (known or {}).items():
        coerced = _coerce_market_time(when)
        if symbol in symbols and coerced is not None:
            out[symbol] = coerced
    rest = [s for s in dict.fromkeys(symbols) if s not in out]
    if not rest:
        return out
    quote = quoter or _regular_market_time

    def one(symbol: str) -> datetime | None:
        try:
            return _coerce_market_time(quote(symbol))
        except Exception as exc:  # pragma: no cover - network/yfinance churn
            log.debug("market-time fetch failed for %s: %s", symbol, exc)
            return None

    workers = max(1, min(_FETCH_WORKERS, len(rest)))
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="yf-info") as pool:
        for symbol, quoted in zip(rest, pool.map(one, rest), strict=True):
            if quoted is not None:
                out[symbol] = quoted
    return out


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


# -- Lookup (symbols the user does not hold) ----------------------------------------


@dataclass(frozen=True)
class SearchHit:
    """One symbol-search result. ``currency`` is rarely in Yahoo's search payload."""

    symbol: str
    name: str
    exchange: str | None
    type: str | None
    currency: str | None


@dataclass(frozen=True)
class QuoteSnapshot:
    """A one-off quote for a symbol, all amounts in the symbol's native currency."""

    symbol: str
    name: str | None
    exchange: str | None
    type: str | None
    currency: str | None
    price: Decimal
    previous_close: Decimal | None
    week52_low: Decimal | None
    week52_high: Decimal | None


def _opt_decimal(value: Any) -> Decimal | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return Decimal(repr(number))


def search_instruments(
    query: str,
    limit: int = 10,
    *,
    search_factory: Any = None,
) -> list[SearchHit]:
    """Search Yahoo for symbols matching ``query`` (at most ``limit`` hits).

    ``search_factory`` injects a stand-in for ``yfinance.Search`` in tests.
    Raises :class:`YFinanceError` when the provider call fails.
    """
    factory = search_factory or yf.Search
    try:
        quotes = retry_call(
            lambda: list(
                factory(
                    query,
                    max_results=limit,
                    news_count=0,
                    lists_count=0,
                    include_cb=False,
                    enable_fuzzy_query=False,
                ).quotes
            ),
            attempts=2,
            backoff_seconds=_DOWNLOAD_BACKOFF_SECONDS,
            jitter=_DOWNLOAD_JITTER,
            description="yfinance.Search",
        )
    except Exception as exc:
        raise YFinanceError(f"yfinance.Search failed: {exc}") from exc

    hits: list[SearchHit] = []
    for raw in quotes:
        symbol = str(raw.get("symbol") or "").strip()
        if not symbol:
            continue
        name = raw.get("longname") or raw.get("shortname") or symbol
        exchange = raw.get("exchDisp") or raw.get("exchange")
        kind = raw.get("quoteType") or raw.get("typeDisp")
        currency = raw.get("currency")
        hits.append(
            SearchHit(
                symbol=symbol.upper(),
                name=str(name).strip(),
                exchange=str(exchange) if exchange else None,
                type=str(kind).upper() if kind else None,
                currency=str(currency).upper() if currency else None,
            )
        )
        if len(hits) >= limit:
            break
    return hits


def fetch_quote(symbol: str, *, ticker_factory: Any = None) -> QuoteSnapshot | None:
    """Return a one-off quote for ``symbol`` or ``None`` when Yahoo knows no price for it.

    Raises :class:`YFinanceError` when the provider call itself fails.
    """
    factory = ticker_factory or yf.Ticker

    def _call() -> tuple[Any, dict[str, Any]]:
        ticker = factory(symbol)
        fast = ticker.fast_info
        try:
            info: dict[str, Any] = ticker.info or {}
        except Exception as exc:  # the name is optional; the price is not
            log.debug("yfinance Ticker(%s).info failed: %s", symbol, exc)
            info = {}
        return fast, info

    try:
        fast, info = retry_call(
            _call,
            attempts=2,
            backoff_seconds=_DOWNLOAD_BACKOFF_SECONDS,
            jitter=_DOWNLOAD_JITTER,
            description="yfinance quote",
        )
        price = _opt_decimal(fast["last_price"])
        previous = _opt_decimal(fast["previous_close"])
        low = _opt_decimal(fast["year_low"])
        high = _opt_decimal(fast["year_high"])
        currency = fast["currency"]
        exchange = fast["exchange"]
        kind = fast["quote_type"]
    except Exception as exc:
        raise YFinanceError(f"yfinance quote failed for {symbol}: {exc}") from exc

    if price is None or price <= 0:
        return None
    name = info.get("longName") or info.get("shortName")
    return QuoteSnapshot(
        symbol=symbol,
        name=str(name).strip() if name else None,
        exchange=str(info.get("fullExchangeName") or exchange) if (info or exchange) else None,
        type=str(info.get("quoteType") or kind).upper()
        if (info.get("quoteType") or kind)
        else None,
        currency=str(currency).upper() if currency else None,
        price=price,
        previous_close=previous,
        week52_low=low,
        week52_high=high,
    )
