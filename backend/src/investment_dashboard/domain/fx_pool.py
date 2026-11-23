"""USD pool built from EUR -> USD conversion batches (plan section 2.5, 7.3 pins).

Pure: no I/O. Conversions fill a USD pool. Pins (the owner's explicit choices) are
applied first; every USD deposit into a brokerage then consumes the rest of the pool
first-in-first-out from batches dated on or before the deposit. The matched part
costs the batches' EUR pro-rata (fees included in the EUR cost); any uncovered
remainder is priced at the ECB rate of the deposit date and flagged as a fallback.
Withdrawals are ignored. Decimal only.

Rates are quoted as USD per 1 EUR (the ``fx_history`` convention), so
``blended_rate = usd / eur``.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

_ZERO = Decimal(0)

#: A pin may name a conversion dated up to this many days after its deposit.
PIN_WINDOW_DAYS = 7


@dataclass(frozen=True)
class Batch:
    """One EUR -> USD conversion."""

    id: int
    date: date
    eur_sent: Decimal
    usd_received: Decimal
    fees_eur: Decimal = _ZERO
    #: Dollars that never go to the broker (kept in the owner's USD account).
    kept_usd: Decimal = _ZERO

    @property
    def eur_cost(self) -> Decimal:
        return self.eur_sent + self.fees_eur

    @property
    def pool_usd(self) -> Decimal:
        """Dollars available to investing: received minus kept."""
        return self.usd_received - self.kept_usd

    @property
    def pool_eur(self) -> Decimal:
        """All-in EUR attributed to the investable dollars (pro rata)."""
        if self.kept_usd == 0:
            return self.eur_cost
        return self.eur_cost * self.pool_usd / self.usd_received


@dataclass(frozen=True)
class UsdDeposit:
    """A USD external contribution into a brokerage account."""

    id: int
    date: date
    usd: Decimal
    #: Received in USD directly (no conversion): never takes pool dollars, priced at
    #: the ECB rate like any uncovered part.
    no_conversion: bool = False


@dataclass(frozen=True)
class Pin:
    """The owner's choice: pay ``usd`` of a deposit from one conversion."""

    deposit_id: int
    conversion_id: int
    usd: Decimal


@dataclass(frozen=True)
class MatchedSlice:
    conversion_id: int
    usd: Decimal
    eur: Decimal
    pinned: bool = False


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
class ConversionSlice:
    deposit_id: int
    usd: Decimal
    eur: Decimal
    pinned: bool


@dataclass(frozen=True)
class ConversionUse:
    conversion_id: int
    slices: tuple[ConversionSlice, ...]
    remaining_usd: Decimal


@dataclass(frozen=True)
class PoolResult:
    deposits: tuple[DepositMatch, ...]
    remaining: tuple[RemainingBatch, ...]
    by_conversion: tuple[ConversionUse, ...] = ()
    rejected_pins: tuple[tuple[Pin, str], ...] = ()

    @property
    def remaining_usd(self) -> Decimal:
        return sum((r.usd for r in self.remaining), _ZERO)

    @property
    def remaining_eur(self) -> Decimal:
        return sum((r.eur for r in self.remaining), _ZERO)


def match_deposits(  # noqa: PLR0912, PLR0915 - one linear pass, clearer undivided
    conversions: Sequence[Batch],
    deposits: Sequence[UsdDeposit],
    ecb_rate: Callable[[date], Decimal | None],
    pins: Sequence[Pin] = (),
) -> PoolResult:
    """Match ``deposits`` against the USD pool of ``conversions``.

    Valid ``pins`` are applied first, each taking its USD from its conversion at that
    conversion's all-in rate; FIFO then fills each deposit's rest from the dollars
    nobody pinned. Conversions sort by (date, id), deposits by (date, id); the result
    does not depend on input order. ``ecb_rate(d)`` returns USD per EUR for the fallback.
    Invalid pins are ignored and reported in ``rejected_pins``.
    """
    batches = sorted(conversions, key=lambda b: (b.date, b.id))
    index = {b.id: i for i, b in enumerate(batches)}
    dep_by_id = {d.id: d for d in deposits}
    left_usd = [b.pool_usd for b in batches]
    left_eur = [b.pool_eur for b in batches]

    # Phase 1: validate and apply pins (deterministic order).
    pinned: dict[int, list[MatchedSlice]] = {}
    pinned_dep_usd: dict[int, Decimal] = {}
    rejected: list[tuple[Pin, str]] = []
    for pin in sorted(pins, key=lambda p: (p.deposit_id, p.conversion_id, p.usd)):
        dep = dep_by_id.get(pin.deposit_id)
        i = index.get(pin.conversion_id)
        if dep is None:
            rejected.append((pin, "deposit not found"))
            continue
        if i is None:
            rejected.append((pin, "conversion not found"))
            continue
        batch = batches[i]
        if pin.usd <= 0:
            rejected.append((pin, "pin amount must be positive"))
        elif dep.no_conversion:
            rejected.append((pin, "deposit was received in USD (no conversion)"))
        elif batch.date > dep.date + timedelta(days=PIN_WINDOW_DAYS):
            rejected.append((pin, "conversion is dated more than 7 days after the deposit"))
        elif pinned_dep_usd.get(dep.id, _ZERO) + pin.usd > dep.usd:
            rejected.append((pin, "deposit is pinned for more than its amount"))
        elif pin.usd > left_usd[i]:
            rejected.append((pin, "conversion is pinned for more than its amount"))
        else:
            eur = (
                left_eur[i] if pin.usd == left_usd[i] else batch.pool_eur * pin.usd / batch.pool_usd
            )
            left_usd[i] -= pin.usd
            left_eur[i] -= eur
            pinned_dep_usd[dep.id] = pinned_dep_usd.get(dep.id, _ZERO) + pin.usd
            pinned.setdefault(dep.id, []).append(MatchedSlice(batch.id, pin.usd, eur, True))

    # Phase 2: FIFO fills each deposit's rest.
    uses: dict[int, list[ConversionSlice]] = {b.id: [] for b in batches}
    results: list[DepositMatch] = []
    for dep in sorted(deposits, key=lambda d: (d.date, d.id)):
        slices: list[MatchedSlice] = list(pinned.get(dep.id, ()))
        need = dep.usd - sum((s.usd for s in slices), _ZERO)
        for i, batch in enumerate(batches):
            if need <= 0 or dep.no_conversion:
                break
            if batch.date > dep.date or left_usd[i] <= 0:
                continue
            take = min(need, left_usd[i])
            # exhaust a batch exactly: no rounding residue
            eur = left_eur[i] if take == left_usd[i] else batch.pool_eur * take / batch.pool_usd
            left_usd[i] -= take
            left_eur[i] -= eur
            need -= take
            slices.append(MatchedSlice(batch.id, take, eur, False))

        for s in slices:
            uses[s.conversion_id].append(ConversionSlice(dep.id, s.usd, s.eur, s.pinned))
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
    by_conversion = tuple(
        ConversionUse(b.id, tuple(uses[b.id]), left_usd[i]) for i, b in enumerate(batches)
    )
    return PoolResult(
        deposits=tuple(results),
        remaining=remaining,
        by_conversion=by_conversion,
        rejected_pins=tuple(rejected),
    )
