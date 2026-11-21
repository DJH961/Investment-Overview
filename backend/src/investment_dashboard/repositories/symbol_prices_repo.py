"""Symbol-price repository: the cache-tier ``intraday_symbol_prices`` table.

Intraday prices of single symbols, by ``kind``:

* ``twin``: the ETF twins that estimate mutual funds on the 1D graph, plus their
  session closes (kept 400 days, the twin-divergence statistics read them);
* ``holding``: each held stock/ETF's price at the instants of the portfolio
  samples, pruned to the rolling 1W window like ``intraday_value``.

Append/overwrite per ``(symbol, kind, captured_at)``. Every function defaults to
``kind="twin"`` (the table's original and only use before 7.1).
"""

from __future__ import annotations

from collections.abc import Collection, Iterable, Mapping
from datetime import datetime
from decimal import Decimal

from sqlalchemy import delete, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from investment_dashboard.models import IntradaySymbolPrice
from investment_dashboard.models.intraday_symbol_price import KIND_HOLDING, KIND_TWIN

__all__ = [
    "KIND_HOLDING",
    "KIND_TWIN",
    "delete_all",
    "delete_at",
    "delete_before",
    "delete_in_range",
    "distinct_symbols",
    "prices_in_range",
    "rows_in_range",
    "upsert_prices",
]


def upsert_prices(
    session: Session,
    symbol: str,
    prices: Mapping[datetime, Decimal],
    *,
    kind: str = KIND_TWIN,
) -> int:
    """Store ``{captured_at: price}`` for ``symbol`` (overwrites the same instant)."""
    written = 0
    for at, price in prices.items():
        stmt = sqlite_insert(IntradaySymbolPrice).values(
            symbol=symbol, kind=kind, captured_at=at, price_native=price
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=[
                IntradaySymbolPrice.symbol,
                IntradaySymbolPrice.kind,
                IntradaySymbolPrice.captured_at,
            ],
            set_={"price_native": stmt.excluded.price_native},
        )
        session.execute(stmt)
        written += 1
    return written


def prices_in_range(
    session: Session,
    symbols: Iterable[str],
    start: datetime,
    end: datetime,
    *,
    kind: str = KIND_TWIN,
) -> dict[str, dict[datetime, Decimal]]:
    """``{symbol: {captured_at: price}}`` with ``start <= captured_at <= end``."""
    wanted = sorted(set(symbols))
    if not wanted:
        return {}
    stmt = (
        select(IntradaySymbolPrice)
        .where(IntradaySymbolPrice.symbol.in_(wanted))
        .where(IntradaySymbolPrice.kind == kind)
        .where(IntradaySymbolPrice.captured_at >= start)
        .where(IntradaySymbolPrice.captured_at <= end)
    )
    out: dict[str, dict[datetime, Decimal]] = {s: {} for s in wanted}
    for row in session.scalars(stmt).all():
        out[row.symbol][row.captured_at] = row.price_native
    return out


def rows_in_range(
    session: Session,
    symbols: Iterable[str] | None,
    start: datetime,
    end: datetime,
    *,
    kind: str | None = None,
) -> list[tuple[str, str, datetime, Decimal]]:
    """``(symbol, kind, captured_at, price)`` rows, any kind when ``kind`` is ``None``."""
    stmt = (
        select(IntradaySymbolPrice)
        .where(IntradaySymbolPrice.captured_at >= start)
        .where(IntradaySymbolPrice.captured_at <= end)
        .order_by(
            IntradaySymbolPrice.symbol, IntradaySymbolPrice.kind, IntradaySymbolPrice.captured_at
        )
    )
    if symbols is not None:
        wanted = sorted(set(symbols))
        if not wanted:
            return []
        stmt = stmt.where(IntradaySymbolPrice.symbol.in_(wanted))
    if kind is not None:
        stmt = stmt.where(IntradaySymbolPrice.kind == kind)
    return [(r.symbol, r.kind, r.captured_at, r.price_native) for r in session.scalars(stmt).all()]


def distinct_symbols(session: Session, *, kind: str = KIND_TWIN) -> list[str]:
    """Every symbol of ``kind`` with at least one stored row."""
    stmt = select(IntradaySymbolPrice.symbol).where(IntradaySymbolPrice.kind == kind).distinct()
    return sorted(session.scalars(stmt).all())


def delete_before(
    session: Session,
    cutoff: datetime,
    *,
    keep: Collection[datetime] = (),
    kind: str = KIND_TWIN,
) -> int:
    """Delete ``kind`` rows older than ``cutoff``, except those captured exactly at ``keep``."""
    stmt = (
        delete(IntradaySymbolPrice)
        .where(IntradaySymbolPrice.kind == kind)
        .where(IntradaySymbolPrice.captured_at < cutoff)
    )
    if keep:
        stmt = stmt.where(IntradaySymbolPrice.captured_at.not_in(list(keep)))
    result = session.execute(stmt)
    return int(result.rowcount or 0)


def delete_in_range(
    session: Session, start: datetime, end: datetime, *, kind: str = KIND_TWIN
) -> int:
    """Delete ``kind`` rows with ``start <= captured_at <= end``."""
    stmt = (
        delete(IntradaySymbolPrice)
        .where(IntradaySymbolPrice.kind == kind)
        .where(IntradaySymbolPrice.captured_at >= start)
        .where(IntradaySymbolPrice.captured_at <= end)
    )
    result = session.execute(stmt)
    return int(result.rowcount or 0)


def delete_at(session: Session, times: Collection[datetime], *, kind: str = KIND_TWIN) -> int:
    """Delete the ``kind`` rows captured exactly at ``times`` (any symbol)."""
    if not times:
        return 0
    stmt = (
        delete(IntradaySymbolPrice)
        .where(IntradaySymbolPrice.kind == kind)
        .where(IntradaySymbolPrice.captured_at.in_(list(times)))
    )
    result = session.execute(stmt)
    return int(result.rowcount or 0)


def delete_all(session: Session, *, kind: str = KIND_TWIN) -> int:
    result = session.execute(delete(IntradaySymbolPrice).where(IntradaySymbolPrice.kind == kind))
    return int(result.rowcount or 0)
