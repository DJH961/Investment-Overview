"""Read access to the cache-tier ``intraday_symbol_prices`` table (plain dataclasses).

Held stocks/ETFs (``kind="holding"``) get a price row next to each portfolio
sample the intraday capture / reconstruction / week backfill / Tiingo gap fill
writes; ETF twins (``kind="twin"``) keep their intraday prices and session
closes. Writes stay in :mod:`intraday_snapshots_service` (same bars as the
portfolio line, no extra fetching); this module is the read side the holding
deep-dive uses. Prices are native, never converted.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.repositories import symbol_prices_repo

KIND_HOLDING = symbol_prices_repo.KIND_HOLDING
KIND_TWIN = symbol_prices_repo.KIND_TWIN


@dataclass(frozen=True)
class SymbolPrice:
    symbol: str
    kind: str
    captured_at: datetime
    price_native: Decimal


def prices(
    session: Session,
    symbols: Iterable[str],
    start: datetime,
    end: datetime,
    kind: str | None = None,
) -> list[SymbolPrice]:
    """Stored prices of ``symbols`` with ``start <= captured_at <= end`` (naive UTC).

    ``kind`` ``None`` returns both kinds. Sorted by symbol, kind, instant.
    """
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    wanted = sorted(set(symbols))
    if not wanted:
        return []
    with cache_read_session(session) as cache:
        rows = symbol_prices_repo.rows_in_range(cache, wanted, start, end, kind=kind)
    return [SymbolPrice(sym, k, at, px) for sym, k, at, px in rows]
