"""The single ledger walk: one pass over the transactions, one lot per account+instrument.

``compute_positions`` (native cost basis, shares, cash dividends) and
``compute_instrument_metrics`` (EUR / USD cost basis, dividends, YTD / MTD
invested) both read their per-holding figures from here, so the average-cost,
reinvest and money-market rules exist once.

A lot is keyed by ``(account_id, instrument_id)``: the average-cost method is
applied **per account**, never pooled across accounts, so an instrument held in
two accounts releases each account's own cost on a sale. Callers that need a
per-instrument figure sum the lots of that instrument.

Currency rule: native amounts stay native. The EUR / USD legs are derived per
transaction by the injected :class:`LegResolver` at the transaction's own date.
"""

from __future__ import annotations

from collections.abc import Callable, Collection, Iterable
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import TYPE_CHECKING

from investment_dashboard.domain.kinds import TransactionKind

if TYPE_CHECKING:
    from investment_dashboard.models import Transaction

ZERO = Decimal(0)

LotKey = tuple[int, int | None]


@dataclass
class Lot:
    """Running totals for one (account, instrument) holding."""

    shares: Decimal = ZERO
    #: Native-currency cost basis (average-cost method).
    cost_native: Decimal = ZERO
    #: Native-currency cash dividends (reinvested legs excluded).
    dividends_cash_native: Decimal = ZERO
    # --- dual-currency figures (only filled when a resolver is given) ---------
    cost_eur: Decimal = ZERO
    cost_usd: Decimal = ZERO
    div_eur: Decimal = ZERO
    div_usd: Decimal = ZERO
    ytd_invested_eur: Decimal = ZERO
    ytd_invested_usd: Decimal = ZERO
    mtd_invested_eur: Decimal = ZERO
    mtd_invested_usd: Decimal = ZERO
    #: Share count the dual-currency sell fraction uses (a priceless reinvest
    #: does not enter it), kept apart so the native walk stays untouched.
    shares_dual: Decimal = ZERO


@dataclass(frozen=True)
class LegResolver:
    """FX hooks for the dual-currency part of the walk.

    ``legs(t)`` returns the transaction's ``(eur, usd)`` cash legs at its own date;
    ``convert_native(value, native_currency, on)`` converts a positive native
    amount to ``(eur, usd)`` at that date's rate.
    """

    legs: Callable[[Transaction], tuple[Decimal, Decimal]]
    convert_native: Callable[[Decimal, str, date], tuple[Decimal, Decimal]]
    year_start: date
    month_start: date


def walk(  # noqa: PLR0912, PLR0915
    txns: Iterable[Transaction],
    *,
    reinvest_keys: Collection[tuple[int, int | None, date]],
    money_market_ids: Collection[int | None],
    resolver: LegResolver | None = None,
) -> dict[LotKey, Lot]:
    """Roll ``txns`` (date asc, id asc) into one :class:`Lot` per account+instrument.

    ``reinvest_keys`` are the ``(account, instrument, date)`` keys whose cash
    dividend was immediately reinvested (see :func:`domain.dividends.reinvest_keys`);
    ``money_market_ids`` are the instruments whose reinvested dividends are return,
    not cost. Pass a ``resolver`` to also accumulate the EUR / USD figures.
    """
    lots: dict[LotKey, Lot] = {}
    for t in txns:
        lot = lots.setdefault((t.account_id, t.instrument_id), Lot())
        kind = t.kind
        qty = t.quantity or ZERO
        net = t.net_native or ZERO
        iid = t.instrument_id
        eur = usd = ZERO
        if resolver is not None and iid is not None:
            eur, usd = resolver.legs(t)

        if kind == TransactionKind.BUY.value:
            lot.shares += qty
            lot.cost_native += -net  # buy net is negative => cost positive
            if resolver is not None:
                lot.cost_eur -= eur
                lot.cost_usd -= usd
                lot.shares_dual += qty
        elif kind == TransactionKind.SELL.value:
            # Average-cost method: a partial sale releases a proportional slice of
            # the cost basis (spec 6.5). ``qty`` is already negative for sells.
            shares_before = lot.shares
            if shares_before > ZERO:
                avg_cost = lot.cost_native / shares_before
                lot.cost_native += avg_cost * qty
                lot.cost_native = max(lot.cost_native, ZERO)
            lot.shares += qty
            if resolver is not None:
                dual_before = lot.shares_dual
                if dual_before > ZERO:
                    sold = min(-qty, dual_before)
                    frac = sold / dual_before
                    lot.cost_eur = lot.cost_eur * (1 - frac)
                    lot.cost_usd = lot.cost_usd * (1 - frac)
                lot.shares_dual = dual_before + qty
        elif kind == TransactionKind.DIVIDEND_REINVEST.value:
            lot.shares += qty
            if t.price_native is not None and iid not in money_market_ids:
                lot.cost_native += qty * t.price_native
            if resolver is not None and t.price_native is not None:
                lot.shares_dual += qty
                if iid not in money_market_ids and iid is not None:
                    native = t.account.native_currency if t.account else "EUR"
                    e, u = resolver.convert_native(qty * t.price_native, native, t.date)
                    lot.cost_eur += e
                    lot.cost_usd += u
        elif kind == TransactionKind.DIVIDEND_CASH.value:
            if (t.account_id, iid, t.date) not in reinvest_keys:
                lot.dividends_cash_native += net
                if resolver is not None:
                    lot.div_eur += eur
                    lot.div_usd += usd
        elif kind == TransactionKind.SPLIT.value:
            lot.shares += qty
            if resolver is not None:
                lot.shares_dual += qty

        if (
            resolver is not None
            and iid is not None
            and kind in {TransactionKind.BUY.value, TransactionKind.SELL.value}
        ):
            if t.date >= resolver.year_start:
                lot.ytd_invested_eur -= eur
                lot.ytd_invested_usd -= usd
            if t.date >= resolver.month_start:
                lot.mtd_invested_eur -= eur
                lot.mtd_invested_usd -= usd
    return lots
