"""Euro-area HICP adapter (ECB Data Portal, 7.4 P10).

The real euro return divides the nominal EUR return by the change in consumer
prices over the same months. The index is the euro-area **HICP, all items,
monthly, not seasonally adjusted**, as published by Eurostat and served by the
ECB Data Portal:

* **Series key:** ``HICP.M.U2.N.000000.4D0.INX`` (dataflow ``HICP``; dimensions
  FREQ=M, REF_AREA=U2 "Euro area, changing composition", ADJUSTMENT=N,
  ICP_ITEM=000000 "HICP - Total", DATA_PROVIDER=4D0 Eurostat, ICP_SUFFIX=INX
  "Index"). Base **2025 = 100**. Checked with a real call on 25 Nov 2026: latest
  month 2026-10 (104.8), history back to 1990 (early months blank).
* The old key ``ICP.M.U2.N.000000.4.INX`` (2015 = 100) was discontinued on
  4 Feb 2026, when Eurostat changed the HICP method and the ECB replaced the ICP
  dataset with ``HICP``. Do not go back to it.
* **Licence:** ECB statistics may be reused free of charge, including
  commercially, provided the source is acknowledged ("Source: ECB, Eurostat").
  No key, no account; the request carries no personal data.

Only ratios of the index are used (``HICP[m1] / HICP[m0]``), so the base year
does not matter, but a series is never mixed with another base.

The index is published about two weeks after the month ends, so the latest
month is always behind today; callers label figures "to <month>".
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

import httpx

from investment_dashboard.adapters._retry import RateLimitedError, retry_call

BASE_URL = "https://data-api.ecb.europa.eu/service/data"
SERIES_KEY = "HICP.M.U2.N.000000.4D0.INX"
#: Shown next to every figure built from the index.
SOURCE_LABEL = "ECB, Eurostat (HICP, euro area)"
DEFAULT_TIMEOUT_SECONDS = 20.0
DEFAULT_ATTEMPTS = 3


class HicpError(RuntimeError):
    """The ECB call failed or returned something that is not the index."""


@dataclass(frozen=True)
class HicpMonth:
    """One month's index value (``month`` is ``YYYY-MM``)."""

    month: str
    value: Decimal


def _url(series_key: str) -> str:
    flow, _, key = series_key.partition(".")
    return f"{BASE_URL}/{flow}/{key}"


def _get(http: httpx.Client, url: str, params: dict[str, str], attempts: int) -> httpx.Response:
    def _attempt() -> httpx.Response:
        try:
            response = http.get(url, params=params)
        except httpx.HTTPError as exc:
            raise HicpError(f"Network error contacting the ECB: {exc}") from exc
        if response.status_code == 429:
            retry_after = response.headers.get("Retry-After")
            raise RateLimitedError(
                "ECB returned HTTP 429 (rate limited)",
                retry_after=float(retry_after) if retry_after and retry_after.isdigit() else None,
            )
        if response.status_code >= 500:
            raise HicpError(f"ECB returned HTTP {response.status_code}")
        return response

    return retry_call(_attempt, attempts=attempts, retry_on=(HicpError,), description="ECB HICP")


def _valid_month(raw: str) -> bool:
    if len(raw) != 7 or raw[4] != "-":
        return False
    year, month = raw[:4], raw[5:]
    return year.isdigit() and month.isdigit() and 1 <= int(month) <= 12


def parse_csv(text: str) -> list[HicpMonth]:
    """``csvdata`` rows to months, oldest first; blank observations are skipped."""
    reader = csv.DictReader(io.StringIO(text))
    if reader.fieldnames is None or not {"TIME_PERIOD", "OBS_VALUE"} <= set(reader.fieldnames):
        raise HicpError("ECB answer has no TIME_PERIOD / OBS_VALUE columns")
    out: dict[str, Decimal] = {}
    for row in reader:
        month = (row.get("TIME_PERIOD") or "").strip()
        raw = (row.get("OBS_VALUE") or "").strip()
        if not raw:
            continue
        if not _valid_month(month):
            raise HicpError(f"unexpected TIME_PERIOD {month!r}")
        try:
            value = Decimal(raw)
        except InvalidOperation as exc:
            raise HicpError(f"unexpected OBS_VALUE {raw!r} for {month}") from exc
        if not value.is_finite() or value <= 0:
            raise HicpError(f"index for {month} is not positive: {raw}")
        out[month] = value
    return [HicpMonth(month=m, value=v) for m, v in sorted(out.items())]


def fetch_index(
    *,
    start_month: str | None = None,
    series_key: str = SERIES_KEY,
    client: httpx.Client | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> list[HicpMonth]:
    """The monthly index from ``start_month`` (``YYYY-MM``, inclusive) on, oldest first.

    No published month in the window (HTTP 404 "No Series") is an empty list.
    """
    if start_month is not None and not _valid_month(start_month):
        raise ValueError(f"start_month must be YYYY-MM, got {start_month!r}")
    params = {"format": "csvdata"}
    if start_month is not None:
        params["startPeriod"] = start_month
    owns = client is None
    http = client or httpx.Client(timeout=timeout)
    try:
        response = _get(http, _url(series_key), params, DEFAULT_ATTEMPTS)
    finally:
        if owns:
            http.close()
    if response.status_code == 404:
        return []
    if response.status_code != 200:
        raise HicpError(f"ECB returned HTTP {response.status_code}")
    if not response.text.strip():
        return []
    return parse_csv(response.text)
