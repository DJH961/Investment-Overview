"""Real (inflation-adjusted) euro return over whole months (7.4 P10). Pure.

For a period from the close of month ``m0`` to the close of month ``m1``::

    real = (1 + nominal_eur_return) / (HICP[m1] / HICP[m0]) - 1

``nominal`` is the period's EUR return (the Periods row's growth, computed in
euros from euro cashflows: never a USD return converted). The index ratio is the
price change over the same months; a year is the product of its months' ratios,
which telescopes to ``HICP[Dec] / HICP[previous Dec]``. A monthly figure is never
annualised.

The index is published about two weeks after the month ends. When ``m1`` is not
out yet the latest published month ``L`` is used instead and the result says so
(``to_month = L``); when no month after ``m0`` is out (the running month), there is
no real return yet (``None``), never a "zero inflation" one.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal

ONE = Decimal(1)


@dataclass(frozen=True)
class RealReturn:
    """A real return and the last index month it covers (``YYYY-MM``)."""

    value: Decimal
    to_month: str


def month_before(month: str) -> str:
    """``"2026-01"`` -> ``"2025-12"``."""
    year, mon = int(month[:4]), int(month[5:7])
    if mon == 1:
        return f"{year - 1:04d}-12"
    return f"{year:04d}-{mon - 1:02d}"


def next_month(month: str) -> str:
    year, mon = int(month[:4]), int(month[5:7])
    if mon == 12:
        return f"{year + 1:04d}-01"
    return f"{year:04d}-{mon + 1:02d}"


def months_between(m0: str, m1: str) -> list[str]:
    """The months after ``m0`` up to ``m1`` inclusive (empty when ``m1 <= m0``)."""
    out: list[str] = []
    cur = m0
    while cur < m1:
        cur = next_month(cur)
        out.append(cur)
    return out


def real_return(nominal: Decimal, index_ratio: Decimal) -> Decimal:
    """``(1 + nominal) / index_ratio - 1``; ``index_ratio`` must be positive."""
    if index_ratio <= 0:
        raise ValueError("index ratio must be positive")
    return (ONE + nominal) / index_ratio - ONE


def chained_ratio(index: Mapping[str, Decimal], m0: str, m1: str) -> Decimal | None:
    """The product of the monthly ratios ``HICP[k] / HICP[k-1]`` for ``k`` in ``(m0, m1]``.

    ``None`` when any month in the chain (or ``m0``) is missing or not positive.
    """
    start = index.get(m0)
    if start is None or start <= 0:
        return None
    ratio = ONE
    prev = start
    for month in months_between(m0, m1):
        cur = index.get(month)
        if cur is None or cur <= 0:
            return None
        ratio *= cur / prev
        prev = cur
    return ratio


def latest_month_through(index: Mapping[str, Decimal], m1: str) -> str | None:
    """The latest month on file that is not after ``m1``."""
    candidates = [m for m in index if m <= m1]
    return max(candidates) if candidates else None


def period_real_return(
    nominal: Decimal | None,
    index: Mapping[str, Decimal],
    *,
    first_month: str,
    last_month: str,
) -> RealReturn | None:
    """The real return of a period covering ``first_month`` .. ``last_month``.

    The period starts at the close of the month before ``first_month`` (``m0``) and
    ends at the close of ``last_month`` (``m1``), or of the latest published month
    before it. ``None`` without a nominal return, without ``m0`` on file, or when
    no month after ``m0`` is published yet.
    """
    if nominal is None:
        return None
    m0 = month_before(first_month)
    to = latest_month_through(index, last_month)
    if to is None or to <= m0:
        return None
    ratio = chained_ratio(index, m0, to)
    if ratio is None:
        return None
    return RealReturn(value=real_return(nominal, ratio), to_month=to)


def label_months(label: str) -> tuple[str, str]:
    """``(first_month, last_month)`` of a Periods label (``YYYY-MM`` or ``YYYY``)."""
    if len(label) == 4:
        return f"{label}-01", f"{label}-12"
    return label, label
