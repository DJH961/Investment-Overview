"""FIFO USD pool built from EUR -> USD conversion batches (plan section 2.5).

Pure: no I/O. Conversions fill a USD pool; every USD deposit into a brokerage
consumes that pool first-in-first-out from batches dated on or before the
deposit. The matched part costs the batches' EUR pro-rata (fees included in the
EUR cost); any uncovered remainder is priced at the ECB rate of the deposit date
and flagged as a fallback. Withdrawals are ignored. Decimal only.

Rates are quoted as USD per 1 EUR (the ``fx_history`` convention), so
``blended_rate = usd / eur``.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

_ZERO = Decimal(0)


@dataclass(frozen=True)
class Batch:
    """One EUR -> USD conversion."""

    id: int
    date: date
    eur_sent: Decimal
    usd_received: Decimal
    fees_eur: Decimal = _ZERO

    @property
    def eur_cost(self) -> Decimal:
        return self.eur_sent + self.fees_eur


@dataclass(frozen=True)
class UsdDeposit:
    """A USD external contribution into a brokerage account."""

    id: int
    date: date
    usd: Decimal


@dataclass(frozen=True)
class MatchedSlice:
    conversion_id: int
    usd: Decimal
    eur: Decimal


@dataclass(frozen=True)
class DepositMatch:
    deposit_id: int
    date: date
    usd: Decimal
    matched: tuple[MatchedSlice, ...]
    fallback_usd: Decimal
    fallback_eur: Decimal
    fallback_rate: Decimal | None
    #: True when a fallback was needed but no ECB rate was available; the
    #: fallback EUR is then 0 and ``eur_total`` covers the matched part only.
    rate_missing: bool
    eur_total: Decimal

    @property
    def matched_usd(self) -> Decimal:
        return sum((s.usd for s in self.matched), _ZERO)

    @property
    def is_fallback(self) -> bool:
        return self.fallback_usd > 0

    @property
    def blended_rate(self) -> Decimal | None:
        """USD per EUR actually obtained, or ``None`` when there is no EUR cost."""
        if self.eur_total <= 0:
            return None
        return self.usd / self.eur_total


@dataclass(frozen=True)
class RemainingBatch:
    conversion_id: int
    usd: Decimal
    eur: Decimal


@dataclass(frozen=True)
class PoolResult:
    deposits: tuple[DepositMatch, ...]
    remaining: tuple[RemainingBatch, ...]

    @property
    def remaining_usd(self) -> Decimal:
        return sum((r.usd for r in self.remaining), _ZERO)

    @property
    def remaining_eur(self) -> Decimal:
        return sum((r.eur for r in self.remaining), _ZERO)


def match_deposits(
    conversions: Sequence[Batch],
    deposits: Sequence[UsdDeposit],
    ecb_rate: Callable[[date], Decimal | None],
) -> PoolResult:
    """Match ``deposits`` against the FIFO USD pool of ``conversions``.

    Conversions sort by (date, id), deposits by (date, id); the result does not
    depend on input order. ``ecb_rate(d)`` returns USD per EUR for the fallback.
    """
    batches = sorted(conversions, key=lambda b: (b.date, b.id))
    left_usd = [b.usd_received for b in batches]
    left_eur = [b.eur_cost for b in batches]

    results: list[DepositMatch] = []
    for dep in sorted(deposits, key=lambda d: (d.date, d.id)):
        need = dep.usd
        slices: list[MatchedSlice] = []
        for i, batch in enumerate(batches):
            if need <= 0:
                break
            if batch.date > dep.date or left_usd[i] <= 0:
                continue
            take = min(need, left_usd[i])
            # exhaust a batch exactly: no rounding residue
            eur = left_eur[i] if take == left_usd[i] else batch.eur_cost * take / batch.usd_received
            left_usd[i] -= take
            left_eur[i] -= eur
            need -= take
            slices.append(MatchedSlice(batch.id, take, eur))

        fb_eur = _ZERO
        fb_rate: Decimal | None = None
        missing = False
        if need > 0:
            fb_rate = ecb_rate(dep.date)
            if fb_rate is None or fb_rate <= 0:
                fb_rate = None
                missing = True
            else:
                fb_eur = need / fb_rate
        total = sum((s.eur for s in slices), _ZERO) + fb_eur
        results.append(
            DepositMatch(
                deposit_id=dep.id,
                date=dep.date,
                usd=dep.usd,
                matched=tuple(slices),
                fallback_usd=need,
                fallback_eur=fb_eur,
                fallback_rate=fb_rate,
                rate_missing=missing,
                eur_total=total,
            )
        )

    remaining = tuple(RemainingBatch(b.id, left_usd[i], left_eur[i]) for i, b in enumerate(batches))
    return PoolResult(deposits=tuple(results), remaining=remaining)
