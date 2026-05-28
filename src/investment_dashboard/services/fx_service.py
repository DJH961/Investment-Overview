"""FX-rate service — incremental backfill + lookup with forward-fill.

Wraps :mod:`investment_dashboard.adapters.frankfurter_client` and stores
results via :mod:`investment_dashboard.repositories.fx_repo`. Higher-level
code (UI, metrics service) calls :func:`get_rate_eur_to_quote` which falls
back to the most-recent prior business-day rate when a target date has no
direct rate (weekends, holidays — see spec §5.6).

v2.2 generalised :func:`refresh_fx_history` to backfill **multiple
quotes** in a single call (e.g. EUR→USD *and* EUR→DKK), so the boot
sequence and tests don't need to loop quote-by-quote at the call site.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
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

#: Default quote currencies backfilled when the caller doesn't specify.
#: Kept here so :mod:`boot` and any ad-hoc CLI use the same canonical
#: list. The display-currency toggle in
#: :mod:`investment_dashboard.services.display_currency_service` is the
#: source of truth for which quotes the UI can render — keep this in
#: lockstep with ``SUPPORTED_CURRENCIES`` (minus the EUR base).
DEFAULT_QUOTES: tuple[str, ...] = ("USD", "DKK")


def refresh_fx_history(
    session: Session,
    *,
    earliest_needed: date,
    today: date | None = None,
    base: str = "EUR",
    quote: str | None = None,
    quotes: Iterable[str] | None = None,
) -> int:
    """Backfill ``fx_history`` so it covers ``[earliest_needed, today]``.

    Accepts either a single ``quote`` (back-compat with v2.1 callers) or
    an iterable of ``quotes``. When neither is provided the function
    backfills :data:`DEFAULT_QUOTES`.

    Strategy per quote:
        * Find the latest stored rate. If it's already ``today``, no-op.
        * Otherwise fetch from ``max(latest+1, earliest_needed)`` to today.

    Returns the total number of new rows written across all quotes.
    Network errors are logged and counted as zero rows for that quote —
    the app continues to function with stale rates.
    """
    today = today or date.today()
    if quote is not None and quotes is not None:
        raise ValueError("pass either 'quote' or 'quotes', not both")
    if quote is not None:
        targets: tuple[str, ...] = (quote,)
    elif quotes is not None:
        targets = tuple(quotes)
    else:
        targets = DEFAULT_QUOTES

    total = 0
    for q in targets:
        total += _refresh_single_quote(
            session,
            earliest_needed=earliest_needed,
            today=today,
            base=base,
            quote=q,
        )
    return total


def _refresh_single_quote(
    session: Session,
    *,
    earliest_needed: date,
    today: date,
    base: str,
    quote: str,
) -> int:
    latest = fx_repo.latest_rate_date(session, base=base, quote=quote)
    if latest is not None and latest >= today:
        return 0
    start = max(earliest_needed, (latest + timedelta(days=1)) if latest else earliest_needed)
    if start > today:
        return 0
    try:
        records = fetch_rates(start, today, base=base, quote=quote)
    except FrankfurterError as exc:
        log.warning(
            "FX refresh failed for %s→%s (%s); continuing with stale rates",
            base,
            quote,
            exc,
        )
        return 0
    rates = {r.date: r.rate for r in records}
    return fx_repo.upsert_rates(session, rates, base=base, quote=quote)


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
