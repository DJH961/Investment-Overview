"""What converting costs: each EUR to USD conversion against its own ECB fixing.

Pure maths (no I/O). Every figure is an amount at a single instant (one conversion on
one date); sums across dates are plain sums of such amounts. Never annualise a cost and
never feed it to an XIRR.

Per conversion, against the settled ECB daily reference of its own date (a weekend or
holiday conversion uses the last settled fixing *before* its date, see
:func:`fixing_for`):

* ``ecb_eur = usd_received / ecb_rate``: what the dollars would have cost at the fixing;
* ``spread_eur = eur_sent - ecb_eur`` and ``cost_eur = spread_eur + fees_eur``
  (positive = you paid more than the reference);
* ``off_pct = all_in_rate / ecb_rate - 1`` with ``all_in_rate = usd / (eur + fees)``
  (negative = fewer dollars per euro than the reference).

The dollar view is computed per conversion at its own fixing (never a EUR total at
today's rate): ``spread_usd = eur_sent * ecb_rate - usd_received`` (the dollars you did
not get), ``fees_usd = fees_eur * ecb_rate``.

The fixing is struck at about 14:15 CET, so a small negative cost is intraday noise,
not a win.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

ZERO = Decimal(0)
ONE = Decimal(1)

#: How far back a weekend or holiday conversion looks for the last settled fixing.
FIXING_LOOKBACK_DAYS = 7

Day = date
PROVIDERS = ("wise", "revolut", "other", "none")


@dataclass(frozen=True, slots=True)
class Conversion:
    id: int
    date: Day
    eur_sent: Decimal
    usd_received: Decimal
    fees_eur: Decimal
    provider: str | None
    #: The settled fixing and the date it is from; ``None`` when there is none.
    ecb_rate: Decimal | None
    ecb_rate_date: Day | None
    #: Mean of that calendar month's settled fixings (see :func:`month_average`).
    month_avg: Decimal | None = None
    #: The month is still running: the mean is of the fixings so far.
    month_so_far: bool = False


@dataclass(frozen=True, slots=True)
class ConversionCost:
    id: int
    date: Day
    provider: str
    eur_sent: Decimal
    usd_received: Decimal
    fees_eur: Decimal
    all_in_rate: Decimal
    ecb_rate: Decimal | None
    ecb_rate_date: Day | None
    ecb_eur: Decimal | None
    spread_eur: Decimal | None
    cost_eur: Decimal | None
    off_pct: Decimal | None
    #: Spread only (fees left out): ``rate / ecb_rate - 1``.
    spread_off_pct: Decimal | None
    spread_usd: Decimal | None
    fees_usd: Decimal | None
    cost_usd: Decimal | None
    month_avg: Decimal | None = None
    month_so_far: bool = False
    #: ``rate / month_avg - 1`` (rate = usd / eur_sent, fees left out): positive = you
    #: converted at a better rate (more dollars per euro) than the month's average.
    timing_pct: Decimal | None = None


@dataclass(frozen=True, slots=True)
class Timing:
    """Your rate against each conversion's calendar-month average fixing."""

    count: int
    #: EUR-weighted mean of ``timing_pct``; ``None`` without a month average.
    avg_pct: Decimal | None
    better: int
    worse: int
    #: Conversions whose month is still running (the average is "so far").
    so_far: int


@dataclass(frozen=True, slots=True)
class CostSummary:
    """Totals over a set of priced conversions."""

    count: int
    converted_eur: Decimal
    fees_eur: Decimal
    spread_eur: Decimal
    cost_eur: Decimal
    #: ``cost_eur / converted_eur``; ``None`` when nothing was converted.
    cost_pct: Decimal | None
    converted_usd: Decimal
    fees_usd: Decimal
    spread_usd: Decimal
    cost_usd: Decimal
    #: ``cost_usd / converted_usd`` (dollars received).
    cost_pct_usd: Decimal | None
    #: Average ``off_pct`` weighted by EUR sent (never a plain mean of percentages).
    avg_off_pct: Decimal | None
    #: ``sum(usd) / sum(eur + fees)`` over every conversion of the group, priced or not.
    all_in_rate: Decimal | None = None


@dataclass(frozen=True, slots=True)
class CumulativePoint:
    date: Day
    cost_eur: Decimal
    cost_usd: Decimal


@dataclass(frozen=True, slots=True)
class CostReport:
    summary: CostSummary
    best: ConversionCost | None
    worst: ConversionCost | None
    cumulative: tuple[CumulativePoint, ...]
    timing: Timing
    by_year: tuple[tuple[int, CostSummary], ...]
    #: ``("2026-03", summary)``, newest first (the Conversions page's fold headers).
    by_month: tuple[tuple[str, CostSummary], ...]
    by_provider: tuple[tuple[str, CostSummary], ...]
    #: Every conversion, newest first (unpriced ones carry ``None`` figures).
    rows: tuple[ConversionCost, ...]
    #: Conversions with no settled fixing close enough; left out of every total.
    unpriced: int


def fixing_for(
    rates: Mapping[date, Decimal], on: date, lookback_days: int = FIXING_LOOKBACK_DAYS
) -> tuple[Decimal, date] | None:
    """The fixing dated ``on``, else the last settled one before it (at most a week back)."""
    exact = rates.get(on)
    if exact is not None and exact > 0:
        return exact, on
    earliest = on - timedelta(days=lookback_days)
    earlier = [d for d, r in rates.items() if earliest <= d < on and r > 0]
    if not earlier:
        return None
    last = max(earlier)
    return rates[last], last


def conversion_cost(c: Conversion) -> ConversionCost:
    """One conversion against its fixing; the figures are ``None`` without one."""
    all_in = c.usd_received / (c.eur_sent + c.fees_eur)
    provider = (
        "none" if c.provider is None else (c.provider if c.provider in PROVIDERS else "other")
    )
    ecb = c.ecb_rate
    ecb_eur = spread = cost = off = spread_off = None
    spread_usd = fees_usd = cost_usd = None
    if ecb is not None and ecb > 0:
        ecb_eur = c.usd_received / ecb
        spread = c.eur_sent - ecb_eur
        cost = spread + c.fees_eur
        off = all_in / ecb - ONE
        spread_off = (c.usd_received / c.eur_sent) / ecb - ONE
        spread_usd = c.eur_sent * ecb - c.usd_received
        fees_usd = c.fees_eur * ecb
        cost_usd = spread_usd + fees_usd
    return ConversionCost(
        id=c.id,
        date=c.date,
        provider=provider,
        eur_sent=c.eur_sent,
        usd_received=c.usd_received,
        fees_eur=c.fees_eur,
        all_in_rate=all_in,
        ecb_rate=ecb,
        ecb_rate_date=c.ecb_rate_date,
        ecb_eur=ecb_eur,
        spread_eur=spread,
        cost_eur=cost,
        off_pct=off,
        spread_off_pct=spread_off,
        spread_usd=spread_usd,
        fees_usd=fees_usd,
        cost_usd=cost_usd,
        month_avg=c.month_avg,
        month_so_far=c.month_so_far,
        timing_pct=(
            (c.usd_received / c.eur_sent) / c.month_avg - ONE
            if c.month_avg is not None and c.month_avg > 0
            else None
        ),
    )


def month_average(
    rates: Mapping[date, Decimal], on: date, today: date
) -> tuple[Decimal, bool] | None:
    """Mean of the settled fixings in ``on``'s calendar month, up to ``today``.

    Returns ``(mean, so_far)``; ``so_far`` is True while the month is still running
    (``today`` falls in it), so the mean covers the fixings up to the latest settled one.
    ``None`` when the month has no fixing.
    """
    month = [
        r
        for d, r in rates.items()
        if d.year == on.year and d.month == on.month and d <= today and r > 0
    ]
    if not month:
        return None
    so_far = (today.year, today.month) == (on.year, on.month)
    return sum(month, ZERO) / len(month), so_far


def timing(rows: Sequence[ConversionCost]) -> Timing:
    """The EUR-weighted average of ``timing_pct`` and how many beat the month average."""
    chosen = [r for r in rows if r.timing_pct is not None]
    weight = sum((r.eur_sent for r in chosen), ZERO)
    avg = (
        sum((r.eur_sent * (r.timing_pct or ZERO) for r in chosen), ZERO) / weight
        if weight > 0
        else None
    )
    return Timing(
        count=len(chosen),
        avg_pct=avg,
        better=sum(1 for r in chosen if (r.timing_pct or ZERO) > 0),
        worse=sum(1 for r in chosen if (r.timing_pct or ZERO) < 0),
        so_far=sum(1 for r in chosen if r.month_so_far),
    )


def _priced(rows: Sequence[ConversionCost]) -> list[ConversionCost]:
    return [r for r in rows if r.cost_eur is not None]


def summarise(rows: Sequence[ConversionCost]) -> CostSummary:
    """Totals over the priced conversions of ``rows`` (unpriced ones are skipped)."""
    priced = _priced(rows)
    converted = sum((r.eur_sent for r in priced), ZERO)
    conv_usd = sum((r.usd_received for r in priced), ZERO)
    cost = sum((r.cost_eur or ZERO for r in priced), ZERO)
    cost_usd = sum((r.cost_usd or ZERO for r in priced), ZERO)
    weighted = sum((r.eur_sent * (r.off_pct or ZERO) for r in priced), ZERO)
    return CostSummary(
        count=len(priced),
        converted_eur=converted,
        fees_eur=sum((r.fees_eur for r in priced), ZERO),
        spread_eur=sum((r.spread_eur or ZERO for r in priced), ZERO),
        cost_eur=cost,
        cost_pct=cost / converted if converted > 0 else None,
        converted_usd=conv_usd,
        fees_usd=sum((r.fees_usd or ZERO for r in priced), ZERO),
        spread_usd=sum((r.spread_usd or ZERO for r in priced), ZERO),
        cost_usd=cost_usd,
        cost_pct_usd=cost_usd / conv_usd if conv_usd > 0 else None,
        avg_off_pct=weighted / converted if converted > 0 else None,
        all_in_rate=(
            sum((r.usd_received for r in rows), ZERO)
            / sum((r.eur_sent + r.fees_eur for r in rows), ZERO)
            if rows
            else None
        ),
    )


def provider_avg_off_pct(rows: Sequence[ConversionCost], provider: str | None) -> Decimal | None:
    """A provider's average distance from the ECB fixing, fees left out.

    ``rate / ecb_rate - 1`` per conversion, weighted by EUR sent (negative = fewer
    dollars per euro than the reference). ``provider`` is ``"wise"``, ``"revolut"``,
    ``"other"`` or ``None`` (no provider recorded). ``None`` when the provider has no
    priced conversion. A caller prices an estimated conversion of ``usd`` dollars on a
    day with fixing ``ecb`` as ``usd / (ecb * (1 + avg))`` euros.
    """
    key = "none" if provider is None else provider
    chosen = [r for r in _priced(rows) if r.provider == key]
    weight = sum((r.eur_sent for r in chosen), ZERO)
    if weight <= 0:
        return None
    return sum((r.eur_sent * (r.spread_off_pct or ZERO) for r in chosen), ZERO) / weight


def build_report(
    conversions: Sequence[Conversion],
    *,
    start: date | None = None,
    end: date | None = None,
) -> CostReport:
    """Everything the Conversions section shows, for conversions dated in ``[start, end]``."""
    costs = [
        conversion_cost(c)
        for c in conversions
        if (start is None or c.date >= start) and (end is None or c.date <= end)
    ]
    asc = sorted(costs, key=lambda r: (r.date, r.id))
    priced = _priced(asc)
    ranked = sorted(priced, key=lambda r: (r.off_pct or ZERO, r.date, r.id))
    cumulative: list[CumulativePoint] = []
    run_eur = run_usd = ZERO
    for r in priced:
        run_eur += r.cost_eur or ZERO
        run_usd += r.cost_usd or ZERO
        point = CumulativePoint(r.date, run_eur, run_usd)
        if cumulative and cumulative[-1].date == r.date:
            cumulative[-1] = point
        else:
            cumulative.append(point)
    years: dict[int, list[ConversionCost]] = defaultdict(list)
    provs: dict[str, list[ConversionCost]] = defaultdict(list)
    months: dict[str, list[ConversionCost]] = defaultdict(list)
    for r in asc:
        years[r.date.year].append(r)
        months[r.date.isoformat()[:7]].append(r)
        provs[r.provider].append(r)
    return CostReport(
        summary=summarise(asc),
        best=ranked[-1] if ranked else None,
        worst=ranked[0] if ranked else None,
        cumulative=tuple(cumulative),
        timing=timing(asc),
        by_year=tuple((y, summarise(years[y])) for y in sorted(years, reverse=True)),
        by_month=tuple((m, summarise(months[m])) for m in sorted(months, reverse=True)),
        by_provider=tuple((p, summarise(provs[p])) for p in PROVIDERS if p in provs),
        rows=tuple(reversed(asc)),
        unpriced=len(asc) - len(priced),
    )
