"""Provider ex-dividend dates, cached for the ledger completeness check (v7 P7).

The price adapter returns the feed's dividend history in the same download as the
splits; nothing stored it. This service keeps just the **ex-dates per instrument**
as one JSON value in ``app_config`` (key :data:`CONFIG_KEY`), written by the
history refresh (never from a request path) and read by Data Health. No schema
change: amounts are not needed, the ledger holds those.
"""

from __future__ import annotations

import json
import logging
from datetime import date, timedelta

from sqlalchemy.orm import Session

from investment_dashboard.adapters.yfinance_client import YFinanceError, fetch_ex_dividend_dates
from investment_dashboard.domain.instruments import SYNTHETIC_ASSET_CLASSES, fetch_symbol
from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.repositories import instrument_overrides_repo, instruments_repo
from investment_dashboard.services import app_config_service

log = logging.getLogger(__name__)

#: ``app_config`` key holding ``{"<instrument_id>": ["YYYY-MM-DD", ...]}``.
CONFIG_KEY = "dividends.ex_dates"


def load(session: Session) -> dict[int, list[date]]:
    """Cached ex-dates per instrument id (empty when nothing was fetched yet)."""
    raw = app_config_service.get(session, CONFIG_KEY)
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return {int(k): sorted(date.fromisoformat(d) for d in v) for k, v in data.items()}
    except (ValueError, TypeError, AttributeError):
        log.warning("Cached dividend history is unreadable; ignoring it")
        return {}


def refresh(
    session: Session,
    *,
    earliest_needed: date,
    today: date | None = None,
    fetch: object = None,
) -> int:
    """Fetch and store ex-dates for every active instrument; returns instruments stored.

    Replaces the cache wholesale (small data). A feed failure keeps the old cache.
    """
    today = today or exchange_today()
    inactive = instrument_overrides_repo.not_fetched_ids(session)
    provider_symbols = instrument_overrides_repo.provider_symbol_map(session)
    by_symbol = {
        fetch_symbol(i.symbol, provider_symbols.get(i.id)): i
        for i in instruments_repo.list_instruments(session)
        if i.asset_class not in SYNTHETIC_ASSET_CLASSES and i.id not in inactive
    }
    if not by_symbol or earliest_needed > today:
        return 0
    fetcher = fetch if callable(fetch) else fetch_ex_dividend_dates
    try:
        found = fetcher(list(by_symbol), earliest_needed, today + timedelta(days=1))
    except YFinanceError as exc:
        log.warning("yfinance dividend refresh failed (%s); keeping cached dates", exc)
        return 0
    payload = {
        str(by_symbol[sym].id): sorted({d.isoformat() for d in dates})
        for sym, dates in found.items()
        if sym in by_symbol and dates
    }
    app_config_service.set_value(session, CONFIG_KEY, json.dumps(payload))
    return len(payload)
