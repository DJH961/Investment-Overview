"""Synthesize Vanguard settlement-fund (VMFXX) legs on import.

A Vanguard brokerage account routes *all* cash through its settlement fund
(``VMFXX``): a deposit sweeps **into** VMFXX, a security purchase sweeps
**out** of it, sale proceeds and cash dividends sweep back in, and so on.
The Full-History export, however, drops these internal "Sweep In/Out" rows
as accounting artifacts, so the dashboard never saw the settlement balance —
uninvested cash was invisible and monthly closing values understated it.

This module reconstructs the settlement holding deterministically from the
surviving rows so the user gets the VMFXX position automatically, exactly as
they hold it (spec §5.2; user request, v2.9.6). For every non-VMFXX row that
moves cash we add an equal-and-opposite VMFXX leg priced at the constant
$1.00 NAV; VMFXX's own dividends become reinvested shares so the fund's value
tracks the running settlement balance.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import replace
from decimal import Decimal

from investment_dashboard.adapters.importer_types import ParsedTransactionRow
from investment_dashboard.domain.money_market import MONEY_MARKET_ASSET_CLASS

SETTLEMENT_SYMBOL = "VMFXX"
SETTLEMENT_NAME = "Vanguard Federal Money Market Fund"
NAV = Decimal(1)
ZERO = Decimal(0)


def _is_settlement(row: ParsedTransactionRow) -> bool:
    return bool(row.symbol) and row.symbol.strip().upper() == SETTLEMENT_SYMBOL


def inject_settlement_legs(
    rows: Sequence[ParsedTransactionRow],
) -> list[ParsedTransactionRow]:
    """Return ``rows`` plus synthesized VMFXX settlement legs.

    * Each non-VMFXX row with a non-zero ``net_native`` ``N`` gains a paired
      VMFXX leg of ``quantity = N`` (``buy`` when cash flows **in**, ``sell``
      when it flows **out**) and ``net_native = -N``, priced at $1.00. Cash is
      conserved and the VMFXX share balance tracks uninvested cash.
    * VMFXX's own ``dividend_cash`` rows are rewritten as ``dividend_reinvest``
      so the interest compounds into more settlement shares; the matching
      VMFXX ``dividend_reinvest`` artifact row (the offsetting leg) is dropped.

    The transform is idempotent: synthesized rows derive a stable
    ``external_id`` from their source row, so re-importing writes nothing new.
    """
    out: list[ParsedTransactionRow] = []
    for row in rows:
        if _is_settlement(row):
            out.extend(_rewrite_settlement_own_row(row))
            continue
        out.append(row)
        leg = _settlement_leg_for(row)
        if leg is not None:
            out.append(leg)
    return out


def _rewrite_settlement_own_row(
    row: ParsedTransactionRow,
) -> list[ParsedTransactionRow]:
    """Normalise a row that is *itself* a VMFXX transaction."""
    # The dividend is paid as settlement cash and immediately reinvested into
    # more VMFXX shares — model it as a reinvestment so the holding grows.
    if row.kind == "dividend_cash":
        amount = row.net_native or ZERO
        if amount <= ZERO:
            return [_tag_settlement(row)]
        return [
            _tag_settlement(
                replace(
                    row,
                    kind="dividend_reinvest",
                    quantity=amount,
                    price_native=NAV,
                    net_native=ZERO,
                    gross_native=None,
                    fees_native=None,
                )
            )
        ]
    # The export's offsetting "Reinvestment" artifact carries no share count;
    # drop it (the dividend row above already adds the shares).
    if row.kind == "dividend_reinvest":
        return []
    return [_tag_settlement(row)]


def _settlement_leg_for(row: ParsedTransactionRow) -> ParsedTransactionRow | None:
    """Build the VMFXX counter-leg for a cash-moving non-VMFXX ``row``."""
    net = row.net_native
    if net is None or net == ZERO:
        return None
    kind = "buy" if net > ZERO else "sell"
    return ParsedTransactionRow(
        date=row.date,
        settlement_date=row.settlement_date,
        kind=kind,
        symbol=SETTLEMENT_SYMBOL,
        quantity=net,  # +shares bought (cash in) / -shares sold (cash out)
        price_native=NAV,
        gross_native=None,
        fees_native=None,
        net_native=-net,
        description="Settlement sweep (auto-generated)",
        external_id=f"{row.external_id}:vmfxx",
        source=row.source,
        name=SETTLEMENT_NAME,
        asset_class=MONEY_MARKET_ASSET_CLASS,
        native_currency="USD",
    )


def _tag_settlement(row: ParsedTransactionRow) -> ParsedTransactionRow:
    """Ensure a VMFXX row seeds the instrument as a money-market fund."""
    return replace(
        row,
        name=row.name or SETTLEMENT_NAME,
        asset_class=MONEY_MARKET_ASSET_CLASS,
        native_currency=row.native_currency or "USD",
    )
