"""FX conversion batches and the FIFO USD pool (plan section 2.5).

CRUD over ``fx_conversions`` plus the deposit-matching report. The ECB fallback
rate is read through :mod:`fx_service` only (cache-tier rule). Not yet wired into
XIRR/metrics: :func:`effective_eur_overrides` is the hook for that.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy.orm import Session

from investment_dashboard.activity_log import activity
from investment_dashboard.domain import fx_pool
from investment_dashboard.domain.currency import lookup_rate_with_forward_fill
from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.repositories import fx_conversion_repository as repo
from investment_dashboard.services import fx_service

if TYPE_CHECKING:
    from investment_dashboard.models import FxConversion


@dataclass(frozen=True)
class PoolReport:
    conversions: tuple[FxConversion, ...]
    result: fx_pool.PoolResult
    #: Deposit date by transaction id (for display).
    deposit_ids: tuple[int, ...]


def _validate(
    *, on: date, eur_sent: Decimal, usd_received: Decimal, fees_eur: Decimal | None
) -> None:
    if eur_sent <= 0 or usd_received <= 0:
        raise ValueError("eur_sent and usd_received must be positive")
    if fees_eur is not None and fees_eur < 0:
        raise ValueError("fees_eur must not be negative")
    if on > exchange_today():
        raise ValueError("date must not be in the future")


def _note_change(action: str, conversion_id: int, on: date) -> None:
    """One ``changes.log`` line per conversion edit (B-021): id and date, never amounts."""
    activity("changes").info(
        "conversion %s: id=%s date=%s kind=fx_conversion", action, conversion_id, on.isoformat()
    )


def list_conversions(session: Session) -> Sequence[FxConversion]:
    return repo.list_all(session)


def get_conversion(session: Session, conversion_id: int) -> FxConversion | None:
    return repo.get(session, conversion_id)


def create_conversion(
    session: Session,
    *,
    on: date,
    eur_sent: Decimal,
    usd_received: Decimal,
    fees_eur: Decimal | None = None,
    note: str | None = None,
) -> FxConversion:
    _validate(on=on, eur_sent=eur_sent, usd_received=usd_received, fees_eur=fees_eur)
    row = repo.add(
        session, on=on, eur_sent=eur_sent, usd_received=usd_received, fees_eur=fees_eur, note=note
    )
    _note_change("created", row.id, on)
    return row


def update_conversion(
    session: Session,
    conversion_id: int,
    *,
    on: date,
    eur_sent: Decimal,
    usd_received: Decimal,
    fees_eur: Decimal | None = None,
    note: str | None = None,
) -> FxConversion | None:
    """Replace a conversion's fields; ``None`` when the id does not exist."""
    _validate(on=on, eur_sent=eur_sent, usd_received=usd_received, fees_eur=fees_eur)
    row = repo.get(session, conversion_id)
    if row is None:
        return None
    updated = repo.update(
        session,
        row,
        on=on,
        eur_sent=eur_sent,
        usd_received=usd_received,
        fees_eur=fees_eur,
        note=note,
    )
    _note_change("updated", conversion_id, on)
    return updated


def delete_conversion(session: Session, conversion_id: int) -> bool:
    row = repo.get(session, conversion_id)
    if row is None:
        return False
    on = row.date
    repo.delete(session, row)
    _note_change("deleted", conversion_id, on)
    return True


def _batches(rows: Sequence[FxConversion]) -> list[fx_pool.Batch]:
    return [
        fx_pool.Batch(
            id=r.id,
            date=r.date,
            eur_sent=r.eur_sent,
            usd_received=r.usd_received,
            fees_eur=r.fees_eur if r.fees_eur is not None else Decimal(0),
        )
        for r in rows
    ]


def _ecb_lookup(session: Session) -> Callable[[date], Decimal | None]:
    rates = fx_service.get_rates(session, base="EUR", quote="USD")
    return lambda d: lookup_rate_with_forward_fill(rates, d)


def compute_pool(session: Session) -> PoolReport:
    rows = tuple(repo.list_all(session))
    deposits = repo.list_usd_contribution_deposits(session)
    result = fx_pool.match_deposits(
        _batches(rows),
        [fx_pool.UsdDeposit(id=d.id, date=d.date, usd=d.usd) for d in deposits],
        _ecb_lookup(session),
    )
    return PoolReport(conversions=rows, result=result, deposit_ids=tuple(d.id for d in deposits))


def pool_report(session: Session) -> PoolReport:
    """Remaining pool plus per-deposit matching (with fallback flags)."""
    return compute_pool(session)


def effective_eur_overrides(session: Session) -> dict[int, Decimal]:
    """Transaction id -> effective EUR cost for USD deposits.

    Empty when there are no conversions (today's behaviour is preserved).
    Deposits whose fallback had no ECB rate are left out (frozen leg stays).
    """
    if not repo.list_all(session):
        return {}
    report = compute_pool(session)
    return {m.deposit_id: m.eur_total for m in report.result.deposits if not m.rate_missing}
