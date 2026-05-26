"""Price-history service — incremental refresh + last-known-price lookup."""

from __future__ import annotations

import logging
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.adapters.yfinance_client import YFinanceError, fetch_closes
from investment_dashboard.repositories import instruments_repo, prices_repo

log = logging.getLogger(__name__)


def refresh_prices(
    session: Session,
    *,
    earliest_needed: date,
    today: date | None = None,
) -> dict[str, int]:
    """Backfill ``price_history`` for every active instrument.

    Synthetic ``SAVINGS_CASH`` (and other ``cash``/``savings`` asset
    classes) is skipped — there is no yfinance ticker. Returns
    ``{symbol: rows_written}``.
    """
    today = today or date.today()
    result: dict[str, int] = {}

    instruments = instruments_repo.list_instruments(session, only_active=True)
    symbols_to_fetch: list[str] = []
    earliest_per_symbol: dict[str, date] = {}
    for instr in instruments:
        if instr.asset_class in {"cash", "savings"}:
            continue
        latest = prices_repo.latest_price_date(session, instr.id)
        start = (
            max(earliest_needed, latest + timedelta(days=1))
            if latest is not None
            else earliest_needed
        )
        if start >= today + timedelta(days=1):
            result[instr.symbol] = 0
            continue
        symbols_to_fetch.append(instr.symbol)
        earliest_per_symbol[instr.symbol] = start

    if not symbols_to_fetch:
        return result

    start = min(earliest_per_symbol.values())
    end = today + timedelta(days=1)
    try:
        closes_by_symbol = fetch_closes(symbols_to_fetch, start, end)
    except YFinanceError as exc:
        log.warning("yfinance refresh failed (%s); continuing with stale prices", exc)
        return result

    by_symbol = {i.symbol: i for i in instruments}
    for symbol, closes in closes_by_symbol.items():
        instr = by_symbol.get(symbol)
        if instr is None:
            continue
        cutoff = earliest_per_symbol.get(symbol, earliest_needed)
        filtered = {d: c for d, c in closes.items() if d >= cutoff}
        result[symbol] = prices_repo.upsert_closes(session, instr.id, filtered)
    return result


def latest_close(session: Session, instrument_id: int) -> Decimal | None:
    """Last known close for ``instrument_id``."""
    return prices_repo.latest_close(session, instrument_id)
