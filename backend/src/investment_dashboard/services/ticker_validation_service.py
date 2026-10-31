"""Ticker-validation service — a *validated* path for picking instruments.

Onboarding lets the user add their own tickers (e.g. the ambiguous DAX ETF).
Free-form symbol entry is error-prone: a typo or a wrong-exchange suffix
silently seeds an instrument that never prices. This service gives the UI a
single call that confirms a symbol actually resolves on the market-data
provider *before* it is written to the ledger, so the user can't pick
"something dumb/incorrect".

A symbol is considered :pyattr:`TickerValidation.valid` only when the provider
returns recognisable metadata **and** at least one recent close — i.e. the
ticker both exists and prices. The resolved name / asset-class / currency are
returned so the UI can pre-fill the add form and the user can eyeball that the
match is what they meant (e.g. "Global X DAX Germany ETF", not a German-listed
UCITS clone).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any

from investment_dashboard.adapters.yfinance_client import (
    InstrumentInfo,
    PriceRecord,
    fetch_instrument_info,
    fetch_latest_close,
)
from investment_dashboard.services.instrument_enrichment_service import QUOTE_TYPE_MAP

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class TickerValidation:
    """Outcome of validating a single ticker symbol.

    ``valid`` is the only field the UI must gate on; the rest are best-effort
    metadata to pre-fill the add form and let the user sanity-check the match.
    """

    symbol: str
    valid: bool
    message: str
    name: str | None = None
    asset_class: str | None = None
    quote_type: str | None = None
    native_currency: str | None = None
    expense_ratio: Decimal | None = None
    latest_close: Decimal | None = None
    latest_close_date: date | None = None


#: Exchange qualifiers some users paste in front of a symbol (Google/TradingView
#: style, e.g. ``NASDAQ:DAX``). yfinance wants the bare ticker, so we strip a
#: recognised leading ``EXCHANGE:`` prefix before looking the symbol up — this
#: is why a freshly-added ``NASDAQ:DAX`` failed to price (it was queried
#: verbatim and matched nothing, or fell through to the German index).
_EXCHANGE_PREFIXES: frozenset[str] = frozenset(
    {
        "NASDAQ",
        "NYSE",
        "NYSEARCA",
        "ARCA",
        "AMEX",
        "BATS",
        "CBOE",
        "OTC",
        "OTCMKTS",
        "LON",
        "LSE",
        "ETR",
        "FRA",
        "XETRA",
        "EPA",
        "BME",
        "TSE",
        "TSX",
        "ASX",
    }
)


def normalize_symbol(symbol: str) -> str:
    """Upper-case, trim, and strip an ``EXCHANGE:`` prefix from a symbol.

    yfinance expects the bare ticker (``DAX``), not a Google/TradingView-style
    ``EXCHANGE:TICKER`` (``NASDAQ:DAX``). Only a recognised exchange prefix is
    removed, so a symbol that legitimately contains a colon is left untouched.
    """
    cleaned = symbol.strip().upper()
    prefix, sep, rest = cleaned.partition(":")
    if sep and rest and prefix in _EXCHANGE_PREFIXES:
        return rest.strip()
    return cleaned


def validate_ticker(
    symbol: str,
    *,
    info_fetcher: Any = None,
    close_fetcher: Any = None,
) -> TickerValidation:
    """Confirm ``symbol`` resolves to a real, priceable instrument.

    ``info_fetcher`` / ``close_fetcher`` match
    :func:`fetch_instrument_info` / :func:`fetch_latest_close` and exist for
    test injection. Network / provider errors are swallowed and surfaced as a
    failed (but non-raising) validation so the onboarding UI never crashes on a
    flaky lookup.
    """
    normalized = normalize_symbol(symbol)
    if not normalized:
        return TickerValidation(
            symbol=normalized,
            valid=False,
            message="Enter a ticker symbol to validate.",
        )

    get_info = info_fetcher or fetch_instrument_info
    get_close = close_fetcher or fetch_latest_close

    info: InstrumentInfo | None
    try:
        info = get_info(normalized)
    except Exception:  # pragma: no cover - adapter already swallows most
        log.warning("ticker validation: info lookup failed for %s", normalized, exc_info=True)
        info = None

    latest: PriceRecord | None
    try:
        latest = get_close(normalized)
    except Exception:  # pragma: no cover - defensive
        log.warning("ticker validation: close lookup failed for %s", normalized, exc_info=True)
        latest = None

    has_metadata = info is not None and bool(info.long_name or info.quote_type)
    has_price = latest is not None

    asset_class = (
        QUOTE_TYPE_MAP.get(info.quote_type) if info is not None and info.quote_type else None
    )

    if not has_metadata and not has_price:
        return TickerValidation(
            symbol=normalized,
            valid=False,
            message=(
                f"'{normalized}' did not resolve to any instrument. Check the symbol "
                "and exchange suffix (e.g. NASDAQ-listed 'DAX', not 'DAX.DE')."
            ),
        )

    if not has_price:
        return TickerValidation(
            symbol=normalized,
            valid=False,
            message=(
                f"'{normalized}' resolved but has no recent price data, so it can't be "
                "tracked. Double-check the symbol."
            ),
            name=info.long_name if info else None,
            asset_class=asset_class,
            quote_type=info.quote_type if info else None,
            native_currency=info.currency if info else None,
            expense_ratio=info.expense_ratio if info else None,
        )

    name = (info.long_name if info else None) or None
    currency = (info.currency if info else None) or None
    pretty_name = name or normalized
    close_str = f"{latest.close} {currency or ''}".strip()
    return TickerValidation(
        symbol=normalized,
        valid=True,
        message=(
            f"✓ {normalized} — {pretty_name}. Last close {close_str} on {latest.date.isoformat()}."
        ),
        name=name,
        asset_class=asset_class,
        quote_type=info.quote_type if info else None,
        native_currency=currency,
        expense_ratio=info.expense_ratio if info else None,
        latest_close=latest.close,
        latest_close_date=latest.date,
    )
