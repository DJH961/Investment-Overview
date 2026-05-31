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


def split_native_to_dual_legs(
    *,
    native_currency: str,
    net_native: Decimal | None,
    eur_to_usd_rate: Decimal | None,
    native_to_eur_rate: Decimal | None = None,
) -> tuple[Decimal | None, Decimal | None]:
    """Split one native cash amount into frozen ``(net_eur, net_usd)`` legs.

    This is the **write-time** counterpart to :func:`dual_currency_amounts`:
    it freezes both currency legs of a transaction at the trade-date rate so
    they can be persisted once and never recomputed. The native leg is always
    the booked amount and is preserved exactly; the other leg is derived.

    * **USD-native** (the common case) — ``net_usd = net_native`` exactly and
      ``net_eur = net_native / eur_to_usd_rate``.
    * **EUR-native** — ``net_eur = net_native`` exactly and
      ``net_usd = net_native * eur_to_usd_rate``.
    * **Any other native currency** — ``net_eur = net_native /
      native_to_eur_rate`` and ``net_usd = net_eur * eur_to_usd_rate``.

    All rates are *quote per 1 EUR* (the ``fx_history`` storage convention).
    Each leg is ``None`` when it genuinely can't be computed (missing native
    amount or missing rate), signalling the caller that FX history was
    incomplete and the row should be revisited.
    """
    ccy = (native_currency or "").upper()
    if net_native is None:
        return None, None
    usd_ok = eur_to_usd_rate is not None and eur_to_usd_rate != 0
    net_eur: Decimal | None
    net_usd: Decimal | None
    if ccy == "USD":
        net_usd = net_native
        net_eur = net_native / eur_to_usd_rate if usd_ok and eur_to_usd_rate is not None else None
        return net_eur, net_usd
    if ccy == "EUR":
        net_eur = net_native
        net_usd = net_native * eur_to_usd_rate if usd_ok and eur_to_usd_rate is not None else None
        return net_eur, net_usd
    # Any other native currency: derive EUR via its own EUR→native rate,
    # then USD from the EUR leg.
    native_ok = native_to_eur_rate is not None and native_to_eur_rate != 0
    net_eur = (
        net_native / native_to_eur_rate if native_ok and native_to_eur_rate is not None else None
    )
    if net_eur is None:
        return None, None
    net_usd = net_eur * eur_to_usd_rate if usd_ok and eur_to_usd_rate is not None else None
    return net_eur, net_usd


def dual_currency_amounts(
    *,
    native_currency: str,
    net_native: Decimal | None,
    net_eur: Decimal | None,
    on: date,
    eur_to_usd: Mapping[date, Decimal],
    fallback_rate: Decimal | None = None,
    net_usd: Decimal | None = None,
) -> tuple[Decimal | None, Decimal | None]:
    """Return ``(eur, usd)`` for one cashflow using the **trade-date** FX rate.

    When both frozen legs are supplied (``net_eur`` *and* ``net_usd``, as
    persisted at import / manual entry since v2.9) they are returned verbatim
    — the row was already valued once at the trade-date rate, so there's no
    need to re-derive anything and no FX history is consulted. This is the
    fast, consistent path for the common case.

    Otherwise the value is derived live (legacy behaviour, kept for rows that
    predate the backfill or were written during an FX-history gap): the native
    side is always the booked amount; the *other* side is derived from the
    EUR→USD rate in force on ``on`` (forward-filled to the most recent prior
    business day):

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
    # Fast path: both legs were frozen at write time — trust them verbatim.
    if net_eur is not None and net_usd is not None:
        return net_eur, net_usd
    rate = lookup_rate_with_forward_fill(eur_to_usd, on)
    native_ccy = (native_currency or "").upper()
    eur: Decimal | None
    usd: Decimal | None
    if native_ccy == "USD":
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
    if native_ccy == "EUR":
        eur = net_native if net_native is not None else net_eur
        usd = eur * rate if (eur is not None and usable and rate is not None) else None
        return eur, usd
    # Any other native currency (rare): trust the stored EUR leg.
    eur = net_eur
    usd = eur * rate if (eur is not None and usable and rate is not None) else None
    return eur, usd
