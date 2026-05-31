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


def dual_currency_amounts(
    *,
    native_currency: str,
    net_native: Decimal | None,
    net_eur: Decimal | None,
    on: date,
    eur_to_usd: Mapping[date, Decimal],
    fallback_rate: Decimal | None = None,
) -> tuple[Decimal | None, Decimal | None]:
    """Return ``(eur, usd)`` for one cashflow using the **trade-date** FX rate.

    The native side is always the booked amount; the *other* side is derived
    from the EUR→USD rate that was in force on ``on`` (forward-filled to the
    most recent prior business day, matching the rest of the dashboard's FX
    policy). This is the single source of truth for "what was this worth in
    the other currency on the day it happened":

    * **USD-native** (the common case) — ``usd = net_native`` and
      ``eur = net_native / rate``. A previously stored ``net_eur`` is honoured
      only when no trade-date rate is on file, so historical rows still render
      something rather than an em dash when FX history is sparse.
    * **EUR-native** (the rare, "flipped" case) — ``eur = net_native`` and
      ``usd = net_native * rate``.
    * **Any other native currency** — falls back to the stored ``net_eur`` as
      the EUR leg and derives USD from it.

    ``fallback_rate`` (typically the *current* EUR→USD spot) is used only when
    the trade-date lookup yields nothing, so the derived side is at least
    populated. Either element of the tuple is ``None`` when it genuinely can't
    be computed (no native amount and no usable rate).
    """
    rate = lookup_rate_with_forward_fill(eur_to_usd, on)
    ncur = (native_currency or "").upper()
    eur: Decimal | None
    usd: Decimal | None
    if ncur == "USD":
        # USD is booked; EUR is derived. Use the trade-date rate for
        # historical correctness and only fall back to a previously stored
        # ``net_eur`` (never today's spot, which would distort old rows).
        usd = net_native
        eur = (
            net_native / rate
            if rate is not None and rate != 0 and net_native is not None
            else net_eur
        )
        return eur, usd
    # For EUR-native / other currencies the USD leg has nothing stored, so a
    # current-spot ``fallback_rate`` is acceptable to at least populate it
    # when the row predates the FX history.
    if rate is None or rate == 0:
        rate = fallback_rate
    usable = rate is not None and rate != 0
    if ncur == "EUR":
        eur = net_native if net_native is not None else net_eur
        usd = eur * rate if (eur is not None and usable and rate is not None) else None
        return eur, usd
    # Any other native currency (rare): trust the stored EUR leg.
    eur = net_eur
    usd = eur * rate if (eur is not None and usable and rate is not None) else None
    return eur, usd
