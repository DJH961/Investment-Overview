"""FX conversion batches and the FIFO USD pool (plan section 2.5).

CRUD over ``fx_conversions`` plus the deposit-matching report. The ECB fallback
rate is read through :mod:`fx_service` only (cache-tier rule). Not yet wired into
XIRR/metrics: :func:`effective_eur_overrides` is the hook for that.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Literal

from sqlalchemy.orm import Session

from investment_dashboard.activity_log import activity
from investment_dashboard.domain import cash_pool, fx_pool
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
    #: Deposits marked "received in USD (no conversion)".
    received_in_usd: frozenset[int] = frozenset()


def _validate(
    *,
    on: date,
    eur_sent: Decimal,
    usd_received: Decimal,
    fees_eur: Decimal | None,
    kept_usd: Decimal = Decimal(0),
) -> None:
    if eur_sent <= 0 or usd_received <= 0:
        raise ValueError("eur_sent and usd_received must be positive")
    if fees_eur is not None and fees_eur < 0:
        raise ValueError("fees_eur must not be negative")
    if kept_usd < 0 or kept_usd > usd_received:
        raise ValueError("kept_usd must be between 0 and the dollars received")
    if on > exchange_today():
        raise ValueError("date must not be in the future")


PROVIDERS = frozenset({"wise", "revolut", "other"})


#: The pairs a conversion row may hold (7.4): EUR -> USD, and back to EUR.
PAIRS: frozenset[tuple[str, str]] = frozenset({("EUR", "USD"), ("USD", "EUR")})

Direction = Literal["to_usd", "to_eur"]


def direction_of(from_ccy: str, to_ccy: str) -> Direction:
    """``"to_eur"`` for a conversion back to euros, else ``"to_usd"``.

    A row keeps its EUR amount in ``eur_sent`` and its USD amount in
    ``usd_received`` in both directions (no migration): for a conversion back,
    ``eur_sent`` is the euros received and ``usd_received`` the dollars sent;
    ``fees_eur`` stays in euros.
    """
    return "to_eur" if (from_ccy.upper(), to_ccy.upper()) == ("USD", "EUR") else "to_usd"


def direction(row: FxConversion) -> Direction:
    return direction_of(row.from_ccy, row.to_ccy)


def _validate_pair(
    *, from_ccy: str, to_ccy: str, provider: str | None, kept_usd: Decimal = Decimal(0)
) -> None:
    if (from_ccy, to_ccy) not in PAIRS:
        raise ValueError("only EUR to USD conversions and USD back to EUR are supported")
    if direction_of(from_ccy, to_ccy) == "to_eur" and kept_usd != 0:
        raise ValueError("kept_usd applies only to EUR to USD conversions")
    if provider is not None and provider not in PROVIDERS:
        raise ValueError("provider must be wise, revolut or other")


def _note_change(action: str, conversion_id: int, on: date) -> None:
    """One ``changes.log`` line per conversion edit (B-021): id and date, never amounts."""
    activity("changes").info(
        "conversion %s: id=%s date=%s kind=fx_conversion", action, conversion_id, on.isoformat()
    )


def list_conversions(
    session: Session, *, direction: Direction | None = None
) -> Sequence[FxConversion]:
    """Every conversion row (date, id order), or only those in ``direction``."""
    rows = repo.list_all(session)
    if direction is None:
        return rows
    return [r for r in rows if direction_of(r.from_ccy, r.to_ccy) == direction]


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
    kept_usd: Decimal = Decimal(0),
    external_id: str | None = None,
) -> FxConversion:
    _validate(
        on=on, eur_sent=eur_sent, usd_received=usd_received, fees_eur=fees_eur, kept_usd=kept_usd
    )
    _validate_pair(from_ccy=from_ccy, to_ccy=to_ccy, provider=provider, kept_usd=kept_usd)
    row = repo.add(
        session,
        kept_usd=kept_usd,
        external_id=external_id,
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
    kept_usd: Decimal = Decimal(0),
) -> FxConversion | None:
    """Replace a conversion's fields; ``None`` when the id does not exist."""
    _validate(
        on=on, eur_sent=eur_sent, usd_received=usd_received, fees_eur=fees_eur, kept_usd=kept_usd
    )
    _validate_pair(from_ccy=from_ccy, to_ccy=to_ccy, provider=provider, kept_usd=kept_usd)
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
        kept_usd=kept_usd,
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
    """EUR -> USD rows only: a conversion back never fills the deposit pool."""
    return [
        fx_pool.Batch(
            id=r.id,
            date=r.date,
            eur_sent=r.eur_sent,
            usd_received=r.usd_received,
            fees_eur=r.fees_eur if r.fees_eur is not None else Decimal(0),
            kept_usd=r.kept_usd,
        )
        for r in rows
        if direction(r) == "to_usd"
    ]


def batches(session: Session) -> list[fx_pool.Batch]:
    """Every EUR -> USD conversion as a pool batch (date, id order)."""
    return _batches(repo.list_all(session))


def conversions_back(session: Session) -> list[cash_pool.ConversionBack]:
    """Every USD -> EUR conversion as a cash-pool event (date, id order)."""
    return [
        cash_pool.ConversionBack(
            id=r.id,
            date=r.date,
            from_ccy=r.from_ccy.upper(),
            sent=r.usd_received,
            eur_received=r.eur_sent,
            fees_eur=r.fees_eur if r.fees_eur is not None else Decimal(0),
        )
        for r in repo.list_all(session)
        if direction(r) == "to_eur"
    ]


def _split_pins(
    session: Session,
) -> tuple[list[fx_pool.Pin], list[fx_pool.Pin]]:
    """``(deposit pins, withdrawal pins)``: a pin on a conversion back is a withdrawal pin.

    The 7.3 pins table is reused both ways: for a conversion back,
    ``deposit_txn_id`` holds the withdrawal's transaction id.
    """
    back_ids = {r.id for r in repo.list_all(session) if direction(r) == "to_eur"}
    deposit: list[fx_pool.Pin] = []
    withdrawal: list[fx_pool.Pin] = []
    for p in repo.list_pins(session):
        pin = fx_pool.Pin(p.deposit_txn_id, p.conversion_id, p.usd)
        (withdrawal if p.conversion_id in back_ids else deposit).append(pin)
    return deposit, withdrawal


def withdrawal_pins(session: Session) -> list[fx_pool.Pin]:
    """Pins from a conversion back to a withdrawal (``deposit_id`` = the withdrawal id)."""
    return _split_pins(session)[1]


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


#: How far back a weekend or holiday conversion looks for the last settled fixing.
FIXING_LOOKBACK_DAYS = 7


def ecb_fixing_for(session: Session, on: date) -> tuple[Decimal, date] | None:
    """The fixing a conversion on ``on`` is compared with, and the date it is from.

    The fixing dated exactly ``on``; when there is none (weekend, holiday, today before
    the publication) the last settled fixing before it, at most a week back. Wise and
    Revolut convert on weekends, so "last settled before" is the fair benchmark.
    ``None`` when nothing settled is that close.
    """
    exact = fx_service.get_settled_rate_on(session, on, base="EUR", quote="USD")
    if exact is not None:
        return exact, on
    earliest = on - timedelta(days=FIXING_LOOKBACK_DAYS)
    earlier = {
        d: r
        for d, r in fx_service.get_settled_rates(session, base="EUR", quote="USD").items()
        if earliest <= d < on and r > 0
    }
    if not earlier:
        return None
    last = max(earlier)
    return earlier[last], last


def compute_pool(session: Session) -> PoolReport:
    # The deposit pool only knows EUR -> USD conversions (a conversion back is the cash
    # pool's, ``conversions_back``).
    rows = tuple(r for r in repo.list_all(session) if direction(r) == "to_usd")
    deposits = repo.list_usd_contribution_deposits(session)
    pins, _withdrawal_pins = _split_pins(session)
    marked = repo.list_usd_received_marks(session)
    result = fx_pool.match_deposits(
        _batches(rows),
        [
            fx_pool.UsdDeposit(id=d.id, date=d.date, usd=d.usd, no_conversion=d.id in marked)
            for d in deposits
        ],
        _ecb_lookup(session),
        pins,
    )
    return PoolReport(
        conversions=rows,
        result=result,
        deposit_ids=tuple(d.id for d in deposits),
        received_in_usd=frozenset(marked & {d.id for d in deposits}),
    )


def set_received_in_usd(session: Session, deposit_txn_id: int, marked: bool) -> None:
    """Mark / unmark a USD deposit as "received in USD (no conversion)"."""
    deposits = {d.id for d in repo.list_usd_contribution_deposits(session)}
    if deposit_txn_id not in deposits:
        raise ValueError("deposit is not a positive USD contribution")
    if marked:
        repo.delete_pins(session, deposit_txn_id)  # pins make no sense without a conversion
    repo.set_usd_received_mark(session, deposit_txn_id, marked)
    activity("changes").info(
        "deposit %s as received in USD: deposit=%s kind=usd_received_deposit",
        "marked" if marked else "unmarked",
        deposit_txn_id,
    )


def unconverted_deposits(report: PoolReport) -> list[fx_pool.DepositMatch]:
    """Deposits (partly) valued at the ECB rate with no conversion, not marked received in USD."""
    return [
        m
        for m in report.result.deposits
        if m.is_fallback and m.deposit_id not in report.received_in_usd
    ]


def _pinnable(rows: Mapping[int, FxConversion], cid: int, want: Direction) -> FxConversion:
    """The conversion a pin names, in the direction the pin needs (else ValueError)."""
    conv = rows.get(cid)
    if conv is None:
        raise ValueError(f"conversion {cid} not found")
    if direction(conv) != want:
        if want == "to_usd":
            raise ValueError(f"conversion {cid} goes back to euros; pin it to a withdrawal")
        raise ValueError(f"conversion {cid} is not a conversion back to euros")
    return conv


def set_pins(
    session: Session, deposit_txn_id: int, pins: Sequence[tuple[int, Decimal]]
) -> fx_pool.DepositMatch:
    """Replace a deposit's pins; ValueError (422) when they are not valid."""
    deposits = {d.id: d for d in repo.list_usd_contribution_deposits(session)}
    dep = deposits.get(deposit_txn_id)
    if dep is None:
        raise ValueError("deposit is not a positive USD contribution")
    if pins and deposit_txn_id in repo.list_usd_received_marks(session):
        raise ValueError("deposit is marked as received in USD (no conversion); unmark it first")
    rows = {r.id: r for r in repo.list_all(session)}
    seen: set[int] = set()
    total = Decimal(0)
    for cid, usd in pins:
        conv = _pinnable(rows, cid, "to_usd")
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


def set_withdrawal_pins(
    session: Session, withdrawal_txn_id: int, pins: Sequence[tuple[int, Decimal]]
) -> None:
    """Replace a withdrawal's pins to conversions back (``(conversion_id, usd)`` pairs).

    Reuses the 7.3 pins table with ``deposit_txn_id`` = the withdrawal id. A pin
    names a conversion back dated on or after the withdrawal, for at most the
    withdrawal's dollars; a conversion back is never pinned for more than it sent.
    ValueError (422) when they are not valid.
    """
    withdrawals = {w.id: w for w in repo.list_usd_withdrawals(session)}
    wd = withdrawals.get(withdrawal_txn_id)
    if wd is None:
        raise ValueError("transaction is not a USD withdrawal")
    rows = {r.id: r for r in repo.list_all(session)}
    seen: set[int] = set()
    total = Decimal(0)
    for cid, usd in pins:
        conv = _pinnable(rows, cid, "to_eur")
        if cid in seen:
            raise ValueError("a conversion can be pinned only once per withdrawal")
        seen.add(cid)
        if usd <= 0:
            raise ValueError("pin amount must be positive")
        if conv.date < wd.date:
            raise ValueError("the conversion back is dated before the withdrawal")
        total += usd
    if total > wd.usd:
        raise ValueError("withdrawal is pinned for more than its amount")
    others: dict[int, Decimal] = {}
    for p in repo.list_pins(session):
        if p.deposit_txn_id != withdrawal_txn_id:
            others[p.conversion_id] = others.get(p.conversion_id, Decimal(0)) + p.usd
    for cid, usd in pins:
        if others.get(cid, Decimal(0)) + usd > rows[cid].usd_received:
            raise ValueError("conversion is pinned for more than it sent")
    repo.replace_pins(session, withdrawal_txn_id, list(pins))
    activity("changes").info(
        "conversion pins set: withdrawal=%s pins=%d kind=fx_conversion_pin",
        withdrawal_txn_id,
        len(pins),
    )


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
    if not _batches(repo.list_all(session)):
        return {}
    report = compute_pool(session)
    return {m.deposit_id: m.eur_total for m in report.result.deposits if not m.rate_missing}
