"""Holding-values repository: the cache-tier ``holding_daily_values`` table."""

from __future__ import annotations

from collections.abc import Collection, Iterable
from datetime import date
from decimal import Decimal

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from investment_dashboard.models import HoldingDailyValue

#: ``(date, instrument_id, account_id, quantity, close, value, currency, net_flow, dividends)``
Row = tuple[date, int, int, Decimal, Decimal, Decimal, str, Decimal, Decimal]


def list_in_range(
    session: Session,
    start: date,
    end: date,
    instrument_ids: Collection[int] | None = None,
) -> list[HoldingDailyValue]:
    stmt = (
        select(HoldingDailyValue)
        .where(HoldingDailyValue.date >= start)
        .where(HoldingDailyValue.date <= end)
        .order_by(
            HoldingDailyValue.date, HoldingDailyValue.instrument_id, HoldingDailyValue.account_id
        )
    )
    if instrument_ids is not None:
        stmt = stmt.where(HoldingDailyValue.instrument_id.in_(list(instrument_ids)))
    return list(session.scalars(stmt).all())


def last_dates(session: Session) -> dict[int, date]:
    """Newest stored date per instrument."""
    stmt = select(HoldingDailyValue.instrument_id, func.max(HoldingDailyValue.date)).group_by(
        HoldingDailyValue.instrument_id
    )
    return {int(iid): d for iid, d in session.execute(stmt).all() if d is not None}


def upsert_rows(session: Session, rows: Iterable[Row]) -> int:
    written = 0
    for d, iid, aid, qty, close, value, ccy, flow, divs in rows:
        stmt = sqlite_insert(HoldingDailyValue).values(
            date=d,
            instrument_id=iid,
            account_id=aid,
            quantity=qty,
            close_price_native=close,
            value_native=value,
            currency=ccy,
            net_flow_native=flow,
            dividends_native=divs,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=[
                HoldingDailyValue.date,
                HoldingDailyValue.instrument_id,
                HoldingDailyValue.account_id,
            ],
            set_={
                "quantity": stmt.excluded.quantity,
                "close_price_native": stmt.excluded.close_price_native,
                "value_native": stmt.excluded.value_native,
                "currency": stmt.excluded.currency,
                "net_flow_native": stmt.excluded.net_flow_native,
                "dividends_native": stmt.excluded.dividends_native,
                "computed_at": func.current_timestamp(),
            },
        )
        session.execute(stmt)
        written += 1
    return written


def delete_from(session: Session, start: date, instrument_id: int | None = None) -> int:
    """Delete rows dated ``start`` or later (one instrument, or every instrument)."""
    stmt = delete(HoldingDailyValue).where(HoldingDailyValue.date >= start)
    if instrument_id is not None:
        stmt = stmt.where(HoldingDailyValue.instrument_id == instrument_id)
    result = session.execute(stmt)
    return int(result.rowcount or 0)
