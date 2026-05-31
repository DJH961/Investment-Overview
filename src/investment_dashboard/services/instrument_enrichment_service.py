"""Instrument-enrichment service — fill in metadata the importer didn't know.

The CSV importer no longer hard-codes ``asset_class="etf"`` (it used to,
because parsers had no taxonomy signal). v2.2 phase (b) flips the
default to ``"unknown"`` and delegates classification to this service.

Strategy per symbol:

1. Look at the live ``Instrument`` row. If the importer or a prior
   enrichment pass already filled in ``name`` / ``asset_class`` / TER /
   ``native_currency``, leave those alone — we don't want to overwrite
   user-corrected data with whatever yfinance returns today.
2. For every still-missing or ``"unknown"`` field, call
   :func:`investment_dashboard.adapters.yfinance_client.
   fetch_instrument_info` (cached per-process) and fill the gap.

Effective-display composition (override → ledger → default) is a
separate function — :func:`effective_instrument` — used by every read
path so override / ledger precedence stays consistent.

The service tolerates a missing or unusable yfinance payload: a single
network blip never blocks an import, and the row stays as ``unknown``
to be retried on the next refresh.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.adapters.yfinance_client import (
    InstrumentInfo,
    fetch_instrument_info,
)
from investment_dashboard.models import Instrument, InstrumentOverride
from investment_dashboard.repositories import instruments_repo

log = logging.getLogger(__name__)


#: yfinance ``quoteType`` → ledger ``asset_class``. Unknown values stay
#: ``"unknown"`` so the user (or a later yfinance schema change) gets a
#: chance to disambiguate. ``CURRENCY``/``CRYPTOCURRENCY`` are
#: intentionally unmapped — those instruments don't fit our taxonomy.
QUOTE_TYPE_MAP: dict[str, str] = {
    "ETF": "etf",
    "EQUITY": "stock",
    "MUTUALFUND": "mutual_fund",
    "INDEX": "etf",  # indices behave like ETFs for our refresh/display purposes
}


@dataclass(frozen=True)
class EffectiveInstrument:
    """Override-merged view of one :class:`Instrument` for display.

    Read paths (positions table, treemap, analytics) call
    :func:`effective_instrument` instead of touching ``Instrument``
    directly so the override precedence rule is enforced in exactly
    one place.
    """

    id: int
    symbol: str
    name: str | None
    asset_class: str
    native_currency: str
    expense_ratio: Decimal | None
    category: str | None


def effective_instrument(
    instrument: Instrument,
    override: InstrumentOverride | None,
) -> EffectiveInstrument:
    """Compose the display-effective view of ``instrument``.

    Precedence (highest first): override → ledger → default. The
    asset-class default is ``"unknown"`` (matches the migration); other
    fields default to ``None``.
    """
    if override is None:
        return EffectiveInstrument(
            id=instrument.id,
            symbol=instrument.symbol,
            name=instrument.name,
            asset_class=instrument.asset_class or "unknown",
            native_currency=instrument.native_currency,
            expense_ratio=instrument.expense_ratio,
            category=None,
        )
    name = override.name_override or instrument.name
    asset_class = override.asset_class_override or instrument.asset_class or "unknown"
    expense_ratio = (
        override.expense_ratio_override
        if override.expense_ratio_override is not None
        else instrument.expense_ratio
    )
    return EffectiveInstrument(
        id=instrument.id,
        symbol=instrument.symbol,
        name=name,
        asset_class=asset_class,
        native_currency=instrument.native_currency,
        expense_ratio=expense_ratio,
        category=override.category,
    )


@dataclass(frozen=True)
class InstrumentSuggestion:
    """Market-data-derived field suggestions for the Settings UI.

    Returned by :func:`suggest_instrument_fields` so the "Fetch from
    market data" button can pre-fill the add-instrument form (asset
    class, category, expense ratio, name, native currency) instead of
    the user typing them by hand. Every field is ``None`` when yfinance
    has nothing useful, so the UI can leave that input untouched.
    """

    name: str | None
    asset_class: str | None
    native_currency: str | None
    expense_ratio: Decimal | None
    category: str | None


def suggest_instrument_fields(
    symbol: str,
    *,
    fetcher: Any = None,
) -> InstrumentSuggestion:
    """Resolve display fields for ``symbol`` straight from market data.

    Pure read helper (no DB writes) used by the Settings add-instrument
    dialog: it fetches the yfinance payload and maps it onto our ledger
    taxonomy. ``fetcher`` matches :func:`fetch_instrument_info` for test
    injection. Returns an all-``None`` suggestion when the symbol is
    blank or yfinance has nothing.
    """
    sym = (symbol or "").strip().upper()
    if not sym:
        return InstrumentSuggestion(None, None, None, None, None)
    fetch = fetcher or fetch_instrument_info
    try:
        info = fetch(sym)
    except Exception:  # pragma: no cover - defensive, fetch_* swallows
        log.warning("suggestion fetch failed for %s", sym, exc_info=True)
        info = None
    if info is None:
        return InstrumentSuggestion(None, None, None, None, None)
    asset_class = QUOTE_TYPE_MAP.get(info.quote_type) if info.quote_type else None
    return InstrumentSuggestion(
        name=info.long_name,
        asset_class=asset_class,
        native_currency=info.currency,
        expense_ratio=info.expense_ratio,
        category=info.category,
    )


def enrich_instrument(
    session: Session,
    instrument_id: int,
    *,
    fetcher: Any = None,
) -> Instrument:
    """Fill missing metadata on ``instrument_id`` from yfinance.

    ``fetcher`` matches :func:`fetch_instrument_info` and exists for
    test injection. Only **missing** fields are written — already-set
    values (including manual ones) are preserved. The function returns
    the (possibly-updated) instrument row.

    Synthetic asset classes (``cash`` / ``savings``) are never
    enriched — they have no yfinance ticker.
    """
    instr = session.get(Instrument, instrument_id)
    if instr is None:
        raise ValueError(f"Instrument {instrument_id} not found")
    if instr.asset_class in {"cash", "savings"}:
        return instr

    needs_name = not instr.name
    needs_class = instr.asset_class == "unknown"
    needs_ter = instr.expense_ratio is None
    needs_currency = not instr.native_currency
    if not any((needs_name, needs_class, needs_ter, needs_currency)):
        return instr

    fetch = fetcher or fetch_instrument_info
    info: InstrumentInfo | None
    try:
        info = fetch(instr.symbol)
    except Exception:  # pragma: no cover - defensive, fetch_* swallows
        log.warning("enrichment fetch failed for %s", instr.symbol, exc_info=True)
        info = None
    if info is None:
        return instr

    updated = False
    if needs_name and info.long_name:
        instr.name = info.long_name
        updated = True
    if needs_class and info.quote_type:
        mapped = QUOTE_TYPE_MAP.get(info.quote_type)
        if mapped is not None:
            instr.asset_class = mapped
            updated = True
    if needs_ter and info.expense_ratio is not None:
        instr.expense_ratio = info.expense_ratio
        updated = True
    if needs_currency and info.currency:
        instr.native_currency = info.currency
        updated = True
    if updated:
        session.flush()
    return instr


def ensure_instrument(
    session: Session,
    *,
    symbol: str,
    fallback_native_currency: str,
    parsed_name: str | None = None,
    parsed_asset_class: str | None = None,
    parsed_native_currency: str | None = None,
    parsed_expense_ratio: Decimal | None = None,
    fetcher: Any = None,
) -> Instrument:
    """Get-or-create an :class:`Instrument` and run enrichment in one call.

    Used by the importer: the parser hands over whatever fields it
    could read off the row, this function seeds the ledger from those,
    falls back to yfinance for the gaps, and finally falls back to
    ``"unknown"`` / the account's native currency. The result is then
    safe to attach to a new ``Transaction``.
    """
    instr = instruments_repo.get_or_create(
        session,
        symbol=symbol,
        name=parsed_name,
        asset_class=parsed_asset_class or "unknown",
        native_currency=parsed_native_currency or fallback_native_currency,
        expense_ratio=parsed_expense_ratio,
    )
    # ``get_or_create`` only sets fields on *insert*; for an existing row
    # we may still need to fill gaps. Try the parser-supplied values
    # first (cheap, no network), then enrichment.
    if parsed_name and not instr.name:
        instr.name = parsed_name
    if parsed_asset_class and instr.asset_class == "unknown":
        instr.asset_class = parsed_asset_class
    if parsed_expense_ratio is not None and instr.expense_ratio is None:
        instr.expense_ratio = parsed_expense_ratio
    if parsed_native_currency and (instr.native_currency in {"", fallback_native_currency}):
        # Only override the fallback-default native currency; never
        # touch a non-fallback value (it was probably set deliberately).
        instr.native_currency = parsed_native_currency
    session.flush()

    return enrich_instrument(session, instr.id, fetcher=fetcher)
