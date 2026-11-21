"""FX conversion batches and the FIFO USD pool (plan section 2.5).

CRUD over ``fx_conversions`` plus the deposit-matching report. The ECB fallback
rate is read through :mod:`fx_service` only (cache-tier rule). Not yet wired into
XIRR/metrics: :func:`effective_eur_overrides` is the hook for that.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy.orm import Session

from investment_dashboard.activity_log import activity
from investment_dashboard.domain import fx_pool
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


PROVIDERS = frozenset({"wise", "revolut", "other"})


def _validate_pair(*, from_ccy: str, to_ccy: str, provider: str | None) -> None:
    if (from_ccy, to_ccy) != ("EUR", "USD"):
        raise ValueError("only EUR to USD conversions are supported")
    if provider is not None and provider not in PROVIDERS:
        raise ValueError("provider must be wise, revolut or other")


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
    provider: str | None = None,
    from_ccy: str = "EUR",
    to_ccy: str = "USD",
) -> FxConversion:
    _validate(on=on, eur_sent=eur_sent, usd_received=usd_received, fees_eur=fees_eur)
    _validate_pair(from_ccy=from_ccy, to_ccy=to_ccy, provider=provider)
    row = repo.add(
        session,
        on=on,
        eur_sent=eur_sent,
        usd_received=usd_received,
        fees_eur=fees_eur,
        note=note,
        provider=provider,
        from_ccy=from_ccy,
        to_ccy=to_ccy,
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
    provider: str | None = None,
    from_ccy: str = "EUR",
    to_ccy: str = "USD",
) -> FxConversion | None:
    """Replace a conversion's fields; ``None`` when the id does not exist."""
    _validate(on=on, eur_sent=eur_sent, usd_received=usd_received, fees_eur=fees_eur)
    _validate_pair(from_ccy=from_ccy, to_ccy=to_ccy, provider=provider)
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
        provider=provider,
        from_ccy=from_ccy,
        to_ccy=to_ccy,
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
    """The *settled* fixing (never today's live spot, B-011 class), memoised per date."""
    memo: dict[date, Decimal | None] = {}

    def lookup(d: date) -> Decimal | None:
        if d not in memo:
            memo[d] = fx_service.get_settled_rate(session, d, base="EUR", quote="USD")
        return memo[d]

    return lookup


def ecb_rate_on(session: Session, on: date) -> Decimal | None:
    """The settled fixing dated exactly on (no forward fill); ``None`` = not published."""
    return fx_service.get_settled_rate_on(session, on, base="EUR", quote="USD")


def compute_pool(session: Session) -> PoolReport:
    rows = tuple(repo.list_all(session))
    deposits = repo.list_usd_contribution_deposits(session)
    pins = [fx_pool.Pin(p.deposit_txn_id, p.conversion_id, p.usd) for p in repo.list_pins(session)]
    result = fx_pool.match_deposits(
        _batches(rows),
        [fx_pool.UsdDeposit(id=d.id, date=d.date, usd=d.usd) for d in deposits],
        _ecb_lookup(session),
        pins,
    )
    return PoolReport(conversions=rows, result=result, deposit_ids=tuple(d.id for d in deposits))


def set_pins(
    session: Session, deposit_txn_id: int, pins: Sequence[tuple[int, Decimal]]
) -> fx_pool.DepositMatch:
    """Replace a deposit's pins; ValueError (422) when they are not valid."""
    deposits = {d.id: d for d in repo.list_usd_contribution_deposits(session)}
    dep = deposits.get(deposit_txn_id)
    if dep is None:
        raise ValueError("deposit is not a positive USD contribution")
    rows = {r.id: r for r in repo.list_all(session)}
    seen: set[int] = set()
    total = Decimal(0)
    for cid, usd in pins:
        conv = rows.get(cid)
        if conv is None:
            raise ValueError(f"conversion {cid} not found")
        if cid in seen:
            raise ValueError("a conversion can be pinned only once per deposit")
        seen.add(cid)
        if usd <= 0:
            raise ValueError("pin amount must be positive")
        if conv.date > dep.date + timedelta(days=fx_pool.PIN_WINDOW_DAYS):
            raise ValueError("conversion is dated more than 7 days after the deposit")
        total += usd
    if total > dep.usd:
        raise ValueError("deposit is pinned for more than its amount")
    others: dict[int, Decimal] = {}
    for p in repo.list_pins(session):
        if p.deposit_txn_id != deposit_txn_id:
            others[p.conversion_id] = others.get(p.conversion_id, Decimal(0)) + p.usd
    for cid, usd in pins:
        if others.get(cid, Decimal(0)) + usd > rows[cid].usd_received:
            raise ValueError("conversion is pinned for more than its amount")
    repo.replace_pins(session, deposit_txn_id, list(pins))
    activity("changes").info(
        "conversion pins set: deposit=%s pins=%d kind=fx_conversion_pin", deposit_txn_id, len(pins)
    )
    return deposit_match(session, deposit_txn_id)


def clear_pins(session: Session, deposit_txn_id: int) -> None:
    removed = repo.delete_pins(session, deposit_txn_id)
    activity("changes").info(
        "conversion pins cleared: deposit=%s pins=%d kind=fx_conversion_pin",
        deposit_txn_id,
        removed,
    )


def deposit_match(session: Session, deposit_txn_id: int) -> fx_pool.DepositMatch:
    report = compute_pool(session)
    for m in report.result.deposits:
        if m.deposit_id == deposit_txn_id:
            return m
    raise ValueError("deposit is not a positive USD contribution")


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
