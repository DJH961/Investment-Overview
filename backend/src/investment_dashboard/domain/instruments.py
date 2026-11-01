"""Canonical instrument asset-class sets and effective money-market test."""

from __future__ import annotations

from typing import Protocol

from investment_dashboard.domain.money_market import is_money_market

#: Priced synthetically (flat 1.0), never fetched from a provider.
SYNTHETIC_ASSET_CLASSES: frozenset[str] = frozenset({"cash", "savings"})
#: Priced from an end-of-day NAV (published after the close), not intraday.
NAV_ASSET_CLASSES: frozenset[str] = frozenset({"mutual_fund"})


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


def is_money_market_effective(instrument: _HasIdentity, effective: _Effective | None) -> bool:
    """Money-market test using the override-aware asset class and name when present."""
    src: _Effective = effective if effective is not None else instrument
    return is_money_market(instrument.symbol, asset_class=src.asset_class, name=src.name)
