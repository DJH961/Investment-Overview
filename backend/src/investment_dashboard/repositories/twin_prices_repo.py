"""Twin-price repository: the cache-tier ``intraday_twin_prices`` table.

Intraday prices (and the previous session close) of the ETF twins that estimate
mutual funds on the 1D graph. Append/overwrite per ``(symbol, captured_at)``;
pruned to the rolling 1W window.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import datetime
from decimal import Decimal

from sqlalchemy import delete, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from investment_dashboard.models import IntradayTwinPrice


def upsert_prices(session: Session, symbol: str, prices: Mapping[datetime, Decimal]) -> int:
    """Store ``{captured_at: price}`` for ``symbol`` (overwrites the same instant)."""
    written = 0
    for at, price in prices.items():
        stmt = sqlite_insert(IntradayTwinPrice).values(
            symbol=symbol, captured_at=at, price_native=price
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=[IntradayTwinPrice.symbol, IntradayTwinPrice.captured_at],
            set_={"price_native": stmt.excluded.price_native},
        )
        session.execute(stmt)
        written += 1
    return written


def prices_in_range(
    session: Session, symbols: Iterable[str], start: datetime, end: datetime
) -> dict[str, dict[datetime, Decimal]]:
    """``{symbol: {captured_at: price}}`` with ``start <= captured_at <= end``."""
    wanted = sorted(set(symbols))
    if not wanted:
        return {}
    stmt = (
        select(IntradayTwinPrice)
        .where(IntradayTwinPrice.symbol.in_(wanted))
        .where(IntradayTwinPrice.captured_at >= start)
        .where(IntradayTwinPrice.captured_at <= end)
    )
    out: dict[str, dict[datetime, Decimal]] = {s: {} for s in wanted}
    for row in session.scalars(stmt).all():
        out[row.symbol][row.captured_at] = row.price_native
    return out


def delete_before(session: Session, cutoff: datetime) -> int:
    result = session.execute(
        delete(IntradayTwinPrice).where(IntradayTwinPrice.captured_at < cutoff)
    )
    return int(result.rowcount or 0)


def delete_all(session: Session) -> int:
    result = session.execute(delete(IntradayTwinPrice))
    return int(result.rowcount or 0)
