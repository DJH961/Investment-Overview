"""Tiingo market-data adapter — the desktop *secondary* provider.

yfinance is the desktop primary; Tiingo engages only as a smart, budgeted
fallback (see ``docs/tiingo_fallback_plan.md``). This module is a thin,
pure adapter — it knows nothing about *when* to call Tiingo (the smart gates,
budget, and stale-since logic live in the price service); it only knows *how*.

Two endpoints are wrapped:

* **IEX** (``/iex/?tickers=``) — a live intraday quote for stocks/ETFs
  (``tngoLast`` + ``prevClose`` + an ET ``timestamp``) and, gracefully, the most
  recent NAV for a mutual fund. Used for the live-mark and NAV-canary paths.
* **Daily** (``/tiingo/daily/<ticker>/prices``) — historical/last settled closes.
  Returns the same ``{symbol: {date: Decimal}}`` shape as
  :func:`investment_dashboard.adapters.yfinance_client.fetch_closes`, so it is a
  drop-in for the close store.

The token is **never** embedded here. Callers resolve it from the OS keyring /
Settings and pass it in, keeping this module trivially testable and secret-free.
It is sent as an ``Authorization: Token <token>`` header (not a URL query
param) so it never lands in request logs or proxies.

Tiingo covers **US** tickers only; non-US symbols simply come back empty, which
callers treat as "no Tiingo fallback available" (graceful, never an error).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

import httpx

from investment_dashboard.adapters._retry import RateLimitedError, retry_call

log = logging.getLogger(__name__)

_PROVIDER = "tiingo"

#: Tiingo API root. The IEX and daily endpoints hang off this.
TIINGO_ROOT = "https://api.tiingo.com"
DEFAULT_TIMEOUT_SECONDS = 10.0
#: Bounded retry budget for transient Tiingo failures (network blips, 5xx, 429).
#: Small so a genuinely-down API fails fast and yields back to the caller.
DEFAULT_ATTEMPTS = 3


class TiingoError(RuntimeError):
    """Raised when a Tiingo call fails or returns a fundamentally unusable payload."""


@dataclass(frozen=True)
class TiingoQuote:
    """One IEX quote: a live mark (equities) or the last NAV (funds).

    ``as_of`` is the quote's own timestamp normalised to naive UTC — present for
    a genuine intraday equity tick, and for a fund it is the NAV strike instant.
    ``value_date`` is the session/NAV date the price belongs to. ``price`` is the
    last traded price / NAV; ``previous_close`` is the prior settled close when
    Tiingo supplies it.
    """

    symbol: str
    price: Decimal
    previous_close: Decimal | None
    value_date: date
    as_of: datetime | None


def _record_status(status: str, message: str) -> None:
    """Lazy provider_status.record wrapper (mirrors the yfinance adapter).

    Imported inside the function to avoid the same eager ``services`` package
    circular import the yfinance adapter documents.
    """
    from investment_dashboard.services.provider_status import record  # noqa: PLC0415

    record(_PROVIDER, status, message)  # type: ignore[arg-type]  # str→Literal narrowing


def _auth_headers(token: str) -> dict[str, str]:
    """Build the auth + content headers. Token rides a header, never the URL."""
    if not token:
        raise TiingoError("Tiingo token is empty")
    return {"Authorization": f"Token {token}", "Content-Type": "application/json"}


def _get_with_retry(
    http: httpx.Client,
    url: str,
    *,
    params: dict[str, str],
    headers: dict[str, str],
    attempts: int = DEFAULT_ATTEMPTS,
) -> httpx.Response:
    """GET ``url`` with bounded retry/backoff (network errors, 429, 5xx)."""

    def _attempt() -> httpx.Response:
        try:
            response = http.get(url, params=params, headers=headers)
        except httpx.HTTPError as exc:
            raise TiingoError(f"Network error contacting Tiingo: {exc}") from exc
        if response.status_code == 429:
            retry_after = response.headers.get("Retry-After")
            raise RateLimitedError(
                "Tiingo returned HTTP 429 (rate limited)",
                retry_after=float(retry_after) if retry_after and retry_after.isdigit() else None,
            )
        if response.status_code >= 500:
            raise TiingoError(
                f"Tiingo returned HTTP {response.status_code}: {response.text[:200]}"
            )
        return response

    return retry_call(
        _attempt,
        attempts=attempts,
        retry_on=(TiingoError,),
        description="Tiingo request",
    )


def _to_decimal(value: Any) -> Decimal | None:
    """Parse a JSON number into Decimal without float drift, or ``None``."""
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return None


def _parse_timestamp(raw: Any) -> datetime | None:
    """Parse a Tiingo ISO-8601 timestamp into a naive UTC datetime, or ``None``."""
    if not isinstance(raw, str) or not raw:
        return None
    text = raw.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        # Fall back to a date-only string.
        try:
            return datetime.fromisoformat(raw[:10])
        except ValueError:
            return None
    if parsed.tzinfo is not None:
        return parsed.astimezone(UTC).replace(tzinfo=None)
    return parsed


def _parse_iex_row(row: dict[str, Any]) -> TiingoQuote | None:
    """Parse one IEX row into a :class:`TiingoQuote`, or ``None`` if unusable."""
    ticker = row.get("ticker")
    if not isinstance(ticker, str):
        return None
    price = _to_decimal(row.get("tngoLast"))
    if price is None:
        price = _to_decimal(row.get("last"))
    if price is None:
        return None
    as_of = _parse_timestamp(
        row.get("timestamp") or row.get("lastSaleTimestamp") or row.get("quoteTimestamp")
    )
    value_date = as_of.date() if as_of is not None else date.today()
    return TiingoQuote(
        symbol=ticker.upper(),
        price=price,
        previous_close=_to_decimal(row.get("prevClose")),
        value_date=value_date,
        as_of=as_of,
    )


def fetch_quotes(
    symbols: list[str],
    *,
    token: str,
    client: httpx.Client | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, TiingoQuote]:
    """Return ``{SYMBOL: TiingoQuote}`` from the IEX endpoint.

    One request covers all ``symbols`` (comma-joined). Equities get a live mark;
    mutual funds get their most recent NAV. Symbols Tiingo doesn't know are
    simply absent from the result (no error). Keys are upper-cased to match
    Tiingo's echo.
    """
    if not symbols:
        return {}

    tickers = ",".join(sorted(dict.fromkeys(s.strip() for s in symbols if s.strip())))
    if not tickers:
        return {}

    url = f"{TIINGO_ROOT}/iex/"
    owns_client = client is None
    http = client or httpx.Client(timeout=timeout)
    try:
        response = _get_with_retry(
            http, url, params={"tickers": tickers}, headers=_auth_headers(token)
        )
    finally:
        if owns_client:
            http.close()

    if response.status_code == 404:
        _record_status("error", f"Tiingo IEX 404 for {tickers}")
        return {}
    if response.status_code != 200:
        msg = f"Tiingo IEX returned HTTP {response.status_code}: {response.text[:200]}"
        _record_status("error", msg)
        raise TiingoError(msg)

    try:
        rows: Any = response.json()
    except ValueError as exc:
        raise TiingoError(f"Malformed Tiingo IEX payload: {exc}") from exc
    if not isinstance(rows, list):
        raise TiingoError("Unexpected Tiingo IEX payload (expected a list)")

    quotes: dict[str, TiingoQuote] = {}
    for row in rows:
        quote = _parse_iex_row(row) if isinstance(row, dict) else None
        if quote is not None:
            quotes[quote.symbol] = quote

    if quotes:
        _record_status("ok", f"IEX quotes for {len(quotes)} symbol(s): {tickers}")
    else:
        _record_status("error", f"IEX returned no usable quotes for {tickers}")
    return quotes


def _fetch_one_symbol_closes(
    http: httpx.Client,
    symbol: str,
    *,
    params: dict[str, str],
    headers: dict[str, str],
) -> dict[date, Decimal]:
    """Fetch and parse the daily-close rows for a single ticker.

    Returns ``{}`` for an unknown ticker (HTTP 404 — often non-US); raises
    :class:`TiingoError` on any other non-200 or a malformed body.
    """
    url = f"{TIINGO_ROOT}/tiingo/daily/{symbol}/prices"
    response = _get_with_retry(http, url, params=params, headers=headers)
    if response.status_code == 404:
        return {}
    if response.status_code != 200:
        msg = (
            f"Tiingo daily returned HTTP {response.status_code} for {symbol}: "
            f"{response.text[:200]}"
        )
        _record_status("error", msg)
        raise TiingoError(msg)
    try:
        rows: Any = response.json()
    except ValueError as exc:
        raise TiingoError(f"Malformed Tiingo daily payload for {symbol}: {exc}") from exc

    closes: dict[date, Decimal] = {}
    for row in rows if isinstance(rows, list) else []:
        day = _parse_timestamp(row.get("date")) if isinstance(row, dict) else None
        close = _to_decimal(row.get("close")) if isinstance(row, dict) else None
        if day is not None and close is not None:
            closes[day.date()] = close
    return closes


def fetch_closes(
    symbols: list[str],
    start: date,
    end: date,
    *,
    token: str,
    client: httpx.Client | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, dict[date, Decimal]]:
    """Return ``{symbol: {date: close}}`` over the inclusive range ``[start, end]``.

    Mirrors :func:`yfinance_client.fetch_closes` so it can drop into the close
    store as a fallback. Tiingo's daily endpoint is **per-ticker**, so this issues
    one request per symbol; a symbol with no data (unknown/non-US, or 404) maps to
    an empty dict rather than raising, matching the primary's "asked but not
    delivered" contract.
    """
    if end < start:
        raise ValueError(f"end ({end}) precedes start ({start})")
    if not symbols:
        return {}

    headers = _auth_headers(token)
    params = {
        "startDate": start.isoformat(),
        "endDate": end.isoformat(),
        "format": "json",
        "resampleFreq": "daily",
    }

    owns_client = client is None
    http = client or httpx.Client(timeout=timeout)
    result: dict[str, dict[date, Decimal]] = {s: {} for s in symbols}
    try:
        for symbol in symbols:
            clean = symbol.strip()
            if clean:
                result[symbol] = _fetch_one_symbol_closes(
                    http, clean, params=params, headers=headers
                )
    finally:
        if owns_client:
            http.close()

    delivered = [s for s in symbols if result.get(s)]
    missing = [s for s in symbols if not result.get(s)]
    if not missing:
        _record_status("ok", f"Daily closes for {len(symbols)} symbol(s) {start}..{end}")
    elif not delivered:
        _record_status("error", f"No Tiingo daily data for any of {missing[:5]}")
    else:
        _record_status(
            "partial",
            f"{len(delivered)}/{len(symbols)} symbol(s) returned Tiingo data; "
            f"missing: {missing[:5]}" + ("…" if len(missing) > 5 else ""),
        )
    return result


def fetch_latest_close(
    symbol: str,
    *,
    token: str,
    lookback_days: int = 10,
    client: httpx.Client | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> tuple[date, Decimal] | None:
    """Return the most recent ``(date, close)`` for ``symbol``, or ``None``.

    A small daily window is fetched and the latest row returned — the "last
    settled close" fallback used when the primary is missing/stale for a symbol.
    """
    from datetime import timedelta  # noqa: PLC0415

    end = date.today()
    start = end - timedelta(days=max(lookback_days, 1))
    closes = fetch_closes([symbol], start, end, token=token, client=client, timeout=timeout).get(
        symbol, {}
    )
    if not closes:
        return None
    latest = max(closes)
    return latest, closes[latest]
