"""Canonical instrument asset-class sets and effective money-market test."""

from __future__ import annotations

from collections.abc import Collection
from typing import Protocol

from investment_dashboard.domain.money_market import is_money_market

#: Priced synthetically (flat 1.0), never fetched from a provider.
SYNTHETIC_ASSET_CLASSES: frozenset[str] = frozenset({"cash", "savings"})
#: Priced from an end-of-day NAV (published after the close), not intraday.
NAV_ASSET_CLASSES: frozenset[str] = frozenset({"mutual_fund"})
#: Every asset class the ledger accepts (mirrors ``ck_instrument_asset_class``).
ASSET_CLASSES: tuple[str, ...] = ("etf", "mutual_fund", "stock", "cash", "savings", "unknown")

#: How an instrument gets its closes: fetched (``auto``), typed in as manual
#: price fixes (``manual``), or frozen at the last known close (``delisted``).
PRICING_AUTO = "auto"
PRICING_MANUAL = "manual"
PRICING_DELISTED = "delisted"
PRICING_MODES: tuple[str, ...] = (PRICING_AUTO, PRICING_MANUAL, PRICING_DELISTED)


def is_fetched(pricing_mode: str | None) -> bool:
    """Whether a provider is asked for this instrument's prices (``None`` = auto)."""
    return pricing_mode in (None, PRICING_AUTO)


def fetch_symbol(symbol: str, provider_symbol: str | None) -> str:
    """The ticker to send to the price provider (the mapping, else the ledger symbol)."""
    return provider_symbol or symbol


def is_synthetic(asset_class: str | None) -> bool:
    return asset_class in SYNTHETIC_ASSET_CLASSES


def is_nav_priced(asset_class: str | None) -> bool:
    return asset_class in NAV_ASSET_CLASSES


class _HasIdentity(Protocol):
    symbol: str
    asset_class: str | None
    name: str | None


class _Effective(Protocol):
    asset_class: str | None
    name: str | None


def is_money_market_effective(
    instrument: _HasIdentity,
    effective: _Effective | None,
    extra_symbols: Collection[str] = (),
) -> bool:
    """Money-market test using the override-aware asset class and name when present."""
    src: _Effective = effective if effective is not None else instrument
    return is_money_market(
        instrument.symbol, asset_class=src.asset_class, name=src.name, extra_symbols=extra_symbols
    )
