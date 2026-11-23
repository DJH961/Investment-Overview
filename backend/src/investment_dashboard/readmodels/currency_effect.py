"""Currency page Impact read model (v7.2, ``GET /currency/effect/both?range=``).

Everything is built per reporting currency from :mod:`domain.fx_attribution`:

* **Daily parts, lifetime, cached.** One attribution over the whole ledger per
  reporting currency (:func:`lifetime`): rows from
  :func:`readmodels.fx_attribution_rows.build_book_rows` (7.1's per-holding
  values + cash accounts + each brokerage account's idle cash, settled daily rates,
  the cashflow-legs flows; a broker balance below zero is an implied deposit,
  ``book_note``). A range is a slice
  of those daily parts (each part depends only on its own two closes, so slicing
  is exact). Ranges end at the **last stored close (yesterday)**: today's holding
  rows are live, never stored, and today is the 1D range (the Overview's own
  figures).
* **Headline returns** are computed in each currency on its own and subtracted,
  never converted. One method for every range but 1D: the hardened daily
  time-weighted chain over each currency's own lifetime parts
  (:func:`daily_factors`), sliced to the range, so adjacent ranges chain exactly
  into the whole (``1 + All`` is the product of the years). 1D is the Overview's
  own live day growth. No XIRR here: the Overview's money-weighted lifetime return
  can differ, and :data:`RETURNS_TIP` says so.
* **The headline** (``headline.lead``): the money effect when the rate moved the
  side's book at all, else the gap between the euro and the dollar return (the
  USD view of an all-dollar book, where the effect in dollars is zero by
  definition); ``kind`` always follows the lead figure. A side with no currency
  effect in the range sends no month, day or rolling figures (they would all be 0).
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
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, localcontext
from functools import cached_property
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.domain import dividends as dividends_domain
from investment_dashboard.domain import fx_attribution as fa
from investment_dashboard.domain import fx_effect_split, fx_trend
from investment_dashboard.domain.market_hours import exchange_today, is_trading_day
from investment_dashboard.domain.session_fx import fx_buying_power_split
from investment_dashboard.readmodels import currency_deposits as deposits_rm
from investment_dashboard.readmodels import currency_range
from investment_dashboard.readmodels import fx_attribution_rows as rows_rm
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.repositories import instruments_repo, transactions_repo
from investment_dashboard.services import (
    fx_cost_service,
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
FIXED_RANGES: tuple[str, ...] = ("1d", "1w", "1m", "3m", "ytd", "1y", "3y", "5y", "10y", "all")
_MONTHS = {"1m": 1, "3m": 3, "1y": 12, "3y": 36, "5y": 60, "10y": 120}
#: A span's return beyond ``MAX_STEP`` either way is taken as money the book does
#: not see yet (cash waiting in the broker account before a buy, sale proceeds
#: before they are withdrawn), not a market move: the span stays open (see
#: :func:`chained_return`). Merging a genuine big day is harmless: a span without
#: flows telescopes to the same ``end / start - 1``.
MAX_STEP = Decimal("0.1")
#: A span with flows whose book moved by less than half of them has not seen that
#: money yet (a deposit waiting for the buy) and stays open, for up to this many days
#: (then the span closes on the other tests alone, so money that never shows up, like
#: proceeds of an earlier sale withdrawn later, cannot hold the chain forever).
HOLD_DAYS = 10
#: A span's Dietz denominator below this share of its size is too thin to divide by.
MIN_DENOM_SHARE = Decimal("0.1")
#: About 12 months of business days (``fa.ROLLING_WINDOWS[-1]``).
ROLLING_WINDOW = 252
#: Above this many daily points a series is thinned to the last close of each week.
MAX_DAILY_POINTS = 1100
#: "€1,000 buys $X" (plan §5, Today stats).
BUYS_AMOUNT_EUR = Decimal(1000)
_CURRENCY_NAMES = {"USD": "dollar", "EUR": "euro", "GBP": "pound", "CHF": "franc"}

#: When a broker account's cash would have gone below zero (see ``fx_attribution_rows``).
BOOK_NOTE = (
    "On {days} day{s} your broker cash would have gone below zero, so a deposit may be "
    "missing from your ledger. Those amounts count as deposits here, so they never show "
    "up as a gain or a loss."
)
#: The returns' one-sentence tip (also on the page beside the return bars).
RETURNS_TIP = (
    "These returns are time-weighted: each day's growth is chained, so deposits do not "
    "distort them, and they can differ from the Overview's lifetime return, which is "
    "money-weighted."
)
ALL_EXPLAINER = (
    RETURNS_TIP + " The money figure is summed day by day: each day, the {foreign} you held "
    "then were revalued from the previous day's rate to that day's. The Overview card "
    "instead compares today's {foreign} with what they cost at your average buy rate, so "
    "the two differ whenever the rate moved while your holdings grew or shrank."
)
ALL_GAP_EXPLAINER = (
    RETURNS_TIP + " The euro amount is what the "
    "dollar's moves did to your result in euros, summed day by day."
)
#: When the money effect and the gap in points point different ways (lead ``effect``).
MISMATCH_NOTE = (
    "The money figure and the gap in points point different ways here. The money figure "
    "adds up what each day's rate move did to what you held that day. The returns weigh "
    "each stretch of time by how much you had invested then, so large deposits or "
    "withdrawals while the rate moved can tip the gap the other way."
)


def mismatch_note(effect: Decimal, effect_pp: Decimal | None) -> str | None:
    """:data:`MISMATCH_NOTE` when the shown money effect and the shown gap differ in sign.

    Compared as displayed (whole money units, points to one decimal), so a figure
    that prints as zero never triggers it.
    """
    if effect_pp is None:
        return None
    money = effect.quantize(ONE)
    pp = (effect_pp * 100).quantize(Decimal("0.1"))
    if money == 0 or pp == 0 or (money > 0) == (pp > 0):
        return None
    return MISMATCH_NOTE


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


_minus_months = currency_range.minus_months
last_settled_day = currency_range.last_settled_day


def range_window(range_key: str, today: date, first: date | None = None) -> tuple[date, date]:
    """``(after, through)``: a range is the daily parts with ``after < on <= through``.

    The settled part of :func:`currency_range.resolve` (one meaning for the page). 1D
    has no settled days: it is today's live move alone (see :func:`live_part`).
    ``all`` without a known first transaction covers the whole lifetime.
    """
    if range_key == "all" and first is None:
        return date.min, last_settled_day(today)
    w = currency_range.resolve(range_key, today, first)
    return w.after, w.through


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
    #: Days a broker account's cash would have gone below zero (implied deposits).
    shortfalls: list[rows_rm.Shortfall] = field(default_factory=list)

    def shortfall_days(self, after: date, through: date) -> int:
        """Distinct days in ``(after, through]`` with an implied deposit."""
        return len({sf.on for sf in self.shortfalls if after < sf.on <= through})

    def window(self, after: date, through: date) -> list[int]:
        """Indexes into ``parts`` with ``after < on <= through``."""
        ons = [p.on for p in self.parts]
        lo = bisect.bisect_right(ons, after)
        hi = bisect.bisect_right(ons, through)
        return list(range(lo, hi))

    @cached_property
    def factors(self) -> list[Decimal | None]:
        """The hardened daily growth factors over the whole lifetime (:func:`daily_factors`)."""
        return daily_factors(self.parts)

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
    book = rows_rm.build_book_rows(
        session, first - timedelta(days=1), end, reporting, source=source
    )
    return Lifetime(
        reporting.upper(), book.rows, fa.attribute_days(book.rows, reporting), book.shortfalls
    )


@cached_read
def lifetime(session: Session, reporting: str) -> Lifetime | None:
    """:func:`build_lifetime` through yesterday, cached until the data changes."""
    return build_lifetime(session, reporting)


# -- returns ------------------------------------------------------------------------------


def span_return(span: Sequence[fa.DayParts]) -> Decimal | None:
    """Modified Dietz over consecutive day parts, or ``None`` when it cannot be trusted.

    ``(end - start - sum F) / (start + sum w_j F_j)`` with ``w_j = (n - j - 1/2) / n``
    for the flow booked on the ``j``-th of ``n`` days (mid-day, as the one-day
    ``start + F / 2``). ``None`` when the denominator is under
    :data:`MIN_DENOM_SHARE` of the span's size, the return is beyond
    :data:`MAX_STEP` either way, or (for up to :data:`HOLD_DAYS` days) the book moved
    by less than half the span's flows: the book has not seen that money yet.
    """
    n = len(span)
    if n == 0:
        return None
    nd = Decimal(n)
    start, end = span[0].start, span[-1].end
    flows = sum((p.flow for p in span), ZERO)
    weighted = sum(
        (p.flow * (nd - Decimal(j) - Decimal("0.5")) / nd for j, p in enumerate(span)), ZERO
    )
    size = max(abs(start), abs(end), sum((abs(p.flow) for p in span), ZERO))
    if size == 0:
        return ZERO
    if flows != 0 and abs(end - start) * 2 < abs(flows) and n < HOLD_DAYS:
        return None
    denom = start + weighted
    if denom <= size * MIN_DENOM_SHARE:
        return None
    r = (end - start - flows) / denom
    if abs(r) > MAX_STEP:
        return None
    return r


def daily_factors(parts: Sequence[fa.DayParts]) -> list[Decimal | None]:
    """One growth factor per day part (``None`` = the day does not count), hardened.

    Days are linked geometrically, each a one-day Modified Dietz return. The book
    is the holdings plus cash/savings accounts, not idle broker cash, so a deposit
    shows up as a flow days before the buy that brings it into the book, and a sale
    drops the book with no flow until the proceeds are withdrawn or reinvested. Taken
    day by day those read as -200 % / +100 % / -100 % days (or divide by zero) and
    wreck the product. So a day whose return is implausible (:func:`span_return` is
    ``None``) stays open and is merged with the next days into one multi-day Dietz
    span until the money shows up; the span's growth ``1 + r`` is then spread evenly
    (geometrically) over its ``n`` days, ``(1 + r) ** (1 / n)`` each. Empty days (no
    book, no flow) and a span still open at the end (money the book has not seen by
    then) do not count.

    Built once over the lifetime, any window's return is the product of its days'
    factors, so adjacent windows chain exactly into the whole (``1 + All`` is the
    product of the years).
    """
    out: list[Decimal | None] = [None] * len(parts)
    span: list[int] = []
    for i, p in enumerate(parts):
        if not span and p.start == 0 and p.end == 0 and p.flow == 0:
            continue
        span.append(i)
        r = span_return([parts[j] for j in span])
        if r is None:
            continue
        growth = ONE + r
        if len(span) == 1:
            out[i] = growth
        else:
            with localcontext() as ctx:
                ctx.prec = 50
                each = (growth.ln() / Decimal(len(span))).exp()
            for j in span:
                out[j] = each
        span = []
    return out


def chain(factors: Sequence[Decimal | None]) -> Decimal | None:
    """``prod(factors) - 1`` over the days that count; ``None`` when none does."""
    growth = ONE
    counted = False
    for f in factors:
        if f is not None:
            growth *= f
            counted = True
    return growth - ONE if counted else None


def chained_return(parts: Sequence[fa.DayParts]) -> Decimal | None:
    """The time-weighted return over ``parts`` alone (:func:`daily_factors` chained)."""
    return chain(daily_factors(parts))


def window_return(life: Lifetime | None, after: date, through: date) -> Decimal | None:
    """The lifetime's daily factors over ``(after, through]`` chained (one method for all)."""
    if life is None:
        return None
    factors = life.factors
    return chain([factors[i] for i in life.window(after, through)])


def headline_returns(
    range_key: str,
    today: date,
    lives: Mapping[str, Lifetime | None],
    overview: Mapping[str, Mapping[str, Any]],
) -> tuple[Decimal | None, Decimal | None, str]:
    """``(eur_return, usd_return, basis)``, each currency computed on its own.

    Every range but 1D (the Overview's own live day growth) is the same
    time-weighted chain over the lifetime's days (:func:`window_return`).
    """
    if range_key == "1d":
        return (
            _d(overview["EUR"]["kpis"].get("daily_growth_pct")),
            _d(overview["USD"]["kpis"].get("daily_growth_pct")),
            "day",
        )
    after, through = range_window(range_key, today, _first_of(lives))
    eur = window_return(lives.get("EUR"), after, through)
    usd = window_return(lives.get("USD"), after, through)
    if currency_range.resolve(range_key, today, None).live:
        eur_live = live_part(lives.get("EUR"), overview["EUR"])
        usd_live = live_part(lives.get("USD"), overview["USD"])
        if eur_live is not None and usd_live is not None:
            eur = with_today(eur, _d(overview["EUR"]["kpis"].get("daily_growth_pct")))
            usd = with_today(usd, _d(overview["USD"]["kpis"].get("daily_growth_pct")))
    return eur, usd, "daily_chain"


def _first_of(lives: Mapping[str, Lifetime | None]) -> date | None:
    for life in lives.values():
        if life is not None and life.rows:
            return life.rows[0].on + timedelta(days=1)
    return None


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
    # The empty days before the first money arrived would draw a cliff up from zero.
    lead = next((i for i, p in enumerate(points) if p.value != 0 or p.constant_currency != 0), 0)
    points = points[lead:]
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
    *,
    moved: bool = True,
) -> list[dict[str, Any]]:
    """The section's figures. ``moved=False`` (the rate did nothing to this side's
    book in the range): only the returns and the gap, no month or day figures."""
    out: list[dict[str, Any]] = []
    for key in ("eur_return", "usd_return", "effect_pp"):
        value = _d(headline.get(key))
        if value is not None:
            out.append(_stat(key, value, "fraction"))
    effect = _d(headline["effect"]) or ZERO
    out.append(_stat("effect", effect, "money", currency=ccy, kind=kind_of(effect)))
    if not moved:
        return out
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
            # The month count rides along, so the page can say "4 of 12 months".
            out.append(
                _stat(
                    "tailwind_share",
                    share_up,
                    "fraction",
                    secondary=dec(Decimal(len(months))),
                    secondary_unit="count",
                )
            )
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
    if lifetime_months is not None and lifetime_effect is not None and lifetime_effect != 0:
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


def carry_split(
    parts: Sequence[fa.DayParts], costs: Mapping[date, Decimal]
) -> tuple[Decimal, Decimal, Decimal]:
    """``(revaluation, waiting, conversion_cost)`` of ``parts``' currency part (exact).

    ``revaluation`` is the book revalued day by day; the deposits' ``carry`` splits
    into the rate move while the dollars waited (conversion -> deposit) and the
    conversion cost (spread + fees, negative = it cost you). The three add up to the
    bridge's currency part exactly.
    """
    if not parts:
        return ZERO, ZERO, ZERO
    lo, hi = parts[0].prev_on, parts[-1].on
    with fa.exact_context():
        carry = sum((p.carry for p in parts), ZERO)
        reval = sum((p.currency for p in parts), ZERO) - carry
        cost = -sum((c for on, c in costs.items() if lo < on <= hi), ZERO) if carry else ZERO
        waiting = carry - cost
    return reval, waiting, cost


def _bridge(
    parts: Sequence[fa.DayParts], costs: Mapping[date, Decimal] | None = None
) -> dict[str, Any] | None:
    if not parts:
        return None
    b = fa.bridge(parts)
    start, end, flows, currency = _q(b.start), _q(b.end), _q(b.flows), _q(b.currency)
    _reval, waiting, cost = carry_split(parts, costs or {})
    # Each line rounds on its own; the revaluation takes the remainder so the
    # displayed lines always add up to the displayed currency part.
    waiting_q, cost_q = _q(waiting), _q(cost)
    return {
        "start_on": b.start_on.isoformat(),
        "end_on": b.end_on.isoformat(),
        "start": dec(start),
        "deposits": dec(flows),
        "market": dec(end - start - flows - currency),
        "currency": dec(currency),
        "revaluation": dec(currency - waiting_q - cost_q),
        "waiting": dec(waiting_q),
        "conversion_cost": dec(cost_q),
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
        # "0.0 months of deposits" says nothing: only for an effect there is.
        if lifetime_effect:
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


def _as_of(payload: Mapping[str, Any]) -> date | None:
    raw = payload.get("kpis", {}).get("daily_growth_as_of")
    return date.fromisoformat(str(raw)[:10]) if raw else None


def live_part(life: Lifetime | None, payload: Mapping[str, Any]) -> fa.DayParts | None:
    """Today's live move (the Overview's day split) as one more day part.

    ``None`` when the day it describes is already settled (in ``life``) or unknown.
    The same split the strip and the Overview show, so "today" is one figure.
    """
    day = _day_split_effect(payload)
    on = _as_of(payload)
    if day is None or on is None or life is None or not life.parts:
        return None
    last = life.parts[-1]
    if on <= last.on:
        return None
    currency, market = day
    with fa.exact_context():
        end = last.end + market + currency
    return fa.DayParts(
        prev_on=last.on, on=on, start=last.end, end=end, flow=ZERO, market=market, currency=currency
    )


def with_today(ret: Decimal | None, day: Decimal | None) -> Decimal | None:
    """A settled chain extended by today's live growth (``(1 + r)(1 + d) - 1``)."""
    if ret is None:
        return day
    if day is None:
        return ret
    return (ONE + ret) * (ONE + day) - ONE


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
    costs: Mapping[date, Decimal] | None = None,
) -> dict[str, Any]:
    life = lives.get(ccy)
    costs = costs if ccy == "EUR" else None
    window = currency_range.resolve(range_key, today, first_ledger_date(session))
    after, through = range_window(range_key, today, window.first)
    idx = life.window(after, through) if life is not None else []
    parts = [life.parts[i] for i in idx] if life is not None else []
    # One meaning per range: a range that ends now includes today's live move, so the
    # headline, bridge, months and records all describe the same days (7.3.1).
    live = live_part(life, payload) if window.live else None
    if live is not None:
        parts = [*parts, live]
    elif range_key == "1d" and life is not None and life.parts:
        # Nothing moved since the last close (a weekend): 1D is the last session.
        parts = [life.parts[-1]]
    eur_ret, usd_ret, basis = returns
    effect_pp = eur_ret - usd_ret if eur_ret is not None and usd_ret is not None else None

    if parts:
        b = fa.bridge(parts)
        effect, market = b.currency, b.market
    else:
        effect = market = ZERO
    cur = payload["currency"]
    today_block = cur["today"]
    # Did the rate move this side's book at all? (The USD view of an all-dollar book:
    # never.) Then the money figures are all zero and the gap leads instead.
    moved = _q(effect) != 0 or any(p.currency != 0 for p in parts)
    lead = "effect" if moved or effect_pp is None else "gap"
    headline = {
        "eur_return": _f(eur_ret),
        "usd_return": _f(usd_ret),
        "effect_pp": _f(effect_pp),
        "effect": _m(effect),
        "market": _m(market),
        "currency_share": _f(currency_share(market, effect)) if moved else None,
        "kind": kind_of(effect) if lead == "effect" else kind_of(effect_pp or ZERO),
        "lead": lead,
        "return_basis": basis,
        "note": mismatch_note(effect, effect_pp) if lead == "effect" else None,
        # Filled by :func:`build_effect_both` from the other side (lead ``gap`` only).
        "other_effect": None,
        "other_ccy": None,
    }
    # The USD view reads the currency the way you invest: your euros becoming dollars.
    investing = (
        deposits_rm.build_investing(session, after, through, first=first_ledger_date(session))
        if ccy == "USD"
        else None
    )
    if investing is not None:
        headline |= {"lead": "deposits", "kind": investing["kind"], "note": None}

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

    months = fa.month_totals(parts) if moved else []
    lifetime_months_list = fa.month_totals(life.parts) if life is not None else []
    rolling: list[dict[str, Any]] = []
    run = None
    if life is not None and life.parts and moved:
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
    if not moved:  # best and worst of nothing: every day, month and year is 0
        for key in ("best_day", "worst_day", "best_month", "worst_month"):
            records[key] = None
        records["best_year"] = records["worst_year"] = None

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

    stats = effect_stats(
        ccy, headline, parts, months, lifetime_months, lifetime_effect, moved=moved
    )
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

    missing = life.shortfall_days(after, through) if life is not None else 0
    explainer = None
    if range_key == "all" and lead == "gap":
        explainer = ALL_GAP_EXPLAINER if ccy == "USD" else None
    elif range_key == "all" and life is not None:
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
        "bridge": _bridge(parts, costs),
        "months": bars(months),
        "years": bars(fa.year_totals(parts)) if moved else [],
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
        "missing_deposit_days": missing,
        "book_note": BOOK_NOTE.format(days=missing, s="" if missing == 1 else "s")
        if missing
        else None,
        "investing": investing,
        "window": window.to_dict(),
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
    returns = headline_returns(range_key, today, lives, overview)
    recorded = fx_session_rates_service.session_rates(session)
    first = min(recorded) if recorded else None
    costs = fx_cost_service.deposit_costs(session)
    out = {
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
            costs=costs,
        )
        for ccy in ("EUR", "USD")
    }
    link_sides(out)
    return out


def link_sides(sides: Mapping[str, dict[str, Any]]) -> None:
    """A side led by the gap gets the other side's money effect (in that currency).

    The USD view of an all-dollar book: "your result in euros was X pp lower,
    that is EUR Y" with Y the EUR side's own day-by-day effect (never USD / rate).
    """
    for ccy, side in sides.items():
        other_ccy = "USD" if ccy == "EUR" else "EUR"
        other = sides.get(other_ccy)
        head = side["headline"]
        if head["lead"] != "gap" or other is None or other["headline"]["lead"] != "effect":
            continue
        head["other_effect"] = other["headline"]["effect"]
        head["other_ccy"] = other_ccy
        head["note"] = mismatch_note(Decimal(head["other_effect"]), _d(head["effect_pp"]))


# -- the strip (``/currency/both``) ----------------------------------------------------------------


@dataclass(frozen=True)
class StripFigures:
    effect_year: Decimal | None
    effect_year_pp: Decimal | None
    effect_lifetime: Decimal | None
    effect_lifetime_pp: Decimal | None = None


def _gap(lives: Mapping[str, Lifetime | None], after: date, through: date) -> Decimal | None:
    eur = window_return(lives.get("EUR"), after, through)
    usd = window_return(lives.get("USD"), after, through)
    return eur - usd if eur is not None and usd is not None else None


def strip_figures(
    session: Session,
    ccy: str,
    *,
    today: date | None = None,
    overview: Mapping[str, Mapping[str, Any]] | None = None,
) -> StripFigures:
    """This year's and the lifetime currency effect and return gap for the strip tiles.

    Exactly the Impact section's YTD and All (same days, today's live move included
    when ``overview`` is given), so the strip and Impact never show two numbers.
    """
    today = today or exchange_today()
    life = _safe_lifetime(session, ccy)
    if life is None or not life.parts:
        return StripFigures(None, None, None)
    lives = {c: _safe_lifetime(session, c) for c in ("EUR", "USD")}
    first = _first_of(lives)
    live = live_part(life, overview[ccy]) if overview is not None and ccy in overview else None
    after, through = range_window("ytd", today, first)
    ytd = [life.parts[i] for i in life.window(after, through)] + ([live] if live else [])
    year = fa.bridge(ytd).currency if ytd else ZERO
    every = [*life.parts, live] if live else life.parts
    if overview is not None and "EUR" in overview and "USD" in overview:
        e, u, _ = headline_returns("ytd", today, lives, overview)
        pp = e - u if e is not None and u is not None else None
        e, u, _ = headline_returns("all", today, lives, overview)
        life_pp = e - u if e is not None and u is not None else None
    else:
        pp = _gap(lives, after, through)
        life_pp = _gap(lives, *range_window("all", today, first))
    return StripFigures(year, pp, fa.bridge(every).currency, life_pp)


@cached_read
def dollar_trend(session: Session, of: fx_trend.Asset = "dollar") -> dict[str, Any] | None:
    """The dollar's (or, ``of="euro"``, the euro's) regime on the settled daily history
    (``domain/fx_trend``; the euro's on the EUR/USD rate itself)."""
    daily = sorted(rows_rm.settled_rates(session, "USD").items())
    reg = fx_trend.regime(daily, of=of)
    move = fx_trend.move_normality(daily, of=of)
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
    "RETURNS_TIP",
    "Lifetime",
    "StripFigures",
    "build_effect_both",
    "build_lifetime",
    "chained_return",
    "daily_factors",
    "dollar_trend",
    "link_sides",
    "mismatch_note",
    "range_window",
    "span_return",
    "strip_figures",
    "window_return",
]
