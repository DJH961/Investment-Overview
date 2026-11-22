"""Suggest a recurring plan from recent ledger history (7.3, P14). Pure, no I/O.

The "Set up your routine" flow prefills its form from these; a suggestion is never
turned into a plan without the owner's confirmation.

Rules (deliberately plain):

* needs at least ``min_occurrences`` observations (default 3);
* the **median gap** between consecutive dates picks the cadence: 6-8 days weekly (anchor =
  the most common weekday), 13-15 days every two weeks, 27-32 days monthly (anchor = the
  most common day of month, clamped later to the month end), 1-2 days daily;
  anything else gives no suggestion;
* the amount is the median of the observed amounts.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from itertools import pairwise
from statistics import median

_DAILY = (1, 2)
_WEEKLY = (6, 8)
_BIWEEKLY = (13, 15)
_MONTHLY = (27, 32)


@dataclass(frozen=True)
class Observation:
    day: date
    amount: Decimal


@dataclass(frozen=True)
class CadenceSuggestion:
    unit: str
    every: int
    anchor: int | None
    amount: Decimal
    occurrences: int


def _in(value: float, band: tuple[int, int]) -> bool:
    return band[0] <= value <= band[1]


def _mode(values: Sequence[int]) -> int:
    # Most common; the earliest-seen wins a tie so the result is deterministic.
    counts = Counter(values)
    best = max(counts.values())
    return next(v for v in values if counts[v] == best)


def suggest_cadence(
    observations: Sequence[Observation], *, min_occurrences: int = 3
) -> CadenceSuggestion | None:
    """The plan these observations look like, or ``None`` when there is no clear rhythm."""
    obs = sorted(observations, key=lambda o: o.day)
    if len(obs) < min_occurrences:
        return None
    gaps = [(b.day - a.day).days for a, b in pairwise(obs)]
    gap = median(gaps)
    amount = Decimal(median([o.amount for o in obs]))
    days = [o.day for o in obs]
    if _in(gap, _DAILY):
        return CadenceSuggestion("days", 1, None, amount, len(obs))
    if _in(gap, _WEEKLY):
        return CadenceSuggestion("weeks", 1, _mode([d.weekday() for d in days]), amount, len(obs))
    if _in(gap, _BIWEEKLY):
        return CadenceSuggestion("weeks", 2, _mode([d.weekday() for d in days]), amount, len(obs))
    if _in(gap, _MONTHLY):
        return CadenceSuggestion("months", 1, _mode([d.day for d in days]), amount, len(obs))
    return None
