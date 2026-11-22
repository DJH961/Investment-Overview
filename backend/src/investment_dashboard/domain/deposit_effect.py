"""What the exchange rate did to the euros you send into a dollar portfolio (pure).

The investing side of the currency (the Currency page's USD view): each deposit
of dollars cost some euros at the rate you actually got. Against a reference rate
``r0`` (the rate at the start of the range), the deposit's currency effect is

    effect = usd - eur * r0 = eur * (r - r0)        (dollars; r = usd / eur)

the dollars you received minus what the same euros would have bought at ``r0``.
Positive: a stronger euro, your euros bought more dollars. Summed over deposits
it is a sum of dollar amounts (the currency rule: native dollars received, euros
at their own date's rate); nothing here is a return.

Generic in currency names only by convention (``usd`` = the amount received in
the portfolio's currency, ``eur`` = the amount sent); the maths does not care.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

ZERO = Decimal(0)


@dataclass(frozen=True)
class Deposit:
    """One deposit: ``usd`` received for ``eur`` sent on ``on``."""

    id: int
    on: date
    usd: Decimal
    eur: Decimal
    #: ``matched`` (the conversions you recorded), ``partly`` (part matched, part
    #: at the ECB rate) or ``ecb`` (the ECB fixing of that day, or the last one).
    source: str = "ecb"

    @property
    def rate(self) -> Decimal:
        """Dollars per euro you actually got."""
        return self.usd / self.eur


@dataclass(frozen=True)
class DepositEffect:
    deposit: Deposit
    #: Dollars the same euros would have bought at the reference rate.
    usd_at_start: Decimal
    #: ``deposit.usd - usd_at_start``.
    effect: Decimal


def effect_of(d: Deposit, start_rate: Decimal) -> DepositEffect:
    """``d`` against ``start_rate`` (dollars per euro)."""
    if start_rate <= 0:
        raise ValueError("start_rate must be positive")
    at_start = d.eur * start_rate
    return DepositEffect(d, at_start, d.usd - at_start)


def effects(deposits: Sequence[Deposit], start_rate: Decimal) -> list[DepositEffect]:
    return [effect_of(d, start_rate) for d in sorted(deposits, key=lambda d: (d.on, d.id))]


@dataclass(frozen=True)
class Totals:
    eur: Decimal
    usd: Decimal
    usd_at_start: Decimal
    effect: Decimal


def totals(items: Sequence[DepositEffect]) -> Totals:
    """Sums: euros sent, dollars received, dollars at the start rate, the effect."""
    eur = sum((e.deposit.eur for e in items), ZERO)
    usd = sum((e.deposit.usd for e in items), ZERO)
    at_start = sum((e.usd_at_start for e in items), ZERO)
    return Totals(eur, usd, at_start, usd - at_start)


@dataclass(frozen=True)
class SeriesPoint:
    on: date
    #: Dollars received so far in the range.
    usd: Decimal
    #: The same euros at the start rate.
    usd_at_start: Decimal

    @property
    def effect(self) -> Decimal:
        return self.usd - self.usd_at_start


def cumulative(items: Sequence[DepositEffect], start_on: date) -> list[SeriesPoint]:
    """A step series: zero at ``start_on``, then one point per deposit day."""
    out = [SeriesPoint(start_on, ZERO, ZERO)]
    usd = at_start = ZERO
    for e in items:
        usd += e.deposit.usd
        at_start += e.usd_at_start
        if out[-1].on == e.deposit.on:
            out[-1] = SeriesPoint(e.deposit.on, usd, at_start)
        else:
            out.append(SeriesPoint(e.deposit.on, usd, at_start))
    return out


def grouped(
    items: Sequence[DepositEffect], key: Callable[[date], str]
) -> list[tuple[str, Decimal]]:
    """``(label, effect)`` per group in date order (only groups with a deposit)."""
    out: dict[str, Decimal] = {}
    for e in items:
        k = key(e.deposit.on)
        out[k] = out.get(k, ZERO) + e.effect
    return list(out.items())


def month_totals(items: Sequence[DepositEffect]) -> list[tuple[str, Decimal]]:
    return grouped(items, lambda d: f"{d.year:04d}-{d.month:02d}")


def year_totals(items: Sequence[DepositEffect]) -> list[tuple[str, Decimal]]:
    return grouped(items, lambda d: f"{d.year:04d}")


def rolling(
    deposits: Sequence[Deposit],
    rate_at: Callable[[date], Decimal | None],
    points: Sequence[date],
    days: int = 365,
) -> list[tuple[date, Decimal]]:
    """At each date ``t``: the effect of the deposits in ``(t - days, t]`` against the
    rate on ``t - days`` (dates without a rate there are left out)."""
    ordered = sorted(deposits, key=lambda d: (d.on, d.id))
    out: list[tuple[date, Decimal]] = []
    for t in points:
        lo = t - timedelta(days=days)
        r0 = rate_at(lo)
        if r0 is None or r0 <= 0:
            continue
        total = sum((d.usd - d.eur * r0 for d in ordered if lo < d.on <= t), ZERO)
        out.append((t, total))
    return out


__all__ = [
    "Deposit",
    "DepositEffect",
    "SeriesPoint",
    "Totals",
    "cumulative",
    "effect_of",
    "effects",
    "grouped",
    "month_totals",
    "rolling",
    "totals",
    "year_totals",
]
