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
from dataclasses import dataclass
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
#: lockstep with ``SUPPORTED_CURRENCIES`` (minus the EUR base). v2.4
#: dropped the DKK leg added in v2.2.
DEFAULT_QUOTES: tuple[str, ...] = ("USD",)

_PROVIDER = "frankfurter"


@dataclass(frozen=True)
class LiveSpot:
    """A live FX spot reading and the day it was observed.

    ``observed_on`` lets :func:`get_rates` decide whether the spot is fresh
    enough to overlay as *today's* mark — a weekend/stale reading (dated before
    the real today) is ignored so we never pass off an old rate as live.
    """

    observed_on: date
    rate: Decimal


#: In-memory live FX spots keyed by quote currency (e.g. ``"USD"``). Populated
#: by :func:`refresh_live_spot` during the price refresh and overlaid onto the
#: ECB daily history by :func:`get_rates` for *today only*. Kept deliberately
#: out of the persisted ``fx_history`` table so the golden-master daily marks
#: for past dates stay byte-for-byte stable — only the current day moves with
#: the live intraday rate. Process-local; resets on restart (re-warmed by the
#: next refresh tick).
_LIVE_SPOT: dict[str, LiveSpot] = {}


def set_live_spot(quote: str, rate: Decimal, *, observed_on: date) -> None:
    """Record a live FX spot for ``quote`` (units of ``quote`` per 1 EUR)."""
    _LIVE_SPOT[quote.upper()] = LiveSpot(observed_on=observed_on, rate=rate)


def get_live_spot(quote: str = "USD") -> LiveSpot | None:
    """Return the last recorded live spot for ``quote``, or ``None``."""
    return _LIVE_SPOT.get(quote.upper())


def clear_live_spot(quote: str | None = None) -> None:
    """Drop the live spot for ``quote`` (or all of them). Used by tests."""
    if quote is None:
        _LIVE_SPOT.clear()
    else:
        _LIVE_SPOT.pop(quote.upper(), None)


def refresh_live_spot(
    *,
    quote: str = "USD",
    today: date | None = None,
    fetcher: object = None,
) -> Decimal | None:
    """Fetch and store the live EUR→``quote`` spot from the keyless yfinance feed.

    Best-effort: returns the stored rate, or ``None`` when the feed is
    unavailable or only offers a stale (pre-today) reading. Only EUR→USD is
    sourced today; other quotes keep the ECB daily rate. ``fetcher`` is
    injectable for tests (defaults to
    :func:`yfinance_client.fetch_eur_usd_spot`).
    """
    if quote.upper() != "USD":
        return None
    today = today or date.today()
    if fetcher is None:
        from investment_dashboard.adapters.yfinance_client import (  # noqa: PLC0415
            fetch_eur_usd_spot,
        )

        fetcher = fetch_eur_usd_spot
    try:
        record = fetcher()  # type: ignore[operator]
    except Exception as exc:  # pragma: no cover - network churn
        log.warning("live EUR/USD fetch failed (%s); keeping ECB daily rate", exc)
        return None
    if record is None or record.close is None or record.close <= 0:
        return None
    # Only treat a reading dated *today* as a live overlay; an older close
    # (weekend/holiday, or before the FX market reopened) stays on the ECB
    # daily rate instead of masquerading as a live intraday mark.
    if record.date != today:
        return None
    set_live_spot(quote, record.close, observed_on=record.date)
    return record.close


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
        # Up to date at the tail, but a leading gap (cached history starting
        # later than ``earliest_needed``) still needs filling.
        earliest = fx_repo.earliest_rate_date(session, base=base, quote=quote)
        if earliest is None or earliest <= earliest_needed:
            return 0
        start = earliest_needed
    else:
        earliest = fx_repo.earliest_rate_date(session, base=base, quote=quote)
        if earliest is not None and earliest > earliest_needed:
            # Leading gap: refetch from ``earliest_needed`` (upsert is
            # idempotent so the cached tail is rewritten harmlessly).
            start = earliest_needed
        else:
            start = max(
                earliest_needed, (latest + timedelta(days=1)) if latest else earliest_needed
            )
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
        _record_status("error", f"{base}/{quote} fetch failed: {exc}")
        return 0
    rates = {r.date: r.rate for r in records}
    written = fx_repo.upsert_rates(session, rates, base=base, quote=quote)
    _record_status(
        "ok",
        f"Fetched {len(rates)} {base}/{quote} rate(s) for {start}..{today}; {written} new",
    )
    return written


def get_rates(
    session: Session,
    *,
    base: str = "EUR",
    quote: str = "USD",
) -> dict[date, Decimal]:
    """Return the full ``{date: rate}`` series for ``base``/``quote``.

    Tier-aware wrapper around :func:`fx_repo.get_rates`: FX history lives in the
    cache tier, so under a split-DB layout the read is routed to the cache
    database instead of the caller's (empty) ledger copy. In single-file mode
    the caller's session is reused unchanged.
    """
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    with cache_read_session(session) as cache:
        rates = fx_repo.get_rates(cache, base=base, quote=quote)
    # Overlay the live intraday spot for *today only*, leaving every historical
    # mark untouched (so the golden-master daily figures stay byte-stable). The
    # live spot is never written back to ``fx_history``; it lives in memory and
    # is refreshed each price tick. Past-date lookups forward-fill from the
    # stored history exactly as before — adding a key dated today cannot change
    # any value forward-filled to an earlier date.
    if base == "EUR":
        live = _LIVE_SPOT.get(quote.upper())
        if live is not None and live.observed_on == date.today():
            rates = {**rates, live.observed_on: live.rate}
    return rates


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
    rates = get_rates(session, base=base, quote=quote)
    return lookup_rate_with_forward_fill(rates, target)
