"""The holding "peek": what an expanded Holdings row shows that the row itself cannot.

Fetched only when a row is opened. It reuses the deep-dive read models (the 1W value
line and its server-computed period return, the tranche view) and adds the last trade
and the last dividend. No figure here is new money maths.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.domain import kinds
from investment_dashboard.errors import ValidationError
from investment_dashboard.readmodels import holding_detail
from investment_dashboard.readmodels import tranches as tranches_readmodel
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.repositories import instruments_repo, transactions_repo

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
    }


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


def _tranches(session: Session, instrument_id: int) -> dict[str, Any]:
    view = tranches_readmodel.build(session, instrument_id) or {"rows": []}
    rows = view["rows"]
    upcoming = sorted(
        (r for r in rows if r.get("days_to_long_term") is not None),
        key=lambda r: r["days_to_long_term"],
    )
    nxt = upcoming[0] if upcoming else None
    return {
        "open_count": len(rows),
        "next_long_term_on": nxt["long_term_on"] if nxt else None,
        "next_long_term_days": nxt["days_to_long_term"] if nxt else None,
    }


def _last_activity(session: Session, instrument_id: int) -> dict[str, Any]:
    txns = list(transactions_repo.list_transactions(session, instrument_id=instrument_id))
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
