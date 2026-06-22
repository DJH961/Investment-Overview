"""Pure helpers for the manual transaction form (no NiceGUI / DB imports).

Two jobs, both deliberately free of UI/database dependencies so they can be
unit-tested in isolation:

* :func:`signed_net` — derive the *sign* of a cash movement from its kind, so
  the user only ever types a positive magnitude and never has to remember
  whether a sale is ``+`` or a buy is ``-`` (a sale is cash in, a buy is cash
  out, etc.).
* :func:`reconcile_trade` — keep ``quantity``, ``price`` and ``total`` (the
  three figures the user types for a trade) consistent: fill in the missing
  third from the other two, or flag a mismatch when all three are given but
  ``quantity × price`` doesn't equal ``total``.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import cast

from investment_dashboard.domain.money_market import MONEY_MARKET_NAV
from investment_dashboard.models.transaction import TransactionKind

#: Kinds whose booked cash flow is **into** the account (positive net).
NET_POSITIVE_KINDS: frozenset[str] = frozenset(
    {
        TransactionKind.SELL.value,
        TransactionKind.DEPOSIT.value,
        TransactionKind.DIVIDEND_CASH.value,
        TransactionKind.INTEREST.value,
        TransactionKind.TRANSFER_IN.value,
    }
)

#: Kinds whose booked cash flow is **out of** the account (negative net).
NET_NEGATIVE_KINDS: frozenset[str] = frozenset(
    {
        TransactionKind.BUY.value,
        TransactionKind.WITHDRAWAL.value,
        TransactionKind.FEE.value,
        TransactionKind.TRANSFER_OUT.value,
        TransactionKind.DIVIDEND_REINVEST.value,
    }
)

#: Trade kinds for which ``quantity × price`` should reconcile with ``total``.
TRADE_KINDS: frozenset[str] = frozenset(
    {
        TransactionKind.BUY.value,
        TransactionKind.SELL.value,
        TransactionKind.DIVIDEND_REINVEST.value,
    }
)

#: Relative slack allowed between ``quantity × price`` and ``total`` before the
#: form complains — brokers round price to a few decimals (matches the
#: importer's ``row_validation`` tolerance).
RECONCILE_TOLERANCE = Decimal("0.01")

#: Cash-movement kinds that should automatically fill / deplete the account's
#: money-market settlement fund (so the user logs the transfer once, not twice).
MONEY_MARKET_TRIGGER_KINDS: frozenset[str] = frozenset(
    {
        TransactionKind.DEPOSIT.value,
        TransactionKind.WITHDRAWAL.value,
        TransactionKind.TRANSFER_IN.value,
        TransactionKind.TRANSFER_OUT.value,
    }
)


def net_sign(kind: str) -> int:
    """Return ``+1`` / ``-1`` for the cash-flow direction of ``kind``, ``0`` if
    the kind carries no cash (e.g. a ``split``)."""
    if kind in NET_POSITIVE_KINDS:
        return 1
    if kind in NET_NEGATIVE_KINDS:
        return -1
    return 0


def signed_net(kind: str, magnitude: Decimal | None) -> Decimal | None:
    """Apply the kind's cash-flow sign to a user-typed positive ``magnitude``.

    ``magnitude`` may be negative if the user insists; its absolute value is
    taken so the *kind* is always the single source of truth for the sign.
    Returns ``None`` for a missing magnitude or a no-cash kind (``split``).
    """
    if magnitude is None:
        return None
    sign = net_sign(kind)
    if sign == 0:
        return None
    return sign * abs(magnitude)


#: Share-moving kinds and the sign their quantity carries in the ledger. A sell
#: stores a **negative** share count (positions_service relies on this); buys,
#: reinvested dividends and split share-adds are positive.
_NEGATIVE_QUANTITY_KINDS: frozenset[str] = frozenset({TransactionKind.SELL.value})


def signed_quantity(kind: str, magnitude: Decimal | None) -> Decimal | None:
    """Apply the kind's share-count sign to a user-typed positive ``magnitude``.

    Buys, reinvested dividends and splits add shares (positive); sells remove
    them (negative). The user types a positive quantity and never has to
    remember the sign — mirroring :func:`signed_net` for cash.
    """
    if magnitude is None:
        return None
    if kind in _NEGATIVE_QUANTITY_KINDS:
        return -abs(magnitude)
    return abs(magnitude)


@dataclass(frozen=True)
class TradeFigures:
    """Reconciled ``quantity`` / ``price`` / ``total`` plus an optional error.

    ``error`` is ``None`` when the figures are consistent (or there wasn't
    enough information to reconcile); otherwise it's a short, user-facing
    message describing the mismatch.
    """

    quantity: Decimal | None
    price: Decimal | None
    total: Decimal | None
    error: str | None = None


def reconcile_trade(  # noqa: PLR0911 - one return per fill/validate branch reads clearest
    quantity: Decimal | None,
    price: Decimal | None,
    total: Decimal | None,
) -> TradeFigures:
    """Cross-check the three trade figures, filling in a missing one.

    * Two of the three present → derive the third (``total = qty × price``,
      ``qty = total / price``, ``price = total / qty``).
    * All three present → verify ``quantity × price ≈ total`` within
      :data:`RECONCILE_TOLERANCE`; return an ``error`` message if not.
    * Fewer than two present → nothing to do; echoed back unchanged.

    Magnitudes are compared on absolute value, so a sign the user may have
    typed never trips the check (the sign is owned by :func:`signed_net`).
    """
    qty = abs(quantity) if quantity is not None else None
    prc = abs(price) if price is not None else None
    tot = abs(total) if total is not None else None

    present = sum(x is not None for x in (qty, prc, tot))
    if present < 2:
        return TradeFigures(quantity, price, total)

    if qty is not None and prc is not None and tot is None:
        return TradeFigures(qty, prc, qty * prc)
    if qty is not None and tot is not None and prc is None:
        if qty == 0:
            return TradeFigures(qty, price, tot, error="Quantity can't be zero")
        return TradeFigures(qty, tot / qty, tot)
    if prc is not None and tot is not None and qty is None:
        if prc == 0:
            return TradeFigures(quantity, prc, tot, error="Price can't be zero")
        return TradeFigures(tot / prc, prc, tot)

    # All three present — validate they agree.
    expected = cast("Decimal", qty) * cast("Decimal", prc)
    assert tot is not None
    slack = expected * RECONCILE_TOLERANCE
    if abs(expected - tot) > slack:
        return TradeFigures(
            qty,
            prc,
            tot,
            error=(
                f"Quantity x price = {expected} doesn't match total {tot}. "
                "Fix one of the three so they agree."
            ),
        )
    return TradeFigures(qty, prc, tot)


@dataclass(frozen=True)
class MoneyMarketLeg:
    """The paired money-market (settlement-fund) transaction for a cash move.

    Mirrors the Vanguard settlement-sweep convention (see
    ``adapters/vanguard/settlement.py``): cash into the account *buys* fund
    shares at the constant $1.00 NAV; cash out *sells* them. ``net_native`` is
    the opposite of the triggering row so total cash stays neutral.
    """

    kind: str
    quantity: Decimal
    price: Decimal
    net_native: Decimal


def money_market_leg(kind: str, net_native: Decimal | None) -> MoneyMarketLeg | None:
    """Build the auto money-market leg for a cash movement, or ``None``.

    ``net_native`` is the *signed* cash flow of the triggering transaction
    (positive = into the account). Only the cash-movement kinds in
    :data:`MONEY_MARKET_TRIGGER_KINDS` produce a leg.
    """
    if kind not in MONEY_MARKET_TRIGGER_KINDS:
        return None
    if net_native is None or net_native == 0:
        return None
    leg_kind = TransactionKind.BUY.value if net_native > 0 else TransactionKind.SELL.value
    return MoneyMarketLeg(
        kind=leg_kind,
        quantity=net_native,  # +shares bought (cash in) / -shares sold (cash out)
        price=MONEY_MARKET_NAV,
        net_native=-net_native,
    )
