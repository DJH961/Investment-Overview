"""Holding deep-dive read models (7.1): one holding's history and its ETF-twin view.

💱 CURRENCY (rule in ``AGENTS.md``): prices and values stay native until reporting.
A value is converted at its own instant's rate (the per-sample EUR/USD stored with
each intraday portfolio sample, or the day's rate for a daily point); a flow at its
own date's rate. The period return is Modified Dietz computed separately in EUR
and in USD, each from its own currency's value and flow stream; a return is never
converted. USD-booked holdings and flows are native dollars, never derived from EUR.

Reads cache-tier data only through services (``holding_values_service``,
``symbol_prices_service``, ``prices_service``, ``fx_service``,
``intraday_snapshots_service``). No network: a holding with no stored intraday
prices simply has no 1D/1W points.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Sequence
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from itertools import pairwise
from typing import TYPE_CHECKING, Any

from sqlalchemy.orm import Session

from investment_dashboard.domain import dividends, kinds, market_hours
from investment_dashboard.domain.currency import lookup_rate_with_forward_fill
from investment_dashboard.domain.instruments import NAV_ASSET_CLASSES, SYNTHETIC_ASSET_CLASSES
from investment_dashboard.domain.returns import Cashflow, modified_dietz
from investment_dashboard.errors import ValidationError
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.repositories import (
    instrument_overrides_repo,
    instruments_repo,
    transactions_repo,
)
from investment_dashboard.services import (
    cashflows,
    fx_service,
    holding_values_service,
    intraday_snapshots_service,
    positions_service,
    prices_service,
    symbol_prices_service,
)
from investment_dashboard.services.instrument_enrichment_service import (
    EffectiveInstrument,
    effective_instrument,
)

if TYPE_CHECKING:
    from investment_dashboard.models import Instrument, Transaction

ZERO = Decimal(0)
HUNDRED = Decimal(100)
INTRADAY_RANGES = frozenset({"1d", "1w"})
#: Upper bound on daily closes read for one chart (about 24 years of trading days).
_HISTORY_MAX_POINTS = 6000
#: |bias| below this many percentage points reads as "no lean" (as the holdings row).
_BIAS_NONE_PP = Decimal("0.005")
#: Sessions in the twin panel's "recent" table.
_RECENT_SESSIONS = 5
_TWIN_REASONS = {"same_index": "same_index", "close": "close_index", "manual": "manual"}


# -- small helpers ----------------------------------------------------------------------


def _utc_iso(at: datetime) -> str:
    return (at if at.tzinfo is not None else at.replace(tzinfo=UTC)).isoformat()


def _naive_utc(at: datetime) -> datetime:
    return at.astimezone(UTC).replace(tzinfo=None) if at.tzinfo is not None else at


def _session_open(day: date) -> datetime:
    return _naive_utc(market_hours.regular_session_open(day))


def _session_close(day: date) -> datetime:
    return _naive_utc(market_hours.regular_session_close(day))


def _sessions_payload(days: Sequence[date]) -> list[dict[str, str]]:
    return [
        {
            "date": d.isoformat(),
            "open": _utc_iso(market_hours.regular_session_open(d)),
            "close": _utc_iso(market_hours.regular_session_close(d)),
        }
        for d in days
    ]


def _window_sessions(range_key: str, now: datetime) -> list[date]:
    if range_key == "1d":
        return [intraday_snapshots_service.last_session_date(now)]
    return intraday_snapshots_service.recent_trading_sessions(now)


def history_start(range_key: str, today: date) -> date | None:
    """First day of a daily range (``None``: all history)."""
    if range_key == "all":
        return None
    if range_key == "ytd":
        return date(today.year, 1, 1)
    days = {"1m": 31, "3m": 92, "6m": 183, "1y": 366}[range_key]
    return today - timedelta(days=days)


def _effective(session: Session, instrument: Instrument) -> EffectiveInstrument:
    overrides = instrument_overrides_repo.get_override_map(session, [instrument.id])
    return effective_instrument(instrument, overrides.get(instrument.id))


def is_nav_fund(session: Session, instrument: Instrument) -> bool:
    """No intraday price: a mutual fund (daily NAV) or a cash / savings line."""
    asset_class = _effective(session, instrument).asset_class or instrument.asset_class
    return asset_class in NAV_ASSET_CLASSES or asset_class in SYNTHETIC_ASSET_CLASSES


class _Fx:
    """EUR -> currency rates, loaded once per currency, forward-filled per day."""

    def __init__(self, session: Session) -> None:
        self._session = session
        self._series: dict[str, dict[date, Decimal]] = {}

    def series(self, ccy: str) -> dict[date, Decimal]:
        if ccy not in self._series:
            self._series[ccy] = fx_service.get_rates(self._session, base="EUR", quote=ccy)
        return self._series[ccy]

    def rate(self, ccy: str, day: date) -> Decimal | None:
        if ccy == "EUR":
            return Decimal(1)
        rate = lookup_rate_with_forward_fill(self.series(ccy), day)
        return rate if rate else None

    def to_eur(
        self, amount: Decimal, ccy: str, day: date, usd_rate: Decimal | None = None
    ) -> Decimal | None:
        if ccy == "EUR":
            return amount
        rate = usd_rate if ccy == "USD" and usd_rate else self.rate(ccy, day)
        return amount / rate if rate else None

    def to_usd(
        self, amount: Decimal, ccy: str, day: date, usd_rate: Decimal | None = None
    ) -> Decimal | None:
        if ccy == "USD":
            return amount  # native dollars, never derived from EUR
        eur = self.to_eur(amount, ccy, day)
        rate = usd_rate or self.rate("USD", day)
        return eur * rate if eur is not None and rate else None

    def to_native(self, amount: Decimal, ccy: str, target: str, day: date) -> Decimal | None:
        """A value at one instant in another currency (single-instant conversion)."""
        if ccy == target:
            return amount
        eur = self.to_eur(amount, ccy, day)
        if eur is None:
            return None
        rate = self.rate(target, day)
        return eur * rate if rate else None


def _sum_or_none(values: Iterable[Decimal | None]) -> Decimal | None:
    total = ZERO
    for v in values:
        if v is None:
            return None
        total += v
    return total


# -- the ledger side: trades, flows, dividends ------------------------------------------


class _Ledger:
    """The instrument's transactions and their EUR / USD legs at each one's own date."""

    def __init__(self, session: Session, instrument_id: int) -> None:
        self.txns: list[Transaction] = list(
            transactions_repo.list_transactions(session, instrument_id=instrument_id)
        )
        everything = list(transactions_repo.list_transactions(session))
        self.keys = dividends.reinvest_keys(everything)
        self.eur_to_usd = fx_service.get_rates(session, base="EUR", quote="USD")
        self.overrides = cashflows.eur_overrides_for(session)

    @property
    def first_date(self) -> date | None:
        return self.txns[0].date if self.txns else None

    def trades(self) -> list[Transaction]:
        return [t for t in self.txns if t.kind in (kinds.BUY, kinds.SELL)]

    def eur(self, t: Transaction) -> Decimal | None:
        return cashflows.txn_eur_amount(t, eur_to_usd=self.eur_to_usd, eur_overrides=self.overrides)

    def usd(self, t: Transaction) -> Decimal | None:
        return cashflows.txn_usd_amount(t, eur_to_usd=self.eur_to_usd)

    def is_cash_dividend(self, t: Transaction) -> bool:
        return (
            t.kind == kinds.DIVIDEND_CASH
            and (t.account_id, t.instrument_id, t.date) not in self.keys
        )

    def invested_by_day(self) -> Callable[[date], tuple[Decimal | None, Decimal | None]]:
        """Cumulative buys - sells up to a day, each at its own date's rate."""
        steps: list[tuple[date, Decimal | None, Decimal | None]] = []
        eur: Decimal | None = ZERO
        usd: Decimal | None = ZERO
        for t in self.trades():
            e, u = self.eur(t), self.usd(t)
            eur = eur - e if eur is not None and e is not None else None
            usd = usd - u if usd is not None and u is not None else None
            steps.append((t.date, eur, usd))

        def at(day: date) -> tuple[Decimal | None, Decimal | None]:
            out: tuple[Decimal | None, Decimal | None] = (ZERO, ZERO)
            for d, e, u in steps:
                if d > day:
                    break
                out = (e, u)
            return out

        return at


# -- history ------------------------------------------------------------------------------


def build_history(
    session: Session,
    instrument_id: int,
    *,
    range_key: str,
    mode: str = "price",
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """One holding's chart: native prices (``price`` mode) or its value (``value`` mode).

    ``None`` for an unknown instrument. 1D / 1W of a NAV fund raise
    :class:`ValidationError` (422): a fund has no intraday price.
    """
    instrument = instruments_repo.get_instrument(session, instrument_id)
    if instrument is None:
        return None
    now = now or datetime.now(UTC)
    intraday = range_key in INTRADAY_RANGES
    if intraday and is_nav_fund(session, instrument):
        raise ValidationError("A fund priced once a day (NAV) has no 1D / 1W chart.")
    today = market_hours.exchange_today(now)
    ledger = _Ledger(session, instrument_id)
    fx = _Fx(session)
    days = _window_sessions(range_key, now) if intraday else []
    if intraday:
        points = _intraday_points(session, instrument, days, now, mode, ledger, fx)
        first_day = days[0]
        opening_date = intraday_snapshots_service.previous_trading_session(days[0])
    else:
        points = _daily_points(session, instrument, range_key, today, mode, ledger, fx)
        start = history_start(range_key, today)
        first_day = start if start is not None else (ledger.first_date or today)
        opening_date = (
            start if start is not None else (ledger.first_date or today) - timedelta(days=1)
        )
    trades = [
        {
            "t": _utc_iso(_session_close(t.date)) if intraday else t.date.isoformat(),
            "kind": t.kind,
            "quantity": dec(abs(t.quantity)) if t.quantity is not None else None,
            "price_native": dec(_trade_price(t)),
        }
        for t in ledger.trades()
        if first_day <= t.date <= today
    ]
    return {
        "instrument_id": instrument_id,
        "symbol": instrument.symbol,
        "range": range_key,
        "ccy": instrument.native_currency,
        "mode": mode,
        "x_mode": "time" if intraday else "date",
        "sessions": _sessions_payload(days),
        "points": points,
        "trades": trades,
        "avg_price_native": dec(_avg_price(session, instrument_id, today)),
        "period": _period(session, instrument_id, opening_date, today, ledger, fx),
    }


def _trade_price(t: Transaction) -> Decimal | None:
    if t.price_native is not None:
        return t.price_native
    if t.quantity and t.gross_native is not None:
        return abs(t.gross_native / t.quantity)
    return None


def _avg_price(session: Session, instrument_id: int, today: date) -> Decimal | None:
    """Average cost per share now (the price-mode cost line), native."""
    held = [
        p
        for p in positions_service.compute_positions(session, as_of=today)
        if p.instrument.id == instrument_id and p.shares > 0
    ]
    shares = sum((p.shares for p in held), start=ZERO)
    if shares <= 0:
        return None
    return sum((p.cost_basis_native for p in held), start=ZERO) / shares


def _empty_value_fields() -> dict[str, Any]:
    return {
        "value_native": None,
        "value_eur": None,
        "value_usd": None,
        "invested_eur": None,
        "invested_usd": None,
    }


def _daily_points(
    session: Session,
    instrument: Instrument,
    range_key: str,
    today: date,
    mode: str,
    ledger: _Ledger,
    fx: _Fx,
) -> list[dict[str, Any]]:
    start = history_start(range_key, today)
    if mode != "value":
        pairs = prices_service.recent_closes_by_instrument(
            session, [instrument.id], on_or_before=today, limit=_HISTORY_MAX_POINTS
        ).get(instrument.id, [])
        closes = sorted((d, c) for d, c in pairs if start is None or d >= start)
        return [{"t": d.isoformat(), "v": dec(c), **_empty_value_fields()} for d, c in closes]
    rows = holding_values_service.holding_values(session, start or date.min, today, [instrument.id])
    by_day: dict[date, list[holding_values_service.HoldingDayValue]] = {}
    for r in rows:
        by_day.setdefault(r.date, []).append(r)
    invested = ledger.invested_by_day()
    target = instrument.native_currency.upper()
    points: list[dict[str, Any]] = []
    for day in sorted(by_day):
        day_rows = by_day[day]
        if not any(r.quantity for r in day_rows) and not any(r.value_native for r in day_rows):
            continue  # a sale-only row: nothing held at that close
        price = next((r.close_price_native for r in day_rows if r.close_price_native), None)
        inv_eur, inv_usd = invested(day)
        points.append(
            {
                "t": day.isoformat(),
                "v": dec(price),
                "value_native": dec(
                    _sum_or_none(
                        fx.to_native(r.value_native, r.currency, target, day) for r in day_rows
                    )
                ),
                "value_eur": dec(
                    _sum_or_none(fx.to_eur(r.value_native, r.currency, day) for r in day_rows)
                ),
                "value_usd": dec(
                    _sum_or_none(fx.to_usd(r.value_native, r.currency, day) for r in day_rows)
                ),
                "invested_eur": dec(inv_eur),
                "invested_usd": dec(inv_usd),
            }
        )
    return points


def _intraday_points(
    session: Session,
    instrument: Instrument,
    days: list[date],
    now: datetime,
    mode: str,
    ledger: _Ledger,
    fx: _Fx,
) -> list[dict[str, Any]]:
    """Shares x price per stored instant (the same instants as the portfolio line)."""
    start = _session_open(days[0])
    end = min(_naive_utc(now), _session_close(days[-1]) + timedelta(hours=1))
    prices = [
        p
        for p in symbol_prices_service.prices(
            session, [instrument.symbol], start, end, kind=symbol_prices_service.KIND_HOLDING
        )
    ]
    if mode != "value":
        return [
            {"t": _utc_iso(p.captured_at), "v": dec(p.price_native), **_empty_value_fields()}
            for p in prices
        ]
    rates = intraday_snapshots_service.stored_sample_rates(session, start, end)
    invested = ledger.invested_by_day()
    target = instrument.native_currency.upper()
    # Per session: each account's (currency, value at the reference price, reference
    # price); the value at an instant is value x price_t / reference, exactly the
    # repricing the portfolio sample used, so the holdings sum to the portfolio line.
    legs_by_day: dict[date, list[tuple[str, Decimal, Decimal]]] = {}
    for day in days:
        legs_by_day[day] = [
            (p.account.native_currency.upper(), p.current_value_native, p.current_price_native)
            for p in positions_service.compute_positions(session, as_of=day)
            if p.instrument.id == instrument.id
            and p.shares > 0
            and p.current_price_native
            and p.current_value_native
        ]
    points: list[dict[str, Any]] = []
    for p in prices:
        day = intraday_snapshots_service.session_date_of(p.captured_at)
        legs = legs_by_day.get(day)
        if not legs:
            continue
        usd_rate = rates.get(p.captured_at)
        natives = [(ccy, value * p.price_native / ref) for ccy, value, ref in legs]
        inv_eur, inv_usd = invested(day)
        points.append(
            {
                "t": _utc_iso(p.captured_at),
                "v": dec(p.price_native),
                "value_native": dec(
                    _sum_or_none(fx.to_native(v, ccy, target, day) for ccy, v in natives)
                ),
                "value_eur": dec(
                    _sum_or_none(fx.to_eur(v, ccy, day, usd_rate) for ccy, v in natives)
                ),
                "value_usd": dec(
                    _sum_or_none(fx.to_usd(v, ccy, day, usd_rate) for ccy, v in natives)
                ),
                "invested_eur": dec(inv_eur),
                "invested_usd": dec(inv_usd),
            }
        )
    return points


# -- period figures (server-computed; the client never computes a return) -----------------


def _value_at(
    rows: list[holding_values_service.HoldingDayValue], on: date
) -> list[holding_values_service.HoldingDayValue]:
    """Each account's newest row on or before ``on`` (a full sale leaves a 0 row)."""
    latest: dict[int, holding_values_service.HoldingDayValue] = {}
    for r in rows:
        if r.date <= on:
            latest[r.account_id] = r
    return list(latest.values())


def _period(
    session: Session,
    instrument_id: int,
    opening_date: date,
    closing_date: date,
    ledger: _Ledger,
    fx: _Fx,
) -> dict[str, Any]:
    rows = (
        holding_values_service.holding_values(session, date.min, closing_date, [instrument_id])
        if ledger.txns
        else []
    )
    opening = _value_at(rows, opening_date)
    closing = _value_at(rows, closing_date)
    open_eur = _sum_or_none(fx.to_eur(r.value_native, r.currency, opening_date) for r in opening)
    open_usd = _sum_or_none(fx.to_usd(r.value_native, r.currency, opening_date) for r in opening)
    close_eur = _sum_or_none(fx.to_eur(r.value_native, r.currency, closing_date) for r in closing)
    close_usd = _sum_or_none(fx.to_usd(r.value_native, r.currency, closing_date) for r in closing)

    window = [t for t in ledger.txns if opening_date < t.date <= closing_date]
    flows = [t for t in window if t.kind in (kinds.BUY, kinds.SELL) or ledger.is_cash_dividend(t)]
    eur_flows = [ledger.eur(t) for t in flows]
    usd_flows = [ledger.usd(t) for t in flows]
    trades = [t for t in window if t.kind in (kinds.BUY, kinds.SELL)]
    bought_eur = _sum_or_none(-a if a is not None else None for a in map(ledger.eur, trades))
    bought_usd = _sum_or_none(-a if a is not None else None for a in map(ledger.usd, trades))
    div_eur: Decimal | None = ZERO
    div_usd: Decimal | None = ZERO
    for t in window:
        if t.kind not in kinds.DIVIDEND_KINDS:
            continue
        e, u = dividends.income_dual(t, ledger.keys, eur_to_usd=ledger.eur_to_usd)
        if e is None and u is None:
            continue
        div_eur = div_eur + e if div_eur is not None and e is not None else None
        div_usd = div_usd + u if div_usd is not None and u is not None else None

    def figures(
        open_v: Decimal | None, close_v: Decimal | None, amounts: list[Decimal | None]
    ) -> tuple[Decimal | None, Decimal | None]:
        if open_v is None or close_v is None or any(a is None for a in amounts):
            return None, None
        stream = [Cashflow(t.date, a) for t, a in zip(flows, amounts, strict=True) if a is not None]
        change = close_v - open_v + sum((cf.amount for cf in stream), start=ZERO)
        ret = modified_dietz(
            opening_date=opening_date,
            opening_value=open_v,
            closing_date=closing_date,
            closing_value=close_v,
            flows=stream,
        )
        return change, ret

    change_eur, return_eur = figures(open_eur, close_eur, eur_flows)
    change_usd, return_usd = figures(open_usd, close_usd, usd_flows)
    return {
        "change_eur": dec(change_eur),
        "change_usd": dec(change_usd),
        "return_eur": dec(return_eur),
        "return_usd": dec(return_usd),
        "bought_eur": dec(bought_eur),
        "bought_usd": dec(bought_usd),
        "dividends_eur": dec(div_eur),
        "dividends_usd": dec(div_usd),
    }


# -- the ETF twin -----------------------------------------------------------------------------


TWIN_RANGES = frozenset({"1d", "1w", "1m", "3m", "6m", "ytd", "1y"})


def _pct(a: Decimal, b: Decimal) -> Decimal | None:
    return a / b - 1 if b > 0 else None


def _excluded_dates(session: Session, instrument_id: int) -> set[date]:
    return {
        t.date
        for t in transactions_repo.list_transactions(
            session,
            instrument_id=instrument_id,
            kinds=(kinds.DIVIDEND_CASH, kinds.DIVIDEND_REINVEST),
        )
    }


def build_twin(  # noqa: PLR0912, PLR0915
    session: Session,
    instrument_id: int,
    *,
    range_key: str,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """The fund's ETF twin: its moves, the estimate, the NAVs and the tracking record.

    ``None`` when the instrument is unknown or has no twin (404). The 1D estimate
    ``prev_NAV x twin_now / twin_prev_close`` is rebuilt from stored twin prices at
    read time, never stored.
    """
    instrument = instruments_repo.get_instrument(session, instrument_id)
    if instrument is None:
        return None
    twin_raw = _effective(session, instrument).intraday_twin
    if not twin_raw:
        return None
    twin = twin_raw.upper()
    now = now or datetime.now(UTC)
    today = market_hours.exchange_today(now)
    last_session = intraday_snapshots_service.last_session_date(now)
    intraday = range_key in INTRADAY_RANGES
    days = _window_sessions(range_key, now) if intraday else []
    range_start = (
        intraday_snapshots_service.previous_trading_session(days[0])
        if intraday
        else history_start(range_key, today) or today
    )
    # Twin rows from a little before the range (the previous close) to now.
    read_from = min(range_start, last_session - timedelta(days=30)) - timedelta(days=7)
    rows = {
        p.captured_at: p.price_native
        for p in symbol_prices_service.prices(
            session,
            [twin],
            datetime.combine(read_from, datetime.min.time()),
            _naive_utc(now),
            kind=symbol_prices_service.KIND_TWIN,
        )
    }
    twin_closes = intraday_snapshots_service.twin_session_closes(rows)
    fund_closes = {
        d: v
        for d, v in prices_service.closes_for_instrument(session, instrument_id).items()
        if d <= today
    }

    def close_before(series: dict[date, Decimal], day: date) -> Decimal | None:
        earlier = [d for d in series if d < day]
        return series[max(earlier)] if earlier else None

    twin_points: list[dict[str, Any]] = []
    estimate_points: list[dict[str, Any]] = []
    nav_points: list[dict[str, Any]] = []
    rebased: list[dict[str, Any]] | None = None
    if intraday:
        start = _session_open(days[0])
        end = _session_close(days[-1])
        in_window = sorted((at, px) for at, px in rows.items() if start <= at <= end)
        twin_points = [{"t": _utc_iso(at), "price_native": dec(px)} for at, px in in_window]
        if range_key == "1d":
            prev_nav = close_before(fund_closes, last_session)
            prev_twin = close_before(twin_closes, last_session)
            if prev_nav is not None and prev_twin:
                estimate_points = [
                    {"t": _utc_iso(at), "price_native": dec(prev_nav * px / prev_twin)}
                    for at, px in in_window
                    if intraday_snapshots_service.session_date_of(at) == last_session
                ]
        nav_points = [
            {"t": _utc_iso(_session_close(d)), "nav_native": dec(fund_closes[d])}
            for d in days
            if d in fund_closes
        ]
    else:
        twin_points = [
            {"t": d.isoformat(), "price_native": dec(px)}
            for d, px in sorted(twin_closes.items())
            if range_start <= d <= today
        ]
        nav_points = [
            {"t": d.isoformat(), "nav_native": dec(v)}
            for d, v in sorted(fund_closes.items())
            if range_start <= d <= today
        ]
        shared = sorted(d for d in fund_closes if d in twin_closes and range_start <= d <= today)
        rebased = []
        if shared:
            f0, t0 = fund_closes[shared[0]], twin_closes[shared[0]]
            for d in shared:
                fund_pct = _pct(fund_closes[d], f0)
                twin_pct = _pct(twin_closes[d], t0)
                rebased.append(
                    {
                        "t": d.isoformat(),
                        "fund_pct": dec(fund_pct),
                        "twin_pct": dec(twin_pct),
                        "gap_pp": dec(
                            (twin_pct - fund_pct) * HUNDRED
                            if fund_pct is not None and twin_pct is not None
                            else None
                        ),
                    }
                )

    # Live move of the twin: newest stored price against the previous session close.
    twin_now: dict[str, Any] | None = None
    if rows:
        at = max(rows)
        px = rows[at]
        ref = close_before(twin_closes, intraday_snapshots_service.session_date_of(at))
        twin_now = {
            "price_native": dec(px),
            "day_pct": dec(_pct(px, ref) if ref else None),
            "captured_at": _utc_iso(at),
        }

    fd = intraday_snapshots_service.fund_divergence(
        session, instrument_id=instrument_id, twin_symbol=twin, now=now
    )
    if fd is not None:
        bias_pp = fd.stats.bias * HUNDRED
        label = (
            "none" if abs(bias_pp) < _BIAS_NONE_PP else ("runs_high" if bias_pp > 0 else "runs_low")
        )
        stats = {
            "median_gap_pp": dec(fd.stats.median_abs * HUNDRED),
            "bias_pp": dec(bias_pp),
            "bias_label": label,
            "sessions": fd.stats.sessions,
        }
    else:
        stats = {"median_gap_pp": None, "bias_pp": None, "bias_label": "none", "sessions": 0}

    # The last few sessions' estimate (the twin's move) against the NAV's move, the
    # same session pairs the tracking record uses (dividend days left out).
    excluded = _excluded_dates(session, instrument_id)
    shared_all = sorted(d for d in fund_closes if d in twin_closes and d <= last_session)
    recent: list[dict[str, Any]] = []
    for prev, cur in pairwise(shared_all):
        if cur in excluded:
            continue
        nav_pct = _pct(fund_closes[cur], fund_closes[prev])
        est_pct = _pct(twin_closes[cur], twin_closes[prev])
        if nav_pct is None or est_pct is None:
            continue
        recent.append(
            {
                "session_date": cur.isoformat(),
                "estimate_pct": dec(est_pct),
                "nav_pct": dec(nav_pct),
                "gap_pp": dec((est_pct - nav_pct) * HUNDRED),
            }
        )
    return {
        "instrument_id": instrument_id,
        "symbol": instrument.symbol,
        "twin_symbol": twin,
        "twin_reason": _TWIN_REASONS.get(
            intraday_snapshots_service.twin_tier(instrument.symbol, twin), "manual"
        ),
        "range": range_key,
        "x_mode": "time" if intraday else "date",
        "sessions": _sessions_payload(days),
        "twin_points": twin_points,
        "estimate_points": estimate_points,
        "nav_points": nav_points,
        "rebased": rebased,
        "twin_now": twin_now,
        "stats": stats,
        "recent": recent[-_RECENT_SESSIONS:],
    }
