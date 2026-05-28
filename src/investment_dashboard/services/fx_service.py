"""FX-rate service — incremental backfill + lookup with forward-fill.

Wraps :mod:`investment_dashboard.adapters.frankfurter_client` and stores
results via :mod:`investment_dashboard.repositories.fx_repo`. Higher-level
code (UI, metrics service) calls :func:`get_rate_eur_to_usd` which falls
back to the most-recent prior business-day rate when a target date has no
direct rate (weekends, holidays — see spec §5.6).
"""

from __future__ import annotations

import logging
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.adapters.frankfurter_client import (
    FrankfurterError,
    fetch_rates,
)
from investment_dashboard.domain.currency import lookup_rate_with_forward_fill
from investment_dashboard.repositories import fx_repo

log = logging.getLogger(__name__)

_PROVIDER = "frankfurter"


def _record_status(status: str, message: str) -> None:
    """Lazy wrapper around provider_status.record to avoid a circular import."""
    from investment_dashboard.services.provider_status import record  # noqa: PLC0415

    record(_PROVIDER, status, message)  # type: ignore[arg-type]


def refresh_fx_history(
    session: Session,
    *,
    earliest_needed: date,
    today: date | None = None,
    base: str = "EUR",
    quote: str = "USD",
) -> int:
    """Backfill ``fx_history`` so it covers ``[earliest_needed, today]``.

    Strategy:
        * Find the latest stored rate. If it's already ``today``, no-op.
        * Otherwise fetch from ``max(latest+1, earliest_needed)`` to today.

    Returns the number of new rows written. Network errors are logged and
    return ``0`` — the app continues to function with stale rates.
    """
    today = today or date.today()
    latest = fx_repo.latest_rate_date(session, base=base, quote=quote)
    if latest is not None and latest >= today:
        return 0
    start = max(earliest_needed, (latest + timedelta(days=1)) if latest else earliest_needed)
    if start > today:
        return 0
    try:
        records = fetch_rates(start, today, base=base, quote=quote)
    except FrankfurterError as exc:
        log.warning("FX refresh failed (%s); continuing with stale rates", exc)
        _record_status("error", f"{base}/{quote} fetch failed: {exc}")
        return 0
    rates = {r.date: r.rate for r in records}
    written = fx_repo.upsert_rates(session, rates, base=base, quote=quote)
    _record_status(
        "ok",
        f"Fetched {len(rates)} {base}/{quote} rate(s) for {start}..{today}; {written} new",
    )
    return written


def get_rate_eur_to_quote(
    session: Session,
    target: date,
    *,
    base: str = "EUR",
    quote: str = "USD",
) -> Decimal | None:
    """Lookup the EUR→quote rate for ``target`` with forward-fill.

    Returns ``None`` if the database has no prior rate at all.
    """
    rates = fx_repo.get_rates(session, base=base, quote=quote)
    return lookup_rate_with_forward_fill(rates, target)
