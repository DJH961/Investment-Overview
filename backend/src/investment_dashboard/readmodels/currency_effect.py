"""Currency page Impact read model (v7.2, ``GET /currency/effect/both?range=``).

Everything is built per reporting currency from :mod:`domain.fx_attribution`:

* **Daily parts, lifetime, cached.** One attribution over the whole ledger per
  reporting currency (:func:`lifetime`): rows from
  :func:`readmodels.fx_attribution_rows.build_attribution_rows` (7.1's per-holding
  values + cash, settled daily rates, the cashflow-legs flows). A range is a slice
  of those daily parts (each part depends only on its own two closes, so slicing
  is exact). Ranges end at the **last stored close (yesterday)**: today's holding
  rows are live, never stored, and today is the 1D range (the Overview's own
  figures).
* **Headline returns** are computed in each currency on its own and subtracted,
  never converted: the Periods rows (``periods.build_for_ccy``) for YTD, calendar
  years and All (years chained); a daily time-weighted chain over each currency's
  own parts for the rolling ranges; the Overview's own day growth for 1D.
* **1D / 1W chart**: the Overview's intraday value line in the side's currency,
  each point with the rate stored beside its sample; the currency effect between
  two points is the session's book revalued from one point's rate to the next.
* **Inside / outside market hours** from the recorded session open/close rates
  (``fx_session_rates``), only for days whose sessions are all recorded.
* **The All range** is the day-by-day lifetime total. It differs from the
  Overview card's ``fx_pnl_eur`` (today's dollars against the average buy rate) by
  ``P - C = sum dN_t (x_{t-1} - 1/r_avg)``; :data:`ALL_EXPLAINER` says so.

Transport: money and rates are rounded to 6 dp, fractions to 8 dp. The bridge's
market part is sent as the residual of the rounded figures, so it adds up exactly
as sent.
"""

from __future__ import annotations

import bisect
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.domain import dividends as dividends_domain
from investment_dashboard.domain import fx_attribution as fa
from investment_dashboard.domain import fx_effect_split, fx_trend
from investment_dashboard.domain.market_hours import exchange_today, is_trading_day
from investment_dashboard.domain.session_fx import fx_buying_power_split
from investment_dashboard.readmodels import fx_attribution_rows as rows_rm
from investment_dashboard.readmodels import periods as periods_rm
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.repositories import instruments_repo, transactions_repo
from investment_dashboard.services import (
    fx_session_rates_service,
    intraday_snapshots_service,
    metrics_service,
)
from investment_dashboard.services.read_cache import cached_read

ZERO = Decimal(0)
ONE = Decimal(1)
Q_MONEY = Decimal("0.000001")
Q_FRAC = Decimal("0.00000001")
INTRADAY_RANGES = frozenset({"1d", "1w"})
FIXED_RANGES: tuple[str, ...] = ("1d", "1w", "1m", "3m", "ytd", "1y", "3y", "all")
_MONTHS = {"1m": 1, "3m": 3, "1y": 12, "3y": 36}
#: About 12 months of business days (``fa.ROLLING_WINDOWS[-1]``).
ROLLING_WINDOW = 252
#: Above this many daily points a series is thinned to the last close of each week.
MAX_DAILY_POINTS = 1100
#: "€1,000 buys $X" (plan §5, Today stats).
BUYS_AMOUNT_EUR = Decimal(1000)
_CURRENCY_NAMES = {"USD": "dollar", "EUR": "euro", "GBP": "pound", "CHF": "franc"}

ALL_EXPLAINER = (
    "Lifetime here is summed day by day: each day, the {foreign} you held then were "
    "revalued from the previous day's rate to that day's. The Overview card instead "
    "compares today's {foreign} with what they cost at your average buy rate, so the "
    "two differ whenever the rate moved while your holdings grew or shrank."
)


# -- small helpers ---------------------------------------------------------------------


def _q(value: Decimal) -> Decimal:
    return value.quantize(Q_MONEY)


def _qf(value: Decimal) -> Decimal:
    return value.quantize(Q_FRAC)


def _m(value: Decimal | None) -> str | None:
    return None if value is None else dec(_q(value))


def _f(value: Decimal | None) -> str | None:
    return None if value is None else dec(_qf(value))


def _d(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except ArithmeticError:
        return None


def kind_of(value: Decimal) -> str:
    """``tailwind`` / ``headwind`` / ``neutral`` for the side's reader."""
    if value > 0:
        return "tailwind"
    if value < 0:
        return "headwind"
    return "neutral"


def _minus_months(day: date, months: int) -> date:
    total = day.year * 12 + (day.month - 1) - months
    year, month = divmod(total, 12)
    month += 1
    for dd in (day.day, 30, 29, 28):
        try:
            return date(year, month, dd)
        except ValueError:
            continue
    return date(year, month, 28)  # pragma: no cover - unreachable


def last_settled_day(today: date | None = None) -> date:
    """The last close the daily parts run through (yesterday, exchange date)."""
    return (today or exchange_today()) - timedelta(days=1)


def range_window(range_key: str, today: date) -> tuple[date, date]:
    """``(after, through)``: a range is the daily parts with ``after < on <= through``."""
    end = last_settled_day(today)
    if range_key == "all":
        return date.min, end
    if range_key == "ytd":
        return date(today.year - 1, 12, 31), end
    if range_key.isdigit():
        year = int(range_key)
        return date(year - 1, 12, 31), min(date(year, 12, 31), end)
    if range_key == "1d":
        return end - timedelta(days=1), end
    if range_key == "1w":
        return today - timedelta(days=7), end
    if range_key in _MONTHS:
        return _minus_months(today, _MONTHS[range_key]), end
    raise ValueError(f"unknown range {range_key!r}")


def foreign_name(currencies: Iterable[str]) -> str:
    """``dollar`` / ``euro`` / ... for one foreign currency, ``currencies`` for several."""
    codes = sorted({c.upper() for c in currencies})
    if len(codes) == 1:
        return _CURRENCY_NAMES.get(codes[0], codes[0])
    return "foreign currencies"


# -- lifetime daily parts (cached) -------------------------------------------------------


@dataclass(frozen=True)
class Lifetime:
    """The whole ledger's attribution in one reporting currency."""

    reporting: str
    rows: list[fa.AttributionDay]
    parts: list[fa.DayParts]

    def window(self, after: date, through: date) -> list[int]:
        """Indexes into ``parts`` with ``after < on <= through``."""
        ons = [p.on for p in self.parts]
        lo = bisect.bisect_right(ons, after)
        hi = bisect.bisect_right(ons, through)
        return list(range(lo, hi))

    @property
    def foreign(self) -> list[str]:
        held = {c for r in self.rows for c, v in r.book.items() if v}
        return sorted(c for c in held if c != self.reporting)


def first_ledger_date(session: Session) -> date | None:
    txns = transactions_repo.list_transactions(session)
    return min((t.date for t in txns), default=None)


def build_lifetime(
    session: Session,
    reporting: str,
    *,
    through: date | None = None,
    source: rows_rm.HoldingValuesSource = rows_rm.REAL_SOURCE,
) -> Lifetime | None:
    """The lifetime attribution in ``reporting``; ``None`` for an empty ledger."""
    first = first_ledger_date(session)
    end = through or last_settled_day()
    if first is None or end < first:
        return None
    rows = rows_rm.build_attribution_rows(
        session, first - timedelta(days=1), end, reporting, source=source
    )
    return Lifetime(reporting.upper(), rows, fa.attribute_days(rows, reporting))


@cached_read
def lifetime(session: Session, reporting: str) -> Lifetime | None:
    """:func:`build_lifetime` through yesterday, cached until the data changes."""
    return build_lifetime(session, reporting)


@cached_read
def _yearly_growth(session: Session, ccy: str) -> dict[str, Decimal | None]:
    rows = periods_rm.build_for_ccy(session, monthly=False, ccy=ccy)["rows"]
    return {str(r["label"]): _d(r.get("growth_pct")) for r in rows}


# -- returns ------------------------------------------------------------------------------


def chained_return(parts: Sequence[fa.DayParts]) -> Decimal | None:
    """Daily Modified-Dietz returns chained over ``parts`` (one currency's own parts).

    ``(end - start - flow) / (start + flow / 2)`` per day, linked geometrically;
    days with an empty book are skipped; ``None`` on a non-positive denominator or
    when no day counts.
    """
    growth = ONE
    counted = False
    for p in parts:
        denom = p.start + p.flow / 2
        if denom <= 0:
            if p.start == 0 and p.end == 0 and p.flow == 0:
                continue
            return None
        growth *= ONE + (p.end - p.start - p.flow) / denom
        counted = True
    return growth - ONE if counted else None


def _periods_return(session: Session, ccy: str, range_key: str, today: date) -> Decimal | None:
    growth: dict[str, Decimal | None] = _yearly_growth(session=session, ccy=ccy)
    if range_key == "ytd":
        return growth.get(str(today.year))
    if range_key.isdigit():
        return growth.get(range_key)
    # all: every year chained
    if not growth or any(v is None for v in growth.values()):
        return None
    total = ONE
    for value in growth.values():
        total *= ONE + (value or ZERO)
    return total - ONE


def headline_returns(
    session: Session,
    range_key: str,
    today: date,
    parts_by_ccy: Mapping[str, Sequence[fa.DayParts]],
    overview: Mapping[str, Mapping[str, Any]],
) -> tuple[Decimal | None, Decimal | None, str]:
    """``(eur_return, usd_return, basis)``, each currency computed on its own."""
    if range_key == "1d":
        return (
            _d(overview["EUR"]["kpis"].get("daily_growth_pct")),
            _d(overview["USD"]["kpis"].get("daily_growth_pct")),
            "day",
        )
    if range_key == "ytd" or range_key.isdigit() or range_key == "all":
        eur = _periods_return(session, "EUR", range_key, today)
        usd = _periods_return(session, "USD", range_key, today)
        if eur is not None and usd is not None:
            return eur, usd, "periods"
    return (
        chained_return(parts_by_ccy.get("EUR", ())),
        chained_return(parts_by_ccy.get("USD", ())),
        "daily_chain",
    )


def currency_share(market: Decimal, currency: Decimal) -> Decimal | None:
    """``|currency| / (|market| + |currency|)``; ``None`` when both are zero."""
    total = abs(market) + abs(currency)
    if total == 0:
        return None
    return abs(currency) / total


# -- series ---------------------------------------------------------------------------------


def _thin_weekly(points: list[fa.CumulativePoint]) -> list[fa.CumulativePoint]:
    """The last point of each ISO week (first and last points kept)."""
    out: list[fa.CumulativePoint] = []
    for i, p in enumerate(points):
        nxt = points[i + 1] if i + 1 < len(points) else None
        if i == 0 or nxt is None or nxt.on.isocalendar()[:2] != p.on.isocalendar()[:2]:
            out.append(p)
    return out


def daily_series(parts: Sequence[fa.DayParts]) -> tuple[list[dict[str, Any]], str]:
    points = fa.cumulative_series(parts)
    granularity = "daily"
    if len(points) > MAX_DAILY_POINTS:
        points = _thin_weekly(points)
        granularity = "weekly"
    return [
        {
            "t": p.on.isoformat(),
            "value": _m(p.value),
            "constant_currency": _m(p.constant_currency),
            "currency": _m(p.currency),
        }
        for p in points
    ], granularity


def _pair_rates(base: Mapping[str, fa.FxRate], fx: Decimal, reporting: str) -> dict[str, fa.FxRate]:
    """``base`` with the EUR/USD leg replaced by ``fx`` (other crosses kept as they are)."""
    out = dict(base)
    if reporting == "EUR":
        if "USD" in out:
            out["USD"] = fa.FxRate(divide_by=fx)
        return out
    for ccy, rate in base.items():
        if ccy == "EUR":
            out[ccy] = fa.FxRate(multiply_by=fx)
        else:
            out[ccy] = fa.FxRate(divide_by=rate.divide_by, multiply_by=fx)
    return out


def _book_map(session: Session, on: date) -> dict[str, Decimal]:
    book: dict[str, Decimal] = defaultdict(lambda: ZERO)
    for h in metrics_service.book_holdings(session, on):
        book[h.currency.upper()] += h.native_value
    return dict(book)


def _naive_utc(at: datetime) -> datetime:
    return at.astimezone(UTC).replace(tzinfo=None) if at.tzinfo is not None else at


def _cross_rates(
    session: Session, book: Mapping[str, Decimal], reporting: str, on: date
) -> dict[str, fa.FxRate]:
    """Day rates of the book's foreign currencies (EUR/USD replaced per point later)."""
    rates = rows_rm.RateBook(session, reporting, book.keys())
    out: dict[str, fa.FxRate] = {}
    for ccy in rates.foreign:
        rate = rates.rate(ccy, on)
        if rate is not None:
            out[ccy] = rate
    return out


def intraday_series(
    session: Session,
    reporting: str,
    *,
    range_key: str,
    now: datetime,
    live_fx: Decimal | None,
    anchor_fx: Decimal | None,
) -> list[dict[str, Any]]:
    """The 1D / 1W constant-currency line from the intraday value series.

    Point ``k``'s currency step revalues its session's book from point ``k-1``'s
    rate to its own (the rate stored beside each sample; the live tip at
    ``live_fx``). 1D starts from ``anchor_fx`` (the previous close rate).
    """
    from investment_dashboard.readmodels.queries.overview_query import (  # noqa: PLC0415
        build_intraday_value_series,
        build_week_value_series,
    )

    build = build_intraday_value_series if range_key == "1d" else build_week_value_series
    points = build(session, currency=reporting, now=now)
    if len(points) < 2:
        return []
    times = [_naive_utc(p.date) for p in points if isinstance(p.date, datetime)]
    if len(times) != len(points):
        return []
    stored = intraday_snapshots_service.stored_sample_rates(
        session, times[0] - timedelta(minutes=30), times[-1]
    )
    stored_at = sorted(stored)

    def fx_at(at: datetime, last: bool) -> Decimal | None:
        if at in stored:
            return stored[at]
        if last and live_fx is not None:
            return live_fx
        i = bisect.bisect_right(stored_at, at)
        return stored[stored_at[i - 1]] if i else live_fx

    books: dict[date, dict[str, Decimal]] = {}
    crosses: dict[date, dict[str, fa.FxRate]] = {}
    out: list[dict[str, Any]] = []
    cumulative = ZERO
    prev_fx = anchor_fx if range_key == "1d" else None
    for i, (p, at) in enumerate(zip(points, times, strict=True)):
        fx = fx_at(at, i == len(points) - 1)
        on = intraday_snapshots_service.session_date_of(at)
        if on not in books:
            books[on] = _book_map(session, on)
            crosses[on] = _cross_rates(session, books[on], reporting, on)
        if fx is not None and prev_fx is not None and fx > 0 and prev_fx > 0:
            base = crosses[on]
            cumulative += fa.revaluation(
                books[on],
                reporting,
                rates_from=_pair_rates(base, prev_fx, reporting),
                rates_to=_pair_rates(base, fx, reporting),
            )
        if fx is not None and fx > 0:
            prev_fx = fx
        out.append(
            {
                "t": at.replace(tzinfo=UTC).isoformat(),
                "value": _m(p.value),
                "constant_currency": _m(p.value - cumulative),
                "currency": _m(cumulative),
            }
        )
    return out


# -- bars, grid, rolling, runs ------------------------------------------------------------


def bars(bridges: Sequence[fa.Bridge]) -> list[dict[str, Any]]:
    return [
        {"label": b.label, "currency": _m(b.currency), "kind": kind_of(b.currency)} for b in bridges
    ]


def month_grid(months: Sequence[fa.Bridge]) -> list[dict[str, Any]]:
    by_year: dict[int, list[Decimal | None]] = {}
    for m in months:
        year, month = int(m.label[:4]), int(m.label[5:7])
        by_year.setdefault(year, [None] * 12)[month - 1] = m.currency
    out = []
    for year in sorted(by_year):
        cells = by_year[year]
        total = sum((c for c in cells if c is not None), ZERO)
        out.append(
            {
                "year": year,
                "months": [_m(c) for c in cells],
                "total": _m(total),
                "kind": kind_of(total),
            }
        )
    return out


def longest_runs(months: Sequence[fa.Bridge]) -> dict[int, tuple[int, str]]:
    """``{1: (length, since), -1: (length, since)}``: the longest same-sign month runs."""
    best: dict[int, tuple[int, str]] = {}
    sign, length, since = 0, 0, ""
    for m in months:
        s = 1 if m.currency > 0 else -1 if m.currency < 0 else 0
        if s != 0 and s == sign:
            length += 1
        else:
            sign, length, since = s, (1 if s else 0), m.label
        if s and length > best.get(s, (0, ""))[0]:
            best[s] = (length, since)
    return best


def run_statement(run: fa.Run, name: str) -> str:
    months = f"{run.length} month{'s' if run.length != 1 else ''} running"
    if run.sign > 0:
        return f"The {name} has helped you {months}."
    return f"The {name} has held you back {months}."


# -- inside / outside market hours ----------------------------------------------------------


def session_split_for(
    life: Lifetime,
    indexes: Sequence[int],
    recorded: Mapping[date, tuple[Decimal, Decimal]],
) -> dict[str, Any] | None:
    """Split the range's currency part at the recorded sessions (see the module doc)."""
    if not indexes:
        return None
    rep = life.reporting
    inside = outside = covered = uncovered = ZERO
    first = min(recorded) if recorded else None
    any_uncovered = False
    with fa.exact_context():
        for i in indexes:
            part, prev, cur = life.parts[i], life.rows[i], life.rows[i + 1]
            days = []
            d = part.prev_on
            while d < part.on:
                if is_trading_day(d):
                    days.append(d)
                d += timedelta(days=1)
            if any(d not in recorded for d in days):
                uncovered += part.currency
                any_uncovered = True
                continue
            sessions = [
                (
                    _pair_rates(prev.rates, recorded[d][0], rep),
                    _pair_rates(prev.rates, recorded[d][1], rep),
                )
                for d in days
            ]
            legs = fx_effect_split.session_split(
                cur.book, rep, prev_rates=prev.rates, sessions=sessions, cur_rates=cur.rates
            )
            inside += legs.inside
            outside += legs.outside
            covered += legs.currency
    inside_q, covered_q = _q(inside), _q(covered)
    note = None
    if any_uncovered:
        note = (
            f"split not available before {first.isoformat()}"
            if first is not None
            else "split not available yet: session rates are recorded from now on"
        )
    return {
        "inside": dec(inside_q),
        "outside": dec(covered_q - inside_q),
        "covered_currency": dec(covered_q),
        "uncovered_currency": _m(uncovered),
        "available_from": first.isoformat() if first is not None else None,
        "note": note,
    }


# -- per holding ------------------------------------------------------------------------------


def _reinvested(session: Session) -> dict[tuple[date, int], Decimal]:
    txns = list(transactions_repo.list_transactions(session))
    keys = dividends_domain.reinvest_keys(txns)
    out: dict[tuple[date, int], Decimal] = defaultdict(lambda: ZERO)
    for t in txns:
        if t.kind == "dividend_reinvest" and t.instrument_id is not None:
            amount = dividends_domain.income_value_native(t, keys)
            if amount:
                out[(t.date, t.instrument_id)] += amount
    return out


def holdings_split(
    session: Session,
    reporting: str,
    after: date,
    through: date,
    *,
    first: date,
    source: rows_rm.HoldingValuesSource = rows_rm.REAL_SOURCE,
) -> list[dict[str, Any]]:
    """Per instrument: price · dividends · currency over ``(after, through]``, in ``reporting``."""
    lo = max(after, first - timedelta(days=1))
    if through <= lo:
        return []
    values = source.holding_values(session, lo - timedelta(days=10), through)
    reinvested = _reinvested(session)
    # (instrument, ccy) -> date -> [value, inflow, dividends]
    groups: dict[tuple[int, str], dict[date, list[Decimal]]] = defaultdict(dict)
    for hv in values:
        cell = groups[(hv.instrument_id, hv.currency.upper())].setdefault(
            hv.date, [ZERO, ZERO, ZERO]
        )
        cell[0] += hv.value_native
        cell[1] += hv.net_flow_native
        cell[2] += hv.dividends_native
    if not groups:
        return []
    rates = rows_rm.RateBook(session, reporting, {c for _i, c in groups})
    fixings = rates.fixing_dates(lo, through)
    instruments = {i.id: i for i in instruments_repo.list_instruments(session)}
    out: list[dict[str, Any]] = []
    for (iid, ccy), by_day in groups.items():
        start_value = ZERO
        before = [d for d in by_day if d <= lo]
        if before:
            start_value = by_day[max(before)][0]
        start_rate = rates.rate(ccy, lo)
        dates = sorted(
            {d for d in by_day if lo < d <= through} | (fixings if ccy != reporting else set())
        )
        if not dates or (start_rate is None and start_value):
            continue
        days: list[tuple[fx_effect_split.HoldingDay, fa.FxRate]] = []
        value = start_value
        prev_rate = start_rate
        for d in dates:
            rate = rates.rate(ccy, d) or prev_rate
            if rate is None:
                continue
            got = by_day.get(d)
            if got is not None:
                value = got[0]
                inflow = got[1] + reinvested.get((d, iid), ZERO)
                paid = got[2]
            else:
                inflow = paid = ZERO
            days.append((fx_effect_split.HoldingDay(d, value, inflow, paid), rate))
            prev_rate = rate
        if not days:
            continue
        split = fx_effect_split.holding_split(start_value, start_rate or days[0][1], days)
        if not (split.price or split.dividends or split.currency or start_value or value):
            continue
        instr = instruments.get(iid)
        price_q, div_q, cur_q = _q(split.price), _q(split.dividends), _q(split.currency)
        out.append(
            {
                "instrument_id": iid,
                "symbol": instr.symbol if instr is not None else str(iid),
                "name": instr.name if instr is not None else None,
                "native_ccy": ccy,
                "price": dec(price_q),
                "dividends": dec(div_q),
                "currency": dec(cur_q),
                "total": dec(price_q + div_q + cur_q),
            }
        )
    out.sort(key=lambda r: Decimal(r["total"]), reverse=True)
    return out


# -- stats --------------------------------------------------------------------------------------


def _stat(key: str, value: Decimal, unit: str, **extra: Any) -> dict[str, Any]:
    q = _qf if unit == "fraction" else _q
    return {"key": key, "value": dec(q(value)), "unit": unit, **extra}


def effect_stats(
    ccy: str,
    headline: Mapping[str, Any],
    parts: Sequence[fa.DayParts],
    months: Sequence[fa.Bridge],
    lifetime_months: Decimal | None,
    lifetime_effect: Decimal | None,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for key in ("eur_return", "usd_return", "effect_pp"):
        value = _d(headline.get(key))
        if value is not None:
            out.append(_stat(key, value, "fraction"))
    effect = _d(headline["effect"]) or ZERO
    out.append(_stat("effect", effect, "money", currency=ccy, kind=kind_of(effect)))
    share = _d(headline.get("currency_share"))
    if share is not None:
        out.append(_stat("currency_share", share, "fraction"))
    if months:
        best = max(months, key=lambda m: m.currency)
        worst = min(months, key=lambda m: m.currency)
        out.append(
            _stat(
                "best_month",
                best.currency,
                "money",
                currency=ccy,
                label=best.label,
                kind=kind_of(best.currency),
            )
        )
        out.append(
            _stat(
                "worst_month",
                worst.currency,
                "money",
                currency=ccy,
                label=worst.label,
                kind=kind_of(worst.currency),
            )
        )
        share_up = fa.tailwind_share(months)
        if share_up is not None:
            out.append(_stat("tailwind_share", share_up, "fraction"))
        runs = longest_runs(months)
        if 1 in runs:
            out.append(
                _stat(
                    "longest_tailwind",
                    Decimal(runs[1][0]),
                    "count",
                    label=runs[1][1],
                    kind="tailwind",
                )
            )
        if -1 in runs:
            out.append(
                _stat(
                    "longest_headwind",
                    Decimal(runs[-1][0]),
                    "count",
                    label=runs[-1][1],
                    kind="headwind",
                )
            )
    typical = fa.median_abs_daily(parts)
    if typical is not None:
        out.append(_stat("typical_day", typical, "money", currency=ccy))
    largest = fa.largest_day(parts)
    if largest is not None:
        out.append(
            _stat(
                "largest_day",
                largest.currency,
                "money",
                currency=ccy,
                label=largest.label,
                kind=kind_of(largest.currency),
            )
        )
    if lifetime_months is not None and lifetime_effect is not None:
        out.append(
            _stat(
                "months_of_contributions",
                lifetime_months,
                "count",
                secondary=_m(lifetime_effect),
                secondary_unit="money",
                secondary_currency=ccy,
                kind=kind_of(lifetime_effect),
            )
        )
    return out


def _today_rate_range(session: Session, now: datetime) -> tuple[Decimal, Decimal] | None:
    rates = [
        fx
        for _at, _eur, fx in intraday_snapshots_service.day_series_with_fx(session, now=now)
        if fx is not None and fx > 0
    ]
    return (min(rates), max(rates)) if rates else None


def _buys(session: Session, today: Mapping[str, Any], now: datetime) -> dict[str, Any] | None:
    from investment_dashboard.readmodels.fx_effect import fx_box_regime  # noqa: PLC0415

    spot, prev = _d(today.get("spot")), _d(today.get("prev"))
    if spot is None or spot <= 0:
        return None
    market_open = fx_box_regime(now).market_open
    split = fx_buying_power_split(
        market_open=market_open,
        amount_eur=BUYS_AMOUNT_EUR,
        live_fx=spot,
        prev_fx=prev,
        session_close_fx=None
        if market_open
        else intraday_snapshots_service.session_close_fx(session, now=now),
        session_open_fx=intraday_snapshots_service.day_open_rate(session, now=now)
        if market_open
        else None,
    )
    has_prev = prev is not None and prev > 0
    return {
        "amount_eur": dec(BUYS_AMOUNT_EUR),
        "usd_now": _m(BUYS_AMOUNT_EUR * spot),
        "usd_prev": _m(BUYS_AMOUNT_EUR * prev) if has_prev and prev is not None else None,
        "change_usd": _m(BUYS_AMOUNT_EUR * (spot - prev))
        if has_prev and prev is not None
        else None,
        "market_hours_usd": _m(split.market_hours_usd),
        "overnight_usd": _m(split.overnight_usd),
    }


# -- the payload ---------------------------------------------------------------------------------


def _bridge(parts: Sequence[fa.DayParts]) -> dict[str, Any] | None:
    if not parts:
        return None
    b = fa.bridge(parts)
    start, end, flows, currency = _q(b.start), _q(b.end), _q(b.flows), _q(b.currency)
    return {
        "start_on": b.start_on.isoformat(),
        "end_on": b.end_on.isoformat(),
        "start": dec(start),
        "deposits": dec(flows),
        "market": dec(end - start - flows - currency),
        "currency": dec(currency),
        "end": dec(end),
    }


def _records(
    parts: Sequence[fa.DayParts], life: Lifetime | None
) -> tuple[dict[str, Any], Decimal | None, Decimal | None]:
    rec = fa.records(parts)

    def one(e: fa.Extreme | None) -> dict[str, Any] | None:
        return None if e is None else {"label": e.label, "currency": _m(e.currency)}

    lifetime_effect = average = months = None
    if life is not None and life.parts:
        lifetime_effect = fa.bridge(life.parts).currency
        contributions = rows_rm.monthly_contributions(life.rows)
        if contributions:
            average = sum(contributions, ZERO) / Decimal(len(contributions))
        months = fa.months_of_contributions(lifetime_effect, contributions)
    out = {
        "best_day": one(rec.best_day),
        "worst_day": one(rec.worst_day),
        "best_month": one(rec.best_month),
        "worst_month": one(rec.worst_month),
        "best_year": one(rec.best_year),
        "worst_year": one(rec.worst_year),
        "lifetime_effect": _m(lifetime_effect),
        "average_monthly_contribution": _m(average),
        "lifetime_months_of_contributions": _f(months),
    }
    return out, lifetime_effect, months


def _day_split_effect(payload: Mapping[str, Any]) -> tuple[Decimal, Decimal] | None:
    """``(currency, market)`` of the Overview's ``day_split`` for this side."""
    split = payload.get("day_split")
    if not split:
        return None
    currency = _d(split.get("currency_move"))
    price = _d(split.get("price_move"))
    if currency is None or price is None:
        return None
    market = price if split.get("overnight") else price - currency
    return currency, market


def _one_side(  # noqa: PLR0912, PLR0915
    session: Session,
    ccy: str,
    range_key: str,
    *,
    today: date,
    now: datetime,
    lives: Mapping[str, Lifetime | None],
    returns: tuple[Decimal | None, Decimal | None, str],
    payload: Mapping[str, Any],
    recorded: Mapping[date, tuple[Decimal, Decimal]],
    first: date | None,
) -> dict[str, Any]:
    life = lives.get(ccy)
    after, through = range_window(range_key, today)
    idx = life.window(after, through) if life is not None else []
    parts = [life.parts[i] for i in idx] if life is not None else []
    eur_ret, usd_ret, basis = returns
    effect_pp = eur_ret - usd_ret if eur_ret is not None and usd_ret is not None else None

    if parts:
        b = fa.bridge(parts)
        effect, market = b.currency, b.market
    else:
        effect = market = ZERO
    cur = payload["currency"]
    today_block = cur["today"]
    if range_key == "1d":
        day = _day_split_effect(payload)
        if day is not None:
            effect, market = day
    headline = {
        "eur_return": _f(eur_ret),
        "usd_return": _f(usd_ret),
        "effect_pp": _f(effect_pp),
        "effect": _m(effect),
        "market": _m(market),
        "currency_share": _f(currency_share(market, effect)),
        "kind": kind_of(effect),
        "return_basis": basis,
    }

    if range_key in INTRADAY_RANGES:
        series = intraday_series(
            session,
            ccy,
            range_key=range_key,
            now=now,
            live_fx=_d(today_block.get("spot")),
            anchor_fx=_d(today_block.get("prev")),
        )
        granularity = "intraday"
    else:
        series, granularity = daily_series(parts)

    months = fa.month_totals(parts)
    lifetime_months_list = fa.month_totals(life.parts) if life is not None else []
    rolling: list[dict[str, Any]] = []
    run = None
    if life is not None and life.parts:
        roll = fa.rolling_currency(life.parts, ROLLING_WINDOW)
        lo = parts[0].prev_on if parts else through
        roll = [r for r in roll if lo <= r.on <= through]
        if len(roll) > MAX_DAILY_POINTS:
            roll = [
                r
                for i, r in enumerate(roll)
                if i == len(roll) - 1 or roll[i + 1].on.isocalendar()[:2] != r.on.isocalendar()[:2]
            ]
        rolling = [{"t": r.on.isoformat(), "currency": _m(r.currency)} for r in roll]
        current = fa.current_run(lifetime_months_list)
        if current is not None:
            run = {
                "kind": "tailwind" if current.sign > 0 else "headwind",
                "months": current.length,
                "since": current.since,
                "currency": _m(current.currency),
                "statement": run_statement(
                    current, foreign_name(life.foreign or ["USD" if ccy == "EUR" else "EUR"])
                ),
            }
    records, lifetime_effect, lifetime_months = _records(parts, life)

    split: dict[str, Any] | None
    if range_key == "1d":
        legs = today_block.get("effect_eur") or {} if ccy == "EUR" else {}
        mh, on_ = _d(legs.get("market_hours")), _d(legs.get("overnight"))
        if mh is not None and on_ is not None:
            covered = _q(mh) + _q(on_)
            split = {
                "inside": _m(mh),
                "outside": _m(on_),
                "covered_currency": dec(covered),
                "uncovered_currency": dec(_q(effect) - covered),
                "available_from": first.isoformat() if first is not None else None,
                "note": None,
            }
        else:
            split = None
    else:
        split = session_split_for(life, idx, recorded) if life is not None else None

    holdings: list[dict[str, Any]] = []
    ledger_first = life.rows[0].on + timedelta(days=1) if life is not None and life.rows else None
    if ledger_first is not None and range_key != "1d":
        holdings = holdings_split(session, ccy, after, through, first=ledger_first)

    stats = effect_stats(ccy, headline, parts, months, lifetime_months, lifetime_effect)
    buys = None
    if range_key in INTRADAY_RANGES:
        if split is not None:
            stats.append(
                _stat(
                    "inside_hours",
                    Decimal(split["inside"]),
                    "money",
                    currency=ccy,
                    kind=kind_of(Decimal(split["inside"])),
                )
            )
            stats.append(
                _stat(
                    "outside_hours",
                    Decimal(split["outside"]),
                    "money",
                    currency=ccy,
                    kind=kind_of(Decimal(split["outside"])),
                )
            )
        rng = _today_rate_range(session, now)
        if rng is not None:
            stats.append(
                _stat(
                    "rate_range_today", rng[0], "rate", secondary=dec(rng[1]), secondary_unit="rate"
                )
            )
        buys = _buys(session, today_block, now)
        if buys is not None and buys.get("usd_now") is not None:
            stats.append(
                _stat(
                    "buys_now",
                    Decimal(buys["usd_now"]),
                    "money",
                    currency="USD",
                    secondary=buys.get("usd_prev"),
                    secondary_unit="money" if buys.get("usd_prev") else None,
                    secondary_currency="USD" if buys.get("usd_prev") else None,
                )
            )

    explainer = None
    if range_key == "all" and life is not None:
        explainer = ALL_EXPLAINER.format(
            foreign=_plural(foreign_name(life.foreign or ["USD" if ccy == "EUR" else "EUR"]))
        )
    return {
        "ccy": ccy,
        "range": range_key,
        "as_of": payload["as_of"],
        "generated_at": now.isoformat(),
        "start_on": parts[0].prev_on.isoformat() if parts else None,
        "end_on": parts[-1].on.isoformat() if parts else None,
        "granularity": granularity,
        "headline": headline,
        "series": series,
        "bridge": _bridge(parts),
        "months": bars(months),
        "years": bars(fa.year_totals(parts)),
        "grid": month_grid(months),
        "rolling": rolling,
        "rolling_window_days": ROLLING_WINDOW,
        "run": run,
        "records": records,
        "holdings": holdings,
        "session_split": split,
        "buys": buys,
        "stats": stats,
        "explainer": explainer,
    }


def _plural(name: str) -> str:
    return name if name.endswith("s") else f"{name}s"


def _safe_lifetime(session: Session, ccy: str) -> Lifetime | None:
    try:
        life: Lifetime | None = lifetime(session=session, reporting=ccy)
        return life
    except ValueError:  # a held currency without a rate on file: no attribution
        return None


def build_effect_both(
    session: Session,
    range_key: str,
    overview: dict[str, dict[str, Any]],
    *,
    now: datetime | None = None,
) -> dict[str, dict[str, Any]]:
    """``{"EUR": ..., "USD": ...}`` Impact payloads for ``range_key``."""
    now = now or datetime.now(UTC)
    today = exchange_today(now)
    lives = {c: _safe_lifetime(session, c) for c in ("EUR", "USD")}
    after, through = range_window(range_key, today)
    parts_by_ccy: dict[str, list[fa.DayParts]] = {}
    for c, life in lives.items():
        if life is not None:
            parts_by_ccy[c] = [life.parts[i] for i in life.window(after, through)]
    returns = headline_returns(session, range_key, today, parts_by_ccy, overview)
    recorded = fx_session_rates_service.session_rates(session)
    first = min(recorded) if recorded else None
    return {
        ccy: _one_side(
            session,
            ccy,
            range_key,
            today=today,
            now=now,
            lives=lives,
            returns=returns,
            payload=overview[ccy],
            recorded=recorded,
            first=first,
        )
        for ccy in ("EUR", "USD")
    }


# -- the strip (``/currency/both``) ----------------------------------------------------------------


@dataclass(frozen=True)
class StripFigures:
    effect_year: Decimal | None
    effect_year_pp: Decimal | None
    effect_lifetime: Decimal | None


def strip_figures(session: Session, ccy: str, *, today: date | None = None) -> StripFigures:
    """This year's and the lifetime day-by-day currency effect for the strip tiles."""
    today = today or exchange_today()
    life = _safe_lifetime(session, ccy)
    if life is None or not life.parts:
        return StripFigures(None, None, None)
    after, through = range_window("ytd", today)
    ytd = [life.parts[i] for i in life.window(after, through)]
    year = fa.bridge(ytd).currency if ytd else ZERO
    growth_eur = _periods_return(session, "EUR", "ytd", today)
    growth_usd = _periods_return(session, "USD", "ytd", today)
    pp = growth_eur - growth_usd if growth_eur is not None and growth_usd is not None else None
    return StripFigures(year, pp, fa.bridge(life.parts).currency)


@cached_read
def dollar_trend(session: Session) -> dict[str, Any] | None:
    """The dollar's regime on the settled daily history (``domain/fx_trend``)."""
    daily = sorted(rows_rm.settled_rates(session, "USD").items())
    reg = fx_trend.regime(daily)
    move = fx_trend.move_normality(daily)
    if reg is None or move is None:
        return None
    return {
        "direction": reg.direction,
        "since": reg.since.isoformat(),
        "since_change_pct": reg.since_change_pct,
        "normal": move.label,
    }


__all__ = [
    "ALL_EXPLAINER",
    "FIXED_RANGES",
    "Lifetime",
    "StripFigures",
    "build_effect_both",
    "build_lifetime",
    "chained_return",
    "dollar_trend",
    "range_window",
    "strip_figures",
]
