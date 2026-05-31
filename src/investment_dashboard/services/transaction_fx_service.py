"""Freeze each transaction's EUR + USD cash legs at the trade-date FX rate.

Spec §4.1 / §5.6 require every historical figure (KPIs, deposits, the
cashflow stream feeding XIRR) to be valued at the FX rate in force on the
*transaction's date*, not today's spot. Rather than re-derive that on every
page render, this service computes both legs **once** — at import / manual
entry — and persists them on the ``transactions`` row:

* ``net_usd`` — the USD leg. For USD-native accounts (the common case) this
  is exactly ``net_native``; USD is the booked currency, so it is frozen
  verbatim and EUR is the derived side.
* ``net_eur`` — the EUR leg (already persisted pre-v2.9; kept canonical).
* ``fx_rate_to_eur`` — EUR per 1 unit of native currency, for audit.

Read paths prefer these frozen columns and only fall back to live FX
derivation when a leg is ``NULL`` (a row written while FX history had a gap,
or one that predates the backfill). A ``NULL`` leg is therefore a signal that
the row should be revisited — :func:`backfill_missing_legs` (run on boot and
from *Settings → Recalculate*) keeps retrying until accurate data lands.

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
from investment_dashboard.models import Transaction
from investment_dashboard.repositories import fx_repo, transactions_repo
from investment_dashboard.services import fx_service

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class TransactionLegs:
    """Frozen currency legs for one transaction."""

    fx_rate_to_eur: Decimal | None
    net_eur: Decimal | None
    net_usd: Decimal | None
    #: ``True`` when every leg the account needs could be computed. ``False``
    #: signals missing FX history — the caller should retry a refresh.
    complete: bool


@dataclass(frozen=True)
class RecalcResult:
    """Outcome of a (re)compute pass over the ledger."""

    examined: int
    updated: int
    #: Rows still missing a leg after the pass (FX history gap).
    incomplete: int


def compute_legs(
    session: Session,
    *,
    native_currency: str,
    net_native: Decimal | None,
    on: date,
) -> TransactionLegs:
    """Compute frozen EUR/USD legs for a single cash amount on ``on``.

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


def apply_legs(session: Session, txn: Transaction, *, force: bool = False) -> bool:
    """Compute and write frozen legs onto ``txn``. Returns ``complete``.

    When ``force`` is ``False`` an already-complete row (both legs present)
    is left untouched, so the boot pass is cheap. ``force=True`` recomputes
    unconditionally — used by *Settings → Recalculate* to repair rows after
    FX history is corrected.
    """
    if not force and txn.net_eur is not None and txn.net_usd is not None:
        return True
    native_currency = txn.account.native_currency if txn.account else "EUR"
    legs = compute_legs(
        session,
        native_currency=native_currency,
        net_native=txn.net_native,
        on=txn.date,
    )
    # Only overwrite a stored value when we have something better; never clear
    # a previously frozen leg just because today's FX lookup came back empty.
    if legs.fx_rate_to_eur is not None:
        txn.fx_rate_to_eur = legs.fx_rate_to_eur
    if legs.net_eur is not None:
        txn.net_eur = legs.net_eur
    if legs.net_usd is not None:
        txn.net_usd = legs.net_usd
    return legs.complete


def backfill_missing_legs(session: Session, *, force: bool = False) -> RecalcResult:
    """Populate frozen legs across the whole ledger.

    ``force=False`` (boot default) only touches rows missing a leg, so a
    healthy ledger is a no-op. ``force=True`` recomputes every row from
    current FX history — the *Settings → Recalculate* behaviour.
    """
    txns = list(transactions_repo.list_transactions(session))
    examined = 0
    updated = 0
    incomplete = 0
    for txn in txns:
        needs = force or txn.net_eur is None or txn.net_usd is None
        if not needs:
            continue
        examined += 1
        before = (txn.fx_rate_to_eur, txn.net_eur, txn.net_usd)
        complete = apply_legs(session, txn, force=force)
        after = (txn.fx_rate_to_eur, txn.net_eur, txn.net_usd)
        if after != before:
            updated += 1
        if not complete:
            incomplete += 1
    session.flush()
    return RecalcResult(examined=examined, updated=updated, incomplete=incomplete)


def missing_fx_dates(session: Session) -> list[date]:
    """Trade dates of rows that still lack a frozen leg (FX-history gaps).

    Used by the importer to decide whether to retry an FX refresh and by the
    UI to report unresolved gaps to the user.
    """
    txns = transactions_repo.list_transactions(session)
    gaps = {
        t.date
        for t in txns
        if t.net_native is not None and (t.net_eur is None or t.net_usd is None)
    }
    return sorted(gaps)


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
    today = today or date.today()
    from investment_dashboard.db import cache_write_session  # noqa: PLC0415

    # FX history is cache-tier data. Read coverage *and* write any refreshed
    # rates through a cache-tier session so split-DB installs probe and populate
    # the same database the dashboard read paths use (a no-op reuse of
    # ``session`` in single-file mode).
    with cache_write_session(session) as cache:
        for _ in range(max(1, max_attempts)):
            rates = fx_repo.get_rates(cache, base="EUR", quote="USD")
            if any(d <= earliest_needed for d in rates):
                return True
            try:
                fx_service.refresh_fx_history(
                    cache, earliest_needed=earliest_needed, today=today, quote="USD"
                )
            except Exception:  # pragma: no cover - defensive; refresh logs already
                log.warning("FX coverage refresh attempt failed; retrying", exc_info=True)
        rates = fx_repo.get_rates(cache, base="EUR", quote="USD")
        return any(d <= earliest_needed for d in rates)
