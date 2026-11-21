"""Daily value of each holding (instrument x account), native currency, cached.

The cache-tier ``holding_daily_values`` table holds one row per
``(date, instrument, account)`` held at a trading day's close (plus any date the
holding traded or paid a dividend, so a full sale keeps its flow). Rows are built
lazily on read, like :class:`PositionSnapshot`: a read first extends every
requested instrument's rows up to the last settled day (yesterday), walking the
ledger once in memory. Today is never stored; its rows are valued live from
:func:`positions_service.compute_positions`.

Valuation equals ``positions_service`` exactly: the same average-cost ledger walk
(share counts), the forward-filled close on or before the day, money-market funds
at par, and the same split back-adjustment (the feed's cumulative split factor
after the day when the feed has split data for the instrument, else the ledger
``split`` rows). So per date and currency the rows sum to the native book of
``metrics_service._book_holdings`` / ``PositionSnapshot`` (tested).

💱 Native only (currency rule): EUR / USD are derived by readers at report time
(values at the day's rate, flows at their own date's rate).

Invalidation: a transaction add / edit / delete / import / import undo drops that
instrument's rows from the trade date (:func:`invalidate_instrument_from`); a
price, FX or split change drops every instrument's rows from its date
(:func:`invalidate_from`, called beside the portfolio snapshot invalidation).
"""

from __future__ import annotations

from bisect import bisect_right
from collections.abc import Collection, Iterable, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy.orm import Session

from investment_dashboard.domain import dividends, kinds
from investment_dashboard.domain.market_hours import exchange_today, is_trading_day
from investment_dashboard.domain.money_market import MONEY_MARKET_NAV, is_money_market
from investment_dashboard.repositories import (
    accounts_repo,
    holding_values_repo,
    instrument_overrides_repo,
    instruments_repo,
    splits_repo,
    transactions_repo,
)

if TYPE_CHECKING:
    from investment_dashboard.models import Transaction

ZERO = Decimal(0)
ONE = Decimal(1)
#: Below this a holding counts as closed (``positions_service._MIN_HELD_SHARES``).
_MIN_HELD_SHARES = Decimal("0.0000001")


@dataclass(frozen=True)
class HoldingDayValue:
    date: date
    instrument_id: int
    account_id: int
    quantity: Decimal
    close_price_native: Decimal
    value_native: Decimal
    currency: str
    net_flow_native: Decimal
    dividends_native: Decimal


@dataclass(frozen=True)
class HoldingDayDividend:
    date: date
    instrument_id: int
    account_id: int
    amount_native: Decimal
    currency: str


# -- reads ---------------------------------------------------------------------------


def holding_values(
    session: Session,
    start: date,
    end: date,
    instrument_ids: Collection[int] | None = None,
) -> list[HoldingDayValue]:
    """Rows with ``start <= date <= end``, sorted by date, instrument, account.

    Extends the stored rows up to yesterday first (lazy rebuild); a range that
    reaches today adds today's live rows (never stored).
    """
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    if end < start:
        return []
    today = exchange_today()
    ids = None if instrument_ids is None else sorted(set(instrument_ids))
    if ids is not None and not ids:
        return []
    stored_end = min(end, today - timedelta(days=1))
    out: list[HoldingDayValue] = []
    if start <= stored_end:
        _ensure_built(session, through=today - timedelta(days=1), instrument_ids=ids)
        with cache_read_session(session) as cache:
            rows = holding_values_repo.list_in_range(cache, start, stored_end, ids)
        out = [
            HoldingDayValue(
                date=r.date,
                instrument_id=r.instrument_id,
                account_id=r.account_id,
                quantity=r.quantity,
                close_price_native=r.close_price_native,
                value_native=r.value_native,
                currency=r.currency,
                net_flow_native=r.net_flow_native,
                dividends_native=r.dividends_native,
            )
            for r in rows
        ]
    if start <= today <= end:
        out.extend(_live_rows(session, today, ids))
    return out


def holding_dividends(
    session: Session,
    start: date,
    end: date,
    instrument_ids: Collection[int] | None = None,
) -> list[HoldingDayDividend]:
    """Each dividend (cash or reinvested, a reinvested pair counted once), native.

    Read straight from the ledger (one row per dividend transaction), so two
    payments on the same day stay two rows; the amounts per day equal the
    ``dividends_native`` of :func:`holding_values`.
    """
    if end < start:
        return []
    wanted = None if instrument_ids is None else set(instrument_ids)
    txns = transactions_repo.list_transactions(session)
    keys = dividends.reinvest_keys(list(txns))
    currencies = _account_currencies(session)
    out: list[HoldingDayDividend] = []
    for t in txns:
        if t.instrument_id is None or not (start <= t.date <= end):
            continue
        if wanted is not None and t.instrument_id not in wanted:
            continue
        amount = _dividend_native(t, keys)
        if not amount:
            continue
        out.append(
            HoldingDayDividend(
                date=t.date,
                instrument_id=t.instrument_id,
                account_id=t.account_id,
                amount_native=amount,
                currency=currencies.get(t.account_id, "EUR"),
            )
        )
    return out


# -- invalidation ----------------------------------------------------------------------


def invalidate_instrument_from(session: Session, instrument_id: int, from_date: date) -> None:
    """Drop ``instrument_id``'s rows dated ``from_date`` or later (rebuilt on next read)."""
    from investment_dashboard.db import cache_write_session  # noqa: PLC0415

    with cache_write_session(session) as cache:
        holding_values_repo.delete_from(cache, from_date, instrument_id)


def invalidate_instruments_for_trades(
    session: Session, trades: Iterable[tuple[int | None, date]]
) -> None:
    """:func:`invalidate_instrument_from` for each instrument at its earliest trade date."""
    earliest: dict[int, date] = {}
    for iid, on in trades:
        if iid is None:
            continue
        if iid not in earliest or on < earliest[iid]:
            earliest[iid] = on
    for iid, on in earliest.items():
        invalidate_instrument_from(session, iid, on)


def invalidate_from(session: Session, from_date: date) -> None:
    """Drop every instrument's rows from ``from_date`` on (a price / FX / split change)."""
    from investment_dashboard.db import cache_write_session  # noqa: PLC0415

    with cache_write_session(session) as cache:
        holding_values_repo.delete_from(cache, from_date)


# -- build -------------------------------------------------------------------------------


@dataclass
class _Ctx:
    currencies: dict[int, str]
    money_market: set[int]
    reinvest_keys: set[tuple[int, int | None, date]]


def _account_currencies(session: Session) -> dict[int, str]:
    return {a.id: a.native_currency.upper() for a in accounts_repo.list_accounts(session)}


def _money_market_ids(session: Session) -> set[int]:
    from investment_dashboard.services.instrument_enrichment_service import (  # noqa: PLC0415
        effective_instrument,
    )

    instruments = {i.id: i for i in instruments_repo.list_instruments(session)}
    overrides = instrument_overrides_repo.get_override_map(session, instruments.keys())
    out: set[int] = set()
    for iid, instr in instruments.items():
        eff = effective_instrument(instr, overrides.get(iid))
        if is_money_market(instr.symbol, asset_class=eff.asset_class, name=eff.name):
            out.add(iid)
    return out


def _dividend_native(t: Transaction, keys: set[tuple[int, int | None, date]]) -> Decimal:
    if t.kind not in kinds.DIVIDEND_KINDS:
        return ZERO
    amount = dividends.income_value_native(t, keys)
    return amount if amount is not None else ZERO


def _flow_native(t: Transaction) -> Decimal:
    """Money into the holding (buys) minus money out (sells), net of fees."""
    if t.kind in (kinds.BUY, kinds.SELL):
        return -(t.net_native or ZERO)
    return ZERO


def _ensure_built(session: Session, *, through: date, instrument_ids: Sequence[int] | None) -> None:
    """Extend each instrument's stored rows (a suffix is all invalidation drops) to ``through``."""
    from investment_dashboard.db import cache_read_session, cache_write_session  # noqa: PLC0415

    txns = transactions_repo.list_transactions(session)
    by_instrument: dict[int, list[Transaction]] = {}
    for t in txns:
        if t.instrument_id is not None:
            by_instrument.setdefault(t.instrument_id, []).append(t)
    wanted = sorted(by_instrument) if instrument_ids is None else instrument_ids
    with cache_read_session(session) as cache:
        stored = holding_values_repo.last_dates(cache)
    todo = [
        iid
        for iid in wanted
        if iid in by_instrument
        and by_instrument[iid][0].date <= through
        and not _complete(by_instrument[iid], stored.get(iid), through)
    ]
    if not todo:
        return
    ctx = _Ctx(
        currencies=_account_currencies(session),
        money_market=_money_market_ids(session),
        reinvest_keys=dividends.reinvest_keys(list(txns)),
    )
    rows: list[holding_values_repo.Row] = []
    for iid in todo:
        after = stored.get(iid)
        first = after + timedelta(days=1) if after is not None else date.min
        if first > through:
            continue
        rows.extend(_instrument_rows(session, iid, by_instrument[iid], first, through, ctx))
    if rows:
        with cache_write_session(session) as cache:
            holding_values_repo.upsert_rows(cache, rows)


def _complete(txns: list[Transaction], stored_last: date | None, through: date) -> bool:
    """Whether the stored rows already reach as far as rows are expected.

    Rows are expected up to ``through`` while any account still holds shares, and
    up to the last trade or dividend once every account has closed the holding.
    """
    if stored_last is None:
        return False
    if stored_last >= through:
        return True
    if any(stored_last < t.date <= through for t in txns):
        return False
    last_session = through
    while not is_trading_day(last_session):
        last_session -= timedelta(days=1)
    if stored_last >= last_session:
        return True  # only non-trading days since, and nothing booked on them
    shares: dict[int, Decimal] = {}
    for t in txns:
        if t.kind in kinds.SHARE_MOVING_KINDS:
            shares[t.account_id] = shares.get(t.account_id, ZERO) + (t.quantity or ZERO)
    if any(abs(s) > _MIN_HELD_SHARES for s in shares.values()):
        return False
    return stored_last >= min(txns[-1].date, through)


def _close_lookup(session: Session, instrument_id: int) -> tuple[list[date], list[Decimal]]:
    from investment_dashboard.services import prices_service  # noqa: PLC0415

    closes = prices_service.closes_for_instrument(session, instrument_id)
    days = sorted(closes)
    return days, [closes[d] for d in days]


def _feed_splits(session: Session, instrument_id: int) -> list[tuple[date, Decimal]] | None:
    """The feed's splits for the instrument, or ``None`` when none are cached (ledger fallback)."""
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    with cache_read_session(session) as cache:
        rows = splits_repo.list_splits(cache, instrument_id)
    if not rows:
        return None
    return [(d, r) for d, r, _src in rows]


def _ledger_split_factor(shares: Decimal, future: Sequence[Transaction]) -> Decimal:
    """``positions_service._split_factor_after``: ledger split rows after the day."""
    running = shares
    factor = ONE
    for t in future:
        if t.kind not in kinds.SHARE_MOVING_KINDS:
            continue
        qty = t.quantity or ZERO
        if t.kind == kinds.SPLIT and running > ZERO:
            factor *= (running + qty) / running
        running += qty
    return factor


def _instrument_rows(  # noqa: PLR0912, PLR0915
    session: Session,
    instrument_id: int,
    txns: list[Transaction],
    first: date,
    through: date,
    ctx: _Ctx,
) -> list[holding_values_repo.Row]:
    """Rows for one instrument dated ``first..through`` (walks its ledger from the start)."""
    is_mm = instrument_id in ctx.money_market
    close_days, close_values = ([], []) if is_mm else _close_lookup(session, instrument_id)
    feed_splits = _feed_splits(session, instrument_id)

    by_account: dict[int, list[Transaction]] = {}
    for t in txns:
        by_account.setdefault(t.account_id, []).append(t)
    flows: dict[tuple[date, int], Decimal] = {}
    divs: dict[tuple[date, int], Decimal] = {}
    for t in txns:
        key = (t.date, t.account_id)
        flow = _flow_native(t)
        if flow:
            flows[key] = flows.get(key, ZERO) + flow
        div = _dividend_native(t, ctx.reinvest_keys)
        if div:
            divs[key] = divs.get(key, ZERO) + div
    event_days = {d for d, _a in flows} | {d for d, _a in divs}

    def close_on(day: date) -> Decimal | None:
        if is_mm:
            return MONEY_MARKET_NAV
        idx = bisect_right(close_days, day)
        return close_values[idx - 1] if idx else None

    def feed_factor(day: date) -> Decimal:
        factor = ONE
        for split_day, ratio in feed_splits or ():
            if split_day > day and ratio and ratio > 0:
                factor *= ratio
        return factor

    start = max(first, txns[0].date)
    out: list[holding_values_repo.Row] = []
    for account_id, acct_txns in sorted(by_account.items()):
        ccy = ctx.currencies.get(account_id, "EUR")
        shares = ZERO
        idx = 0
        n = len(acct_txns)
        ledger_factor_cache: dict[int, Decimal] = {}
        day = start
        # Fast-forward the walk to the first emitted day.
        while idx < n and acct_txns[idx].date < day:
            if acct_txns[idx].kind in kinds.SHARE_MOVING_KINDS:
                shares += acct_txns[idx].quantity or ZERO
            idx += 1
        while day <= through:
            while idx < n and acct_txns[idx].date <= day:
                if acct_txns[idx].kind in kinds.SHARE_MOVING_KINDS:
                    shares += acct_txns[idx].quantity or ZERO
                idx += 1
            flow = flows.get((day, account_id), ZERO)
            div = divs.get((day, account_id), ZERO)
            held = abs(shares) > _MIN_HELD_SHARES
            if not held and idx >= n and not flow and not div:
                break  # closed for good: nothing more to emit for this account
            if (held and is_trading_day(day)) or flow or div:
                price = close_on(day)
                if price is not None or flow or div:
                    value = ZERO
                    if price is not None and shares:
                        if feed_splits is not None:
                            factor = feed_factor(day)
                        else:
                            if idx not in ledger_factor_cache:
                                ledger_factor_cache[idx] = _ledger_split_factor(
                                    shares, acct_txns[idx:]
                                )
                            factor = ledger_factor_cache[idx]
                        value = shares * factor * price
                    out.append(
                        (
                            day,
                            instrument_id,
                            account_id,
                            shares,
                            price if price is not None else ZERO,
                            value,
                            ccy,
                            flow,
                            div,
                        )
                    )
            day += timedelta(days=1)
            if not held and idx < n and day < acct_txns[idx].date and day not in event_days:
                day = acct_txns[idx].date  # skip the stretch the account held none
    out.sort(key=lambda r: (r[0], r[2]))
    return out


def _live_rows(session: Session, today: date, ids: Sequence[int] | None) -> list[HoldingDayValue]:
    """Today's rows, valued live like the holdings page (never stored)."""
    from investment_dashboard.services import positions_service  # noqa: PLC0415

    wanted = None if ids is None else set(ids)
    todays = [t for t in transactions_repo.list_transactions(session, start=today, end=today)]
    keys = dividends.reinvest_keys(list(transactions_repo.list_transactions(session)))
    flows: dict[tuple[int, int], Decimal] = {}
    divs: dict[tuple[int, int], Decimal] = {}
    for t in todays:
        if t.instrument_id is None:
            continue
        key = (t.instrument_id, t.account_id)
        flows[key] = flows.get(key, ZERO) + _flow_native(t)
        divs[key] = divs.get(key, ZERO) + _dividend_native(t, keys)
    out: list[HoldingDayValue] = []
    seen: set[tuple[int, int]] = set()
    trading = is_trading_day(today)
    for p in positions_service.compute_positions(session, as_of=today):
        key = (p.instrument.id, p.account.id)
        if wanted is not None and key[0] not in wanted:
            continue
        flow, div = flows.get(key, ZERO), divs.get(key, ZERO)
        held = abs(p.shares) > _MIN_HELD_SHARES
        if not ((held and trading and p.current_price_native is not None) or flow or div):
            continue
        seen.add(key)
        out.append(
            HoldingDayValue(
                date=today,
                instrument_id=key[0],
                account_id=key[1],
                quantity=p.shares,
                close_price_native=p.current_price_native or ZERO,
                value_native=p.current_value_native,
                currency=p.account.native_currency.upper(),
                net_flow_native=flow,
                dividends_native=div,
            )
        )
    currencies = _account_currencies(session)
    for (iid, aid), flow in flows.items():
        if (iid, aid) in seen or (wanted is not None and iid not in wanted):
            continue
        div = divs.get((iid, aid), ZERO)
        if not flow and not div:
            continue
        out.append(
            HoldingDayValue(
                date=today,
                instrument_id=iid,
                account_id=aid,
                quantity=ZERO,
                close_price_native=ZERO,
                value_native=ZERO,
                currency=currencies.get(aid, "EUR"),
                net_flow_native=flow,
                dividends_native=div,
            )
        )
    out.sort(key=lambda r: (r.instrument_id, r.account_id))
    return out
