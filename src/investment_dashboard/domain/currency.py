"""FX conversion helpers.

Convention (spec §4.1 ``fx_history``): rates are stored as ``EUR → quote``,
i.e. ``rate`` is *quote per 1 EUR*. So with ``rate = 1.085`` for
``base=EUR, quote=USD``, 1 EUR = 1.085 USD, and conversely
``eur_amount = usd_amount / 1.085``.

All functions operate on :class:`decimal.Decimal` to preserve precision.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from decimal import Decimal


def native_to_eur(amount: Decimal, fx_rate_eur_to_native: Decimal) -> Decimal:
    """Convert ``amount`` (in some non-EUR currency) to EUR.

    ``fx_rate_eur_to_native`` is *native per 1 EUR* (the storage convention
    in ``fx_history``). To go the other way: ``eur = native / rate``.
    """
    if fx_rate_eur_to_native <= 0:
        raise ValueError(f"FX rate must be positive, got {fx_rate_eur_to_native}")
    return amount / fx_rate_eur_to_native


def eur_to_native(amount_eur: Decimal, fx_rate_eur_to_native: Decimal) -> Decimal:
    """Convert a EUR amount to the native currency."""
    if fx_rate_eur_to_native <= 0:
        raise ValueError(f"FX rate must be positive, got {fx_rate_eur_to_native}")
    return amount_eur * fx_rate_eur_to_native


def lookup_rate_with_forward_fill(
    rates_by_date: Mapping[date, Decimal],
    target: date,
) -> Decimal | None:
    """Return the rate for ``target``; if missing, the most recent prior rate.

    Frankfurter only publishes business-day rates, so weekend / holiday
    cashflows must inherit the most recent prior business day's rate.
    Returns ``None`` if no prior rate exists.
    """
    if target in rates_by_date:
        return rates_by_date[target]
    prior = [d for d in rates_by_date if d <= target]
    if not prior:
        return None
    return rates_by_date[max(prior)]
