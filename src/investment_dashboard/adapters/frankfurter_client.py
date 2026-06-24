"""Frankfurter FX-rate adapter.

The Frankfurter API (https://frankfurter.dev) is a free, ECB-sourced JSON
endpoint that returns daily exchange rates since 1999. Used here to convert
USD broker cashflows into EUR at the spot rate on each transaction's date.

We always treat ``EUR`` as the base. The returned rate is *quote-per-base*,
i.e. with ``base=EUR, quote=USD, rate=1.085`` ⇒ ``1 EUR = 1.085 USD``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Any

import httpx

from investment_dashboard.adapters._retry import RateLimitedError, retry_call

BASE_URL = "https://api.frankfurter.dev/v1"
DEFAULT_TIMEOUT_SECONDS = 10.0
#: Bounded retry budget for transient Frankfurter failures (network blips,
#: 5xx, HTTP 429). Kept small so a genuinely-down API fails fast.
DEFAULT_ATTEMPTS = 3


def _get_with_retry(
    http: httpx.Client,
    url: str,
    params: dict[str, str],
    *,
    attempts: int,
) -> httpx.Response:
    """GET ``url`` with bounded retry/backoff.

    Network errors and HTTP 429/5xx are treated as transient and retried;
    a 429 is surfaced as :class:`RateLimitedError` so the backoff honours any
    ``Retry-After`` header. Non-retryable 4xx responses are returned as-is for
    the caller to translate into a :class:`FrankfurterError`.
    """

    def _attempt() -> httpx.Response:
        try:
            response = http.get(url, params=params)
        except httpx.HTTPError as exc:
            raise FrankfurterError(f"Network error contacting Frankfurter: {exc}") from exc
        if response.status_code == 429:
            retry_after = response.headers.get("Retry-After")
            raise RateLimitedError(
                "Frankfurter returned HTTP 429 (rate limited)",
                retry_after=float(retry_after) if retry_after and retry_after.isdigit() else None,
            )
        if response.status_code >= 500:
            raise FrankfurterError(
                f"Frankfurter returned HTTP {response.status_code}: {response.text[:200]}"
            )
        return response

    return retry_call(
        _attempt,
        attempts=attempts,
        retry_on=(FrankfurterError,),
        description="Frankfurter request",
    )


class FrankfurterError(RuntimeError):
    """Raised when the Frankfurter API call fails or returns malformed data."""


@dataclass(frozen=True)
class FxRateRecord:
    """One day's FX rate, base→quote."""

    date: date
    base: str
    quote: str
    rate: Decimal


def fetch_rates(
    start: date,
    end: date,
    *,
    base: str = "EUR",
    quote: str = "USD",
    client: httpx.Client | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> list[FxRateRecord]:
    """Fetch daily FX rates in the closed interval ``[start, end]``.

    Frankfurter returns rates for business days only; weekends and ECB
    holidays simply do not appear. Callers that need a continuous daily
    series can forward-fill from the most recent prior business day.

    A window with **no published rates yet** (e.g. a single-day request for
    today before the ~16:00 CET ECB publication, or an all-weekend window)
    yields an empty list rather than an error: Frankfurter answers such a
    range with ``404 {"message":"not found"}``, which we treat as "nothing
    new" so callers can no-op cleanly.

    Raises
    ------
    FrankfurterError
        On non-2xx responses (other than the benign 404 above), transport
        failures, or unexpected payloads.
    """
    if end < start:
        raise ValueError(f"end ({end}) precedes start ({start})")
    if len(base) != 3 or len(quote) != 3:
        raise ValueError("ISO 4217 currency codes must be 3 letters")

    url = f"{BASE_URL}/{start.isoformat()}..{end.isoformat()}"
    params = {"base": base, "symbols": quote}

    owns_client = client is None
    http = client or httpx.Client(timeout=timeout)
    try:
        response = _get_with_retry(http, url, params, attempts=DEFAULT_ATTEMPTS)
    finally:
        if owns_client:
            http.close()

    if response.status_code == 404:
        # Frankfurter answers ``404 {"message":"not found"}`` for a date range
        # that contains *no published business-day rates*. The common trigger is
        # a single-day window for **today** before the ECB publishes its daily
        # reference rates (~16:00 CET), or any window that falls entirely on
        # weekends/holidays. That's a benign "nothing new yet" signal rather than
        # a failure — the live intraday spot already covers today — so we return
        # an empty series and let the caller no-op instead of recording an error.
        return []

    if response.status_code != 200:
        raise FrankfurterError(
            f"Frankfurter returned HTTP {response.status_code}: {response.text[:200]}"
        )

    try:
        payload: dict[str, Any] = response.json()
        rates_by_date: dict[str, dict[str, float]] = payload["rates"]
    except (ValueError, KeyError, TypeError) as exc:
        raise FrankfurterError(f"Malformed response payload: {exc}") from exc

    records: list[FxRateRecord] = []
    for day_str, quote_map in rates_by_date.items():
        try:
            day = datetime.strptime(day_str, "%Y-%m-%d").date()
            raw = quote_map[quote]
        except (ValueError, KeyError) as exc:
            raise FrankfurterError(f"Unexpected row for {day_str}: {exc}") from exc
        # Round-trip through str to preserve Frankfurter's printed precision.
        records.append(FxRateRecord(date=day, base=base, quote=quote, rate=Decimal(str(raw))))

    records.sort(key=lambda r: r.date)
    return records


def fetch_latest(
    *,
    base: str = "EUR",
    quote: str = "USD",
    client: httpx.Client | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> FxRateRecord:
    """Fetch the most recent available rate."""
    url = f"{BASE_URL}/latest"
    params = {"base": base, "symbols": quote}

    owns_client = client is None
    http = client or httpx.Client(timeout=timeout)
    try:
        response = _get_with_retry(http, url, params, attempts=DEFAULT_ATTEMPTS)
    finally:
        if owns_client:
            http.close()

    if response.status_code != 200:
        raise FrankfurterError(
            f"Frankfurter returned HTTP {response.status_code}: {response.text[:200]}"
        )

    try:
        payload: dict[str, Any] = response.json()
        day = datetime.strptime(payload["date"], "%Y-%m-%d").date()
        raw = payload["rates"][quote]
    except (ValueError, KeyError, TypeError) as exc:
        raise FrankfurterError(f"Malformed response payload: {exc}") from exc

    return FxRateRecord(date=day, base=base, quote=quote, rate=Decimal(str(raw)))
