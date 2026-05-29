"""Risk-free rate service — live yield from yfinance with a manual override.

The Sharpe / Sortino / Alpha calculations need a *current* risk-free
rate. We pull it from yfinance's ``^TNX`` ticker, which quotes the
10-year US Treasury yield as a *percentage* (e.g. ``4.32`` means
4.32% annualised). The fetched value is persisted in ``app_config`` so
boot doesn't depend on the network and so the Settings page can
display "last refreshed at" alongside it.

v2.4 switched the default from ``^IRX`` (13-week T-bill yield, which
yfinance has been returning empty frames for since the CBOE feed was
restructured) to ``^TNX``. The 10-year yield is still a dynamic,
realistic risk-free proxy for a multi-year buy-and-hold portfolio
that doesn't drift far from the 13-week number on a Sharpe-ratio
basis, and it is reliably published every business day.

Per spec the user can also pin a *manual* rate that wins over the
fetched one — handy for back-testing scenarios or for cases where the
local risk-free instrument is something other than US Treasuries.

No hypothetical fallback: if we've never managed a successful fetch
and the user hasn't pinned a manual rate, ``get_risk_free_rate``
returns ``None`` and the UI surfaces "unavailable" rather than
inventing a number.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.adapters import yfinance_client
from investment_dashboard.repositories import app_config_repo

log = logging.getLogger(__name__)

#: ``^TNX`` is the CBOE 10-year US Treasury *yield*, quoted in %
#: (e.g. 4.32). v2.4 replaced the v2.2 default ``^IRX`` (13-week
#: T-bill yield) because yfinance has been returning empty frames for
#: ``^IRX`` since the upstream CBOE feed changed; ``^TNX`` is a
#: dynamic, well-supported risk-free proxy that follows the same
#: percentage-quoted convention.
DEFAULT_SYMBOL = "^TNX"
DEFAULT_TTL = timedelta(hours=24)

KEY_VALUE = "risk_free_rate_value"
KEY_FETCHED_AT = "risk_free_rate_fetched_at"
KEY_SYMBOL = "risk_free_rate_symbol"
KEY_MANUAL = "risk_free_rate_manual"


@dataclass(frozen=True)
class RiskFreeSnapshot:
    """What the Settings/Analytics pages need to render the rate."""

    rate: Decimal | None
    fetched_at: datetime | None
    symbol: str
    is_manual: bool


def _parse_decimal(raw: str | None) -> Decimal | None:
    if raw is None or raw == "":
        return None
    try:
        return Decimal(raw)
    except (ArithmeticError, ValueError):
        return None


def _parse_datetime(raw: str | None) -> datetime | None:
    if raw is None or raw == "":
        return None
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


#: Deprecated default that we transparently rewrite to :data:`DEFAULT_SYMBOL`
#: on read. Existing installs persisted ``^IRX`` to ``app_config`` before
#: v2.4; upgrading them silently would keep the Analytics page broken
#: until the user manually edits the Settings field. Rewriting on read
#: keeps the persisted value in sync with the active default without an
#: explicit migration step.
_DEPRECATED_SYMBOLS: frozenset[str] = frozenset({"^IRX"})


def get_symbol(session: Session) -> str:
    stored = app_config_repo.get(session, KEY_SYMBOL)
    if stored is None or stored in _DEPRECATED_SYMBOLS:
        # Rewrite the persisted value so Settings shows the active default
        # and the next refresh hits the working ticker.
        if stored in _DEPRECATED_SYMBOLS:
            app_config_repo.set_value(session, KEY_SYMBOL, DEFAULT_SYMBOL)
        return DEFAULT_SYMBOL
    return stored


def set_symbol(session: Session, symbol: str) -> str:
    cleaned = symbol.strip()
    if not cleaned:
        raise ValueError("symbol must be non-empty")
    app_config_repo.set_value(session, KEY_SYMBOL, cleaned)
    return cleaned


def set_manual_rate(session: Session, rate: Decimal | None) -> None:
    """Pin or clear the manual override. ``None`` reverts to the fetched rate."""
    if rate is None:
        app_config_repo.set_value(session, KEY_MANUAL, None)
        return
    if rate < 0 or rate > 1:
        raise ValueError(f"rate must be a decimal fraction in [0, 1], got {rate}")
    app_config_repo.set_value(session, KEY_MANUAL, str(rate))


def _stored_snapshot(session: Session) -> RiskFreeSnapshot:
    manual = _parse_decimal(app_config_repo.get(session, KEY_MANUAL))
    if manual is not None:
        return RiskFreeSnapshot(
            rate=manual,
            fetched_at=None,
            symbol=get_symbol(session),
            is_manual=True,
        )
    return RiskFreeSnapshot(
        rate=_parse_decimal(app_config_repo.get(session, KEY_VALUE)),
        fetched_at=_parse_datetime(app_config_repo.get(session, KEY_FETCHED_AT)),
        symbol=get_symbol(session),
        is_manual=False,
    )


def refresh(
    session: Session,
    *,
    fetcher: Any = None,
    now: datetime | None = None,
) -> RiskFreeSnapshot:
    """Fetch the latest rate from yfinance and persist it.

    Returns the resulting snapshot. If the fetch fails the previously
    cached value is returned unchanged (no hypothetical fallback). A
    manual override always shortcuts the fetch.
    """
    snapshot = _stored_snapshot(session)
    if snapshot.is_manual:
        return snapshot

    fetch = fetcher or yfinance_client.fetch_latest_close
    symbol = get_symbol(session)
    record = None
    try:
        record = fetch(symbol)
    except Exception as exc:  # pragma: no cover - network churn
        log.warning("risk-free fetch for %s failed: %s", symbol, exc)
    if record is None or record.close is None:
        log.info("risk-free fetch for %s returned no data; keeping cached value", symbol)
        return snapshot

    # ^TNX (like ^IRX before it) is quoted in percent; many other
    # yields follow the same convention. Anything > 1 is assumed to be
    # percent-quoted; values in (0, 1) are assumed to already be a
    # decimal fraction.
    raw = record.close
    rate = raw / Decimal(100) if raw > Decimal(1) else raw
    stamp = (now or datetime.now(UTC)).isoformat()
    app_config_repo.set_value(session, KEY_VALUE, str(rate))
    app_config_repo.set_value(session, KEY_FETCHED_AT, stamp)
    return RiskFreeSnapshot(
        rate=rate,
        fetched_at=datetime.fromisoformat(stamp),
        symbol=symbol,
        is_manual=False,
    )


def get_risk_free_rate(
    session: Session,
    *,
    fetcher: Any = None,
    ttl: timedelta = DEFAULT_TTL,
    now: datetime | None = None,
) -> RiskFreeSnapshot:
    """Return the cached rate, refreshing if older than ``ttl``.

    A manual override always wins. If we've never fetched successfully
    and there's no manual rate, the returned snapshot's ``rate`` is
    ``None`` and the caller should treat the rate as unavailable.
    """
    snapshot = _stored_snapshot(session)
    if snapshot.is_manual:
        return snapshot

    now = now or datetime.now(UTC)
    needs_refresh = (
        snapshot.fetched_at is None or snapshot.rate is None or (now - snapshot.fetched_at) >= ttl
    )
    if needs_refresh:
        return refresh(session, fetcher=fetcher, now=now)
    return snapshot
