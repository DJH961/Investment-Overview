"""The cash-out: what one conversion back to EUR really earned (7.4 contract section 4).

Pure: no I/O. A conversion back takes units out of the cash pool (its draws, from
:func:`domain.cash_pool.run`), each carrying the EUR that originally bought it
(``orig_eur``) and the market EUR realised into it (``market_eur``). Against the
settled ECB rate of the conversion date (``ecb_eur = sent / ecb``):

* ``realised_eur = net_received - orig_eur`` with ``net_received = eur_received -
  fees_eur`` (the euros that really came back);
* ``currency_eur = ecb_eur - (orig_eur + market_eur)``: the rate move on those units
  since they cost what they cost (the only realised currency figure);
* ``conversion_cost_eur = net_received - ecb_eur`` (``<= 0`` is a cost; fees included).

So ``realised_eur == market_eur + currency_eur + conversion_cost_eur``, exactly: every
EUR figure is held on a fixed grid of :data:`GRID` EUR (far below any display), where
the sums and differences are exact Decimal operations.

``xirr_eur`` is the money-weighted EUR return over the original EUR flows: each origin's
``-eur`` on its own date, ``+net_received`` on the conversion date. It is computed from
euros only, never from a dollar return times a rate.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from investment_dashboard.domain.cash_pool import (
    ConversionBack,
    Draw,
    EcbRate,
    PoolState,
)
from investment_dashboard.domain.returns import Cashflow, xirr

ZERO = Decimal(0)

#: The EUR grid every cash-out figure sits on (exact sums; never a display rounding).
GRID = Decimal("1e-12")


@dataclass(frozen=True)
class CashOut:
    conversion_id: int
    date: date
    usd_sent: Decimal
    eur_received: Decimal
    orig_eur: Decimal
    market_eur: Decimal
    #: ``usd_sent / ecb(date) - (orig + market)``.
    currency_eur: Decimal
    #: ``eur_received - fees_eur - usd_sent / ecb(date)`` (``<= 0`` is a cost).
    conversion_cost_eur: Decimal
    #: ``eur_received - fees_eur - orig_eur``.
    realised_eur: Decimal
    #: Origins' ``(-eur, conv_date)`` plus ``(+net received, date)``.
    xirr_eur: Decimal | None
    draws: tuple[Draw, ...]
    #: Some units fell back to ECB, or the conversion date has no ECB rate.
    flagged: bool


def _grid(x: Decimal) -> Decimal:
    return x.quantize(GRID)


def cash_out(back: ConversionBack, draws: Sequence[Draw], ecb_rate: EcbRate) -> CashOut:
    """Split one conversion back into market, currency and conversion cost.

    Without an ECB rate for the date, the rate obtained stands in for it (the cost is
    then the fees only) and the cash-out is flagged.
    """
    orig = _grid(sum((d.orig_eur for d in draws), ZERO))
    market = _grid(sum((d.market_eur for d in draws), ZERO))
    net = _grid(back.eur_received - back.fees_eur)
    rate = ecb_rate(back.from_ccy, back.date)
    missing = rate is None or rate <= 0
    ecb_eur = _grid(back.eur_received) if rate is None or rate <= 0 else _grid(back.sent / rate)
    currency = ecb_eur - (orig + market)
    cost = net - ecb_eur
    return CashOut(
        conversion_id=back.id,
        date=back.date,
        usd_sent=back.sent,
        eur_received=back.eur_received,
        orig_eur=orig,
        market_eur=market,
        currency_eur=currency,
        conversion_cost_eur=cost,
        realised_eur=net - orig,
        xirr_eur=_xirr(draws, back.date, net),
        draws=tuple(draws),
        flagged=missing or any(d.flagged for d in draws),
    )


def _xirr(draws: Iterable[Draw], on: date, net: Decimal) -> Decimal | None:
    out: dict[date, Decimal] = {}
    for d in draws:
        for o in d.origins:
            if o.conv_date is not None and o.eur != 0:
                out[o.conv_date] = out.get(o.conv_date, ZERO) - o.eur
    flows = [Cashflow(day, amount) for day, amount in sorted(out.items())]
    flows.append(Cashflow(on, net))
    return xirr(flows, on)


def cash_outs(
    backs: Iterable[ConversionBack], state: PoolState, ecb_rate: EcbRate
) -> tuple[CashOut, ...]:
    """One :class:`CashOut` per conversion back the pool walked, in (date, id) order."""
    return tuple(
        cash_out(b, state.conversions_back.get(b.id, ()), ecb_rate)
        for b in sorted(backs, key=lambda b: (b.date, b.id))
    )
