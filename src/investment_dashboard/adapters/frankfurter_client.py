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

BASE_URL = "https://api.frankfurter.dev/v1"
DEFAULT_TIMEOUT_SECONDS = 10.0


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

    Raises
    ------
    FrankfurterError
        On non-2xx responses, transport failures, or unexpected payloads.
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
        response = http.get(url, params=params)
    except httpx.HTTPError as exc:
        raise FrankfurterError(f"Network error contacting Frankfurter: {exc}") from exc
    finally:
        if owns_client:
            http.close()

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
        response = http.get(url, params=params)
    except httpx.HTTPError as exc:
        raise FrankfurterError(f"Network error contacting Frankfurter: {exc}") from exc
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
