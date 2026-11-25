"""Trade-date EUR + USD cash legs: completeness checks, never stored (P19).

Spec §4.1 / §5.6 require every historical figure (KPIs, deposits, the
cashflow stream feeding XIRR) to be valued at the FX rate in force on the
*transaction's date*, not today's spot. Since 7.4 (P19) the legs are no longer
frozen on the ``transactions`` row: every reader derives them from
``net_native`` and that date's rate (``services/cashflows.py``), and a USD
account's USD is its native amount. The ``net_eur``, ``net_usd`` and
``fx_rate_to_eur`` columns stay ``NULL`` on new rows and are never read.

What is left here:

* :func:`compute_legs` works out the legs for one amount, so a writer can warn
  when the FX history has a gap (the legs themselves are not stored);
* :func:`backfill_missing_legs` and :func:`missing_fx_dates` report the rows
  whose derived legs cannot be computed yet (no rate on file);
* :func:`ensure_fx_coverage` refreshes the FX history an import needs.

Tier note: ``fx_history`` is cache-tier data. The FX lookups here go through
:mod:`investment_dashboard.services.fx_service` / a cache-tier session, so they
resolve against the cache database even under a split-DB layout (and reuse the
caller's session in the default single-file layout).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.domain.currency import split_native_to_dual_legs
from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.repositories import transactions_repo
from investment_dashboard.services import fx_service

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class TransactionLegs:
    """Derived currency legs for one amount (computed, never stored)."""

    fx_rate_to_eur: Decimal | None
    net_eur: Decimal | None
    net_usd: Decimal | None
    #: ``True`` when every leg the account needs could be computed. ``False``
    #: signals missing FX history — the caller should retry a refresh.
    complete: bool


@dataclass(frozen=True)
class RecalcResult:
    """Outcome of a leg check over the ledger."""

    examined: int
    updated: int
    #: Rows still missing a derived leg (FX history gap).
    incomplete: int


def compute_legs(
    session: Session,
    *,
    native_currency: str,
    net_native: Decimal | None,
    on: date,
) -> TransactionLegs:
    """Compute the EUR/USD legs of a single cash amount on ``on`` (not stored).

    ``native_currency`` is the booking currency (the account's
    ``native_currency``). Rates are looked up from ``fx_history`` with
    forward-fill onto the most recent prior business day.
    """
    ccy = (native_currency or "EUR").upper()
    eur_to_usd = fx_service.get_rate_eur_to_quote(session, on, quote="USD")
    if ccy == "EUR":
        fx_rate_to_eur: Decimal | None = Decimal(1)
        native_to_eur_rate: Decimal | None = Decimal(1)
    elif ccy == "USD":
        fx_rate_to_eur = (
            Decimal(1) / eur_to_usd if eur_to_usd is not None and eur_to_usd != 0 else None
        )
        # ``native_to_eur_rate`` is the *quote-per-1-EUR* (EUR→native) rate
        # consumed by :func:`split_native_to_dual_legs` as ``net_native /
        # rate`` — so for USD-native it is the EUR→USD rate (~1.08), exactly
        # what the general branch below would derive via ``quote="USD"``. (The
        # USD branch of ``split_native_to_dual_legs`` short-circuits before
        # using it, but we keep it correct so a future control-flow change
        # can't silently invert the conversion.)
        native_to_eur_rate = eur_to_usd
    else:
        native_to_eur_rate = fx_service.get_rate_eur_to_quote(session, on, quote=ccy)
        fx_rate_to_eur = (
            Decimal(1) / native_to_eur_rate
            if native_to_eur_rate is not None and native_to_eur_rate != 0
            else None
        )

    net_eur, net_usd = split_native_to_dual_legs(
        native_currency=ccy,
        net_native=net_native,
        eur_to_usd_rate=eur_to_usd,
        native_to_eur_rate=native_to_eur_rate,
    )
    # Completeness: a leg may legitimately be ``None`` when ``net_native`` is
    # ``None`` (no cash amount, e.g. a pure split). In that case the row needs
    # no FX and is "complete". Otherwise both legs must be populated.
    complete = net_native is None or (net_eur is not None and net_usd is not None)
    return TransactionLegs(
        fx_rate_to_eur=fx_rate_to_eur,
        net_eur=net_eur,
        net_usd=net_usd,
        complete=complete,
    )


def _first_rate_date(session: Session) -> date | None:
    rates = fx_service.get_rates(session, base="EUR", quote="USD")
    return min(rates) if rates else None


def backfill_missing_legs(session: Session, *, force: bool = False) -> RecalcResult:
    """Count the ledger rows whose derived EUR/USD legs are still missing.

    Nothing is written any more (P19): the legs are derived from ``net_native``
    and the FX table when read, so once a missing rate lands the row heals by
    itself. ``examined`` is the number of rows checked (every cash row when
    ``force`` is set, else only the rows with a gap), ``updated`` is always 0
    and ``incomplete`` counts the rows that still have no rate on file.
    ``force`` is kept for the *Settings → Recalculate* job's signature.
    """
    missing = transactions_repo.list_transactions_missing_legs(
        session, first_rate_date=_first_rate_date(session)
    )
    if force:
        examined = sum(
            1 for t in transactions_repo.list_transactions(session) if t.net_native is not None
        )
    else:
        examined = len(missing)
    return RecalcResult(examined=examined, updated=0, incomplete=len(missing))


def missing_fx_dates(session: Session) -> list[date]:
    """Trade dates of cash rows whose derived legs lack a rate (FX-history gaps).

    Used by the importer to decide whether to retry an FX refresh and by the
    UI to report unresolved gaps to the user.
    """
    txns = transactions_repo.list_transactions_missing_legs(
        session, first_rate_date=_first_rate_date(session)
    )
    return sorted({t.date for t in txns})


def ensure_fx_coverage(
    session: Session,
    *,
    earliest_needed: date,
    today: date | None = None,
    max_attempts: int = 3,
) -> bool:
    """Refresh EUR→USD history covering ``[earliest_needed, today]``, retrying.

    Returns ``True`` if, after up to ``max_attempts`` refreshes, the history
    has at least one rate on or before ``earliest_needed`` (so every trade in
    range can forward-fill a real rate). A transient network/server glitch on
    one attempt therefore won't silently freeze wrong legs — the caller can
    react to a ``False`` result, and the boot/Settings backfill will retry on
    the next run regardless.
    """
    today = today or exchange_today()
    from investment_dashboard.db import cache_write_session  # noqa: PLC0415

    # FX history is cache-tier data. Read coverage *and* write any refreshed
    # rates through a cache-tier session so split-DB installs probe and populate
    # the same database the dashboard read paths use (a no-op reuse of
    # ``session`` in single-file mode).
    with cache_write_session(session) as cache:
        for _ in range(max(1, max_attempts)):
            rates = fx_service.get_rates(cache, base="EUR", quote="USD")
            if any(d <= earliest_needed for d in rates):
                return True
            try:
                fx_service.refresh_fx_history(
                    cache, earliest_needed=earliest_needed, today=today, quote="USD"
                )
            except Exception:  # pragma: no cover - defensive; refresh logs already
                log.warning("FX coverage refresh attempt failed; retrying", exc_info=True)
        rates = fx_service.get_rates(cache, base="EUR", quote="USD")
        return any(d <= earliest_needed for d in rates)
