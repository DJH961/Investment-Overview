"""The holding "peek": what an expanded Holdings row shows that the row itself cannot.

Fetched either per row when opened or in bulk via :func:`build_all` to preload the
Holdings page. It reuses the deep-dive read models (the 1W value line and its
server-computed period return, the tranche view) and adds the last trade and the
last dividend. No figure here is new money maths.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from sqlalchemy.orm import Session

from investment_dashboard.domain import clock, dividends, kinds, market_hours
from investment_dashboard.domain import tranches as tranches_domain
from investment_dashboard.domain.currency import lookup_rate_with_forward_fill
from investment_dashboard.domain.instruments import (
    NAV_ASSET_CLASSES,
    SYNTHETIC_ASSET_CLASSES,
    is_money_market_effective,
)
from investment_dashboard.domain.returns import Cashflow, modified_dietz
from investment_dashboard.errors import ValidationError
from investment_dashboard.readmodels import holding_detail, journey_fields
from investment_dashboard.readmodels import tranches as tranches_readmodel
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
from investment_dashboard.services.instrument_enrichment_service import effective_instrument

if TYPE_CHECKING:
    from investment_dashboard.models import Instrument, InstrumentOverride, Transaction

ZERO = Decimal(0)
_DIVIDEND_KINDS = (kinds.DIVIDEND_CASH, kinds.DIVIDEND_REINVEST)


def build(session: Session, instrument_id: int) -> dict[str, Any] | None:
    """The peek payload, or ``None`` for an unknown instrument."""
    instrument = instruments_repo.get_instrument(session, instrument_id)
    if instrument is None:
        return None
    return {
        "instrument_id": instrument_id,
        "currency": instrument.native_currency,
        "week": _week(session, instrument_id),
        "tranches": _tranches(session, instrument_id),
        **_last_activity(session, instrument_id),
        "your_rate": _your_rate(journey_fields.inputs_for(session), instrument_id),
    }


def _your_rate(inputs: Any, instrument_id: int) -> str | None:
    """7.4 ``your_rate`` (``None`` before the cash pool exists)."""
    return None if inputs is None else journey_fields.peek_your_rate(inputs, instrument_id)


def build_all(session: Session, *, now: datetime | None = None) -> dict[int, dict[str, Any]]:
    """Preload the peek payload for every currently held instrument in one bulk pass."""
    now = now or clock.now()
    today = market_hours.exchange_today(now)
    positions = positions_service.compute_positions(session, as_of=today)
    if not positions:
        return {}

    held_by_iid: dict[int, list[positions_service.Position]] = {}
    instruments: dict[int, Instrument] = {}
    for p in positions:
        iid = p.instrument.id
        held_by_iid.setdefault(iid, []).append(p)
        instruments.setdefault(iid, p.instrument)

    overrides = instrument_overrides_repo.get_override_map(session, instruments.keys())
    all_txns = list(transactions_repo.list_transactions(session))
    txns_by_iid: dict[int, list[Transaction]] = {}
    for t in all_txns:
        if t.instrument_id is not None:
            txns_by_iid.setdefault(t.instrument_id, []).append(t)
    reinvest_keys = dividends.reinvest_keys(all_txns)

    intraday_instruments = [
        instr
        for iid, instr in instruments.items()
        if not _is_nav_instrument(instr, overrides.get(iid))
    ]
    weeks = _build_weeks(
        session,
        intraday_instruments,
        txns_by_iid=txns_by_iid,
        reinvest_keys=reinvest_keys,
        today=today,
        now=now,
    )
    tranches = _build_tranches(
        session,
        held_by_iid=held_by_iid,
        instruments=instruments,
        overrides=overrides,
        txns_by_iid=txns_by_iid,
        today=today,
    )

    journey = journey_fields.inputs_for(session)
    return {
        iid: {
            "instrument_id": iid,
            "your_rate": _your_rate(journey, iid),
            "currency": instr.native_currency,
            "week": weeks.get(iid),
            "tranches": tranches[iid],
            **_last_activity_from_txns(txns_by_iid.get(iid, ())),
        }
        for iid, instr in instruments.items()
    }


def _is_nav_instrument(instrument: Instrument, override: InstrumentOverride | None) -> bool:
    asset_class = effective_instrument(instrument, override).asset_class or instrument.asset_class
    return asset_class in NAV_ASSET_CLASSES or asset_class in SYNTHETIC_ASSET_CLASSES


def _utc_iso(at: datetime) -> str:
    return (at if at.tzinfo is not None else at.replace(tzinfo=UTC)).isoformat()


def _naive_utc(at: datetime) -> datetime:
    return at.astimezone(UTC).replace(tzinfo=None) if at.tzinfo is not None else at


def _sum_or_none(values: Iterable[Decimal | None]) -> Decimal | None:
    total = ZERO
    for v in values:
        if v is None:
            return None
        total += v
    return total


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

    def to_eur(self, amount: Decimal, ccy: str, day: date) -> Decimal | None:
        if ccy == "EUR":
            return amount
        rate = self.rate(ccy, day)
        return amount / rate if rate else None

    def to_usd(self, amount: Decimal, ccy: str, day: date) -> Decimal | None:
        if ccy == "USD":
            return amount  # native dollars, never derived from EUR
        eur = self.to_eur(amount, ccy, day)
        rate = self.rate("USD", day)
        return eur * rate if eur is not None and rate else None

    def to_native(self, amount: Decimal, ccy: str, target: str, day: date) -> Decimal | None:
        if ccy == target:
            return amount
        eur = self.to_eur(amount, ccy, day)
        if eur is None:
            return None
        rate = self.rate(target, day)
        return eur * rate if rate else None


def _value_at(
    rows: Sequence[holding_values_service.HoldingDayValue], on: date
) -> list[holding_values_service.HoldingDayValue]:
    """Each account's newest row on or before ``on`` (a full sale leaves a 0 row)."""
    latest: dict[int, holding_values_service.HoldingDayValue] = {}
    for r in rows:
        if r.date <= on:
            latest[r.account_id] = r
    return list(latest.values())


def _period_return(
    opening_date: date,
    open_v: Decimal | None,
    closing_date: date,
    close_v: Decimal | None,
    flows: Sequence[Transaction],
    amounts: Sequence[Decimal | None],
) -> Decimal | None:
    if open_v is None or close_v is None or any(a is None for a in amounts):
        return None
    stream = [Cashflow(t.date, a) for t, a in zip(flows, amounts, strict=True) if a is not None]
    return modified_dietz(
        opening_date=opening_date,
        opening_value=open_v,
        closing_date=closing_date,
        closing_value=close_v,
        flows=stream,
    )


def _build_weeks(
    session: Session,
    intraday_instruments: Sequence[Instrument],
    *,
    txns_by_iid: dict[int, list[Transaction]],
    reinvest_keys: set[tuple[int, int | None, date]],
    today: date,
    now: datetime,
) -> dict[int, dict[str, Any]]:
    if not intraday_instruments:
        return {}
    days = intraday_snapshots_service.recent_trading_sessions(now)
    start = _naive_utc(market_hours.regular_session_open(days[0]))
    end = min(
        _naive_utc(now),
        _naive_utc(market_hours.regular_session_close(days[-1])) + timedelta(hours=1),
    )
    opening_date = intraday_snapshots_service.previous_trading_session(days[0])

    prices_by_symbol: dict[str, list[symbol_prices_service.SymbolPrice]] = {}
    for sp in symbol_prices_service.prices(
        session,
        [i.symbol for i in intraday_instruments],
        start,
        end,
        kind=symbol_prices_service.KIND_HOLDING,
    ):
        prices_by_symbol.setdefault(sp.symbol, []).append(sp)

    intraday_ids = [i.id for i in intraday_instruments]
    intraday_id_set = set(intraday_ids)
    legs_by_iid_day: dict[int, dict[date, list[tuple[str, Decimal, Decimal]]]] = {}
    for day in days:
        for p in positions_service.compute_positions(session, as_of=day):
            iid = p.instrument.id
            if (
                iid in intraday_id_set
                and p.shares > 0
                and p.current_price_native
                and p.current_value_native
            ):
                legs_by_iid_day.setdefault(iid, {}).setdefault(day, []).append(
                    (
                        p.account.native_currency.upper(),
                        p.current_value_native,
                        p.current_price_native,
                    )
                )

    valued_ids = [iid for iid in intraday_ids if txns_by_iid.get(iid)]
    hv_rows = (
        holding_values_service.holding_values(session, date.min, today, valued_ids)
        if valued_ids
        else []
    )
    hv_by_iid: dict[int, list[holding_values_service.HoldingDayValue]] = {}
    for r in hv_rows:
        hv_by_iid.setdefault(r.instrument_id, []).append(r)

    fx = _Fx(session)
    eur_to_usd = fx.series("USD")
    eur_overrides = cashflows.eur_overrides_for(session)

    out: dict[int, dict[str, Any]] = {}
    for instr in intraday_instruments:
        iid = instr.id
        target = instr.native_currency.upper()
        day_legs = legs_by_iid_day.get(iid, {})
        points: list[dict[str, Any]] = []
        for sp in prices_by_symbol.get(instr.symbol, ()):
            day = intraday_snapshots_service.session_date_of(sp.captured_at)
            legs = day_legs.get(day)
            if not legs:
                continue
            natives = [(ccy, value * sp.price_native / ref) for ccy, value, ref in legs]
            value_native = dec(
                _sum_or_none(fx.to_native(v, ccy, target, day) for ccy, v in natives)
            )
            if value_native is not None:
                points.append({"t": _utc_iso(sp.captured_at), "value_native": value_native})

        rows = hv_by_iid.get(iid, [])
        opening = _value_at(rows, opening_date)
        closing = _value_at(rows, today)
        open_eur = _sum_or_none(
            fx.to_eur(r.value_native, r.currency, opening_date) for r in opening
        )
        open_usd = _sum_or_none(
            fx.to_usd(r.value_native, r.currency, opening_date) for r in opening
        )
        close_eur = _sum_or_none(fx.to_eur(r.value_native, r.currency, today) for r in closing)
        close_usd = _sum_or_none(fx.to_usd(r.value_native, r.currency, today) for r in closing)

        inst_txns = txns_by_iid.get(iid, ())
        window = [t for t in inst_txns if opening_date < t.date <= today]
        flows = [
            t
            for t in window
            if t.kind in (kinds.BUY, kinds.SELL)
            or (
                t.kind == kinds.DIVIDEND_CASH
                and (t.account_id, t.instrument_id, t.date) not in reinvest_keys
            )
        ]
        eur_flows = [
            cashflows.txn_eur_amount(t, eur_to_usd=eur_to_usd, eur_overrides=eur_overrides)
            for t in flows
        ]
        usd_flows = [cashflows.txn_usd_amount(t, eur_to_usd=eur_to_usd) for t in flows]
        out[iid] = {
            "points": points,
            "currency": instr.native_currency,
            "return_eur": dec(
                _period_return(opening_date, open_eur, today, close_eur, flows, eur_flows)
            ),
            "return_usd": dec(
                _period_return(opening_date, open_usd, today, close_usd, flows, usd_flows)
            ),
        }
    return out


def _week(session: Session, instrument_id: int) -> dict[str, Any] | None:
    """The past week's value line; ``None`` for a NAV fund (no intraday price)."""
    try:
        history = holding_detail.build_history(session, instrument_id, range_key="1w", mode="value")
    except ValidationError:
        return None
    if history is None:
        return None
    period = history.get("period") or {}
    return {
        "points": [
            {"t": p["t"], "value_native": p.get("value_native")}
            for p in history["points"]
            if p.get("value_native") is not None
        ],
        "currency": history["ccy"],
        "return_eur": period.get("return_eur"),
        "return_usd": period.get("return_usd"),
    }


def _summarise_tranches(items: Sequence[tuple[str, int | None]]) -> dict[str, Any]:
    upcoming = sorted(
        ((long_term_on, days) for long_term_on, days in items if days is not None),
        key=lambda item: item[1],
    )
    nxt = upcoming[0] if upcoming else None
    return {
        "open_count": len(items),
        "next_long_term_on": nxt[0] if nxt else None,
        "next_long_term_days": nxt[1] if nxt else None,
    }


def _build_tranches(
    session: Session,
    *,
    held_by_iid: dict[int, list[positions_service.Position]],
    instruments: dict[int, Instrument],
    overrides: dict[int, InstrumentOverride],
    txns_by_iid: dict[int, list[Transaction]],
    today: date,
) -> dict[int, dict[str, Any]]:
    missing_price_ids = [
        iid
        for iid, held in held_by_iid.items()
        if next((p.current_price_native for p in held if p.current_price_native), None) is None
    ]
    fallback_closes = (
        prices_service.latest_closes(session, missing_price_ids) if missing_price_ids else {}
    )
    out: dict[int, dict[str, Any]] = {}
    for iid, held in held_by_iid.items():
        instr = instruments[iid]
        money_market = is_money_market_effective(
            instr, effective_instrument(instr, overrides.get(iid))
        )
        tranche_txns = [
            tranches_domain.TrancheTxn(
                id=t.id,
                account_id=t.account_id,
                date=t.date,
                kind=t.kind,
                quantity=t.quantity,
                net_native=t.net_native,
                price_native=t.price_native,
            )
            for t in txns_by_iid.get(iid, ())
            if t.date <= today
        ]
        replayed = tranches_domain.replay(tranche_txns, money_market=money_market)
        position_quantity = sum((p.shares for p in held), start=ZERO)
        price = next((p.current_price_native for p in held if p.current_price_native), None)
        if price is None:
            price = fallback_closes.get(iid)
        view = tranches_domain.build_view(
            replayed, as_of=today, price_native=price, position_quantity=position_quantity
        )
        out[iid] = _summarise_tranches(
            [(r.long_term_on.isoformat(), r.days_to_long_term) for r in view.rows]
        )
    return out


def _tranches(session: Session, instrument_id: int) -> dict[str, Any]:
    view = tranches_readmodel.build(session, instrument_id) or {"rows": []}
    return _summarise_tranches(
        [(r["long_term_on"], r.get("days_to_long_term")) for r in view["rows"]]
    )


def _last_activity(session: Session, instrument_id: int) -> dict[str, Any]:
    txns = transactions_repo.list_transactions(session, instrument_id=instrument_id)
    return _last_activity_from_txns(txns)


def _last_activity_from_txns(txns: Sequence[Transaction]) -> dict[str, Any]:
    trade = next((t for t in reversed(txns) if t.kind in (kinds.BUY, kinds.SELL)), None)
    dividend = next((t for t in reversed(txns) if t.kind in _DIVIDEND_KINDS), None)
    # A reinvested payment is a cash row plus a reinvest row on the same day: report the
    # paid amount (the cash row) and say it was reinvested, with the shares it bought.
    reinvest = (
        next(
            (
                t
                for t in txns
                if t.kind == kinds.DIVIDEND_REINVEST
                and t.date == dividend.date
                and t.account_id == dividend.account_id
            ),
            None,
        )
        if dividend is not None
        else None
    )
    cash = (
        next(
            (
                t
                for t in txns
                if t.kind == kinds.DIVIDEND_CASH
                and t.date == dividend.date
                and t.account_id == dividend.account_id
            ),
            None,
        )
        if dividend is not None
        else None
    )
    if cash is not None:
        amount = cash.net_native
    elif reinvest is not None and reinvest.quantity and reinvest.price_native is not None:
        amount = reinvest.quantity * reinvest.price_native
    else:
        amount = None
    return {
        "last_trade": (
            {
                "date": trade.date.isoformat(),
                "kind": trade.kind,
                "quantity": dec(abs(trade.quantity)) if trade.quantity is not None else None,
                "price_native": dec(trade.price_native),
            }
            if trade is not None
            else None
        ),
        "last_dividend": (
            {
                "date": dividend.date.isoformat(),
                "reinvested": reinvest is not None,
                "amount_native": dec(amount),
                "reinvested_quantity": dec(reinvest.quantity) if reinvest is not None else None,
            }
            if dividend is not None
            else None
        ),
    }
