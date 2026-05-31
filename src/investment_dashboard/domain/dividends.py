"""Dividend-income recognition (spec §6.1).

The dashboard reconciles "dividends" against the user's spreadsheet, whose
*Dividends* column records the **income value** of each distribution — the
amount paid out, whether it was taken as cash or (the usual case) immediately
reinvested into new shares.

Brokers deliver a reinvested dividend as a **pair** of ledger rows: a
``dividend_cash`` leg (the gross payout) and a ``dividend_reinvest`` leg (the
shares bought with it). Vanguard settlement-fund (``VMFXX``) interest is the
important exception — it arrives as a reinvest-only row whose cash leg the
importer folded in (a zero ``net_native``). Summing only ``dividend_cash``
therefore omits reinvested distributions, most visibly the VMFXX interest.

To match the spreadsheet we recognise income exactly once per distribution:

* a ``dividend_reinvest`` leg counts its reinvested value (``quantity ×
  price``), and its paired ``dividend_cash`` leg is skipped; and
* a ``dividend_cash`` leg with **no** paired reinvest on the same
  ``(account, instrument, date)`` counts its cash amount — covering the rare
  early period where dividends were genuinely received as cash rather than
  reinvested.

Two figures fall out of this, and they are *not* the same:

* **income** (``include_reinvested=True``) — every distribution, the figure the
  spreadsheet's *Dividends* column and the dashboard's dividend totals show.
* **realized cash** (``include_reinvested=False``) — only the cash that left the
  portfolio (un-reinvested dividends). Reinvested distributions are already
  embedded in the current mark-to-market value, so only realized cash may be
  added back when reconstructing capital gain, otherwise it double-counts.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import TYPE_CHECKING

from investment_dashboard.domain.currency import dual_currency_amounts

if TYPE_CHECKING:
    from collections.abc import Mapping

    from investment_dashboard.models import Transaction

ZERO = Decimal(0)

_DIVIDEND_CASH = "dividend_cash"
_DIVIDEND_REINVEST = "dividend_reinvest"


def reinvest_keys(
    txns: list[Transaction],
) -> set[tuple[int, int | None, date]]:
    """``(account_id, instrument_id, date)`` keys carrying a reinvestment.

    A ``dividend_cash`` leg whose key is in this set was reinvested (its shares
    are counted elsewhere), so it must not be double-counted as income.
    """
    return {(t.account_id, t.instrument_id, t.date) for t in txns if t.kind == _DIVIDEND_REINVEST}


def _native_currency(t: Transaction) -> str:
    return (t.account.native_currency if t.account else "EUR").upper()


def income_value_native(
    t: Transaction,
    keys: set[tuple[int, int | None, date]],
    *,
    include_reinvested: bool = True,
) -> Decimal | None:
    """Native-currency income recognised for one row, or ``None`` if uncounted.

    Reinvested dividends are valued at ``quantity × price`` (their cash leg's
    ``net_native`` is unreliable — zero for VMFXX). Un-reinvested cash dividends
    use their booked ``net_native``. When ``include_reinvested`` is false only
    the un-reinvested cash legs are recognised.
    """
    if t.kind == _DIVIDEND_REINVEST:
        if not include_reinvested:
            return None
        if t.quantity is not None and t.price_native is not None:
            return abs(t.quantity * t.price_native)
        return abs(t.net_native) if t.net_native is not None else None
    if t.kind == _DIVIDEND_CASH:
        # Skip the cash leg of a reinvested dividend (counted via the reinvest
        # row); otherwise recognise the booked cash.
        if (t.account_id, t.instrument_id, t.date) in keys:
            return None
        return t.net_native
    return None


def income_dual(
    t: Transaction,
    keys: set[tuple[int, int | None, date]],
    *,
    eur_to_usd: Mapping[date, Decimal],
    include_reinvested: bool = True,
) -> tuple[Decimal | None, Decimal | None]:
    """``(eur, usd)`` dividend income recognised for one row.

    Returns ``(None, None)`` when the row carries no recognised income. The
    cash path trusts the frozen ``net_eur`` / ``net_usd`` legs persisted at
    write time; the reinvest path derives both legs from the trade-date FX rate
    because the reinvest row's cash legs are unreliable.
    """
    if t.kind == _DIVIDEND_CASH:
        if (t.account_id, t.instrument_id, t.date) in keys:
            return (None, None)
        return dual_currency_amounts(
            native_currency=_native_currency(t),
            net_native=t.net_native,
            net_eur=t.net_eur,
            on=t.date,
            eur_to_usd=eur_to_usd,
            net_usd=t.net_usd,
        )
    if t.kind == _DIVIDEND_REINVEST:
        if not include_reinvested:
            return (None, None)
        value = income_value_native(t, keys, include_reinvested=True)
        if value is None:
            return (None, None)
        return dual_currency_amounts(
            native_currency=_native_currency(t),
            net_native=value,
            net_eur=None,
            on=t.date,
            eur_to_usd=eur_to_usd,
            net_usd=None,
        )
    return (None, None)
