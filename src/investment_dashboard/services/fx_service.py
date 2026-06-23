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
#: Provider tag of the retired yfinance ``EURUSD=X`` end-of-day overlay; kept so
#: any rows it left behind can be purged in favour of the ECB reference rates.
_YF_PROVIDER = "yfinance"


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
    tiingo_fetcher: object = None,
    tiingo_token: str | None = None,
    charge_budget: object = None,
) -> Decimal | None:
    """Fetch and store the live EUR→``quote`` spot, primary then Tiingo backup.

    The keyless yfinance ``EURUSD=X`` feed is the primary. When it is unavailable
    or only offers a stale (pre-today) reading, **Tiingo** is tried as the
    secondary live FX provider (mirroring the equity/NAV fallback): one budgeted
    call to its FX top-of-book endpoint, gated so a sustained yfinance FX outage
    can't burn the desktop Tiingo cap. Only fires when a Tiingo token is
    configured; a vanilla install never touches Tiingo.

    Best-effort: returns the stored rate, or ``None`` when neither provider offers
    a fresh today-dated reading. Only EUR→USD is sourced today; other quotes keep
    the ECB daily rate. ``fetcher`` (yfinance), ``tiingo_fetcher``,
    ``tiingo_token`` and ``charge_budget`` are injectable for tests.
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
        log.warning("live EUR/USD fetch failed (%s); trying Tiingo FX backup", exc)
        record = None
    # Only treat a reading dated *today* as a live overlay; an older close
    # (weekend/holiday, or before the FX market reopened) stays on the ECB
    # daily rate instead of masquerading as a live intraday mark.
    if (
        record is not None
        and record.close is not None
        and record.close > 0
        and record.date == today
    ):
        set_live_spot(quote, record.close, observed_on=record.date)
        return record.close
    # Primary fell short (failed, unavailable, or only a stale reading) — engage
    # the Tiingo secondary FX provider before conceding to the ECB daily rate.
    return _refresh_live_spot_via_tiingo(
        quote=quote,
        today=today,
        fetcher=tiingo_fetcher,
        token=tiingo_token,
        charge_budget=charge_budget,
    )


def _charge_desktop_tiingo_budget() -> bool:
    """Reserve one desktop Tiingo call against the persisted ET-reset budget.

    Returns ``True`` when a call may be spent (and charges it up-front, so a
    failed call still counts and can't drive a retry storm), ``False`` when the
    hourly/daily cap is exhausted. Best-effort: a persistence error logs and
    permits the call rather than blocking FX on a DB hiccup.
    """
    try:
        from datetime import UTC, datetime  # noqa: PLC0415

        from investment_dashboard.db import cache_session_scope  # noqa: PLC0415
        from investment_dashboard.repositories import tiingo_state_repo  # noqa: PLC0415

        now_utc = datetime.now(tz=UTC).replace(tzinfo=None)
        with cache_session_scope() as session:
            state = tiingo_state_repo.load(session, now_utc)
            if not state.budget().has_room():
                return False
            tiingo_state_repo.record_spend(state, 1)
            tiingo_state_repo.save(session, state)
        return True
    except Exception:  # pragma: no cover - defensive: never block FX on DB issues
        log.warning("Tiingo FX budget check failed; proceeding without gating", exc_info=True)
        return True


def _refresh_live_spot_via_tiingo(
    *,
    quote: str,
    today: date,
    fetcher: object,
    token: str | None,
    charge_budget: object,
) -> Decimal | None:
    """Try the Tiingo secondary live FX provider for EUR→``quote``.

    Returns the stored rate on a fresh today-dated reading, else ``None`` (token
    absent, budget exhausted, a transient failure, or a stale weekend/holiday
    quote — all of which leave the ECB daily rate in place).
    """
    if token is None:
        from investment_dashboard.services.prices_service import (  # noqa: PLC0415
            _resolve_tiingo_token,
        )

        token = _resolve_tiingo_token()
    if not token:
        return None  # No Tiingo configured — vanilla install, no backup.

    gate = charge_budget if charge_budget is not None else _charge_desktop_tiingo_budget
    if not gate():  # type: ignore[operator]
        log.info("Tiingo FX backup skipped: desktop Tiingo budget exhausted")
        return None

    if fetcher is None:
        from investment_dashboard.adapters.tiingo_client import (  # noqa: PLC0415
            fetch_fx_rate,
        )

        resolved_token = token

        def fetcher() -> object:
            return fetch_fx_rate(base="EUR", quote="USD", token=resolved_token)

    try:
        reading = fetcher()  # type: ignore[operator]
    except Exception as exc:  # pragma: no cover - network churn
        log.warning("Tiingo FX backup fetch failed (%s); keeping ECB daily rate", exc)
        return None
    if reading is None or reading.rate is None or reading.rate <= 0:
        return None
    # Reject a stale reading (weekend/holiday last quote) the same way the
    # yfinance spot is rejected when it isn't dated today.
    if reading.value_date is not None and reading.value_date != today:
        return None
    set_live_spot(quote, reading.rate, observed_on=today)
    log.info("Live EUR/USD spot sourced from Tiingo backup (%s)", reading.rate)
    return reading.rate


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
    # Note the pair we just pulled from Frankfurter, so Settings can report it.
    from investment_dashboard.services import fetch_report  # noqa: PLC0415

    fetch_report.record("frankfurter", [f"{base}/{quote}"])
    _record_status(
        "ok",
        f"Fetched {len(rates)} {base}/{quote} rate(s) for {start}..{today}; {written} new",
    )
    return written


def purge_legacy_yfinance_fx_history(
    session: Session,
    *,
    quote: str = "USD",
) -> int:
    """Drop any legacy yfinance end-of-day EUR→``quote`` overlay rows.

    Historical end-of-day FX is sourced from the ECB/Frankfurter reference rates
    (:func:`refresh_fx_history`); an earlier build additionally re-marked the same
    days at yfinance's ``EURUSD=X`` close, which has since been reverted. This
    retires those yfinance-sourced rows so the ECB backfill repopulates the dates
    on the next refresh, leaving a single, consistent end-of-day source. (The
    live *today-only* intraday spot overlay and the "1 Day" curve's per-minute
    EUR/USD reconstruction are unaffected — both are separate paths.)

    Idempotent: a no-op once no such rows remain. Returns the number removed.
    """
    return fx_repo.delete_by_source(session, base="EUR", quote=quote, source=_YF_PROVIDER)


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
