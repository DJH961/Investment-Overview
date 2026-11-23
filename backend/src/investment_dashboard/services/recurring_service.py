"""Recurring plans for buys and conversions, with estimated rows (7.3, P14).

A plan is a schedule (:mod:`domain.recurrence`). The end-of-day job calls
:func:`generate_due_estimates`: every due date whose close (buy) or ECB fixing
(conversion) has settled becomes an ordinary ledger row flagged ``is_estimate``, written
through the same paths as manual entry (``transaction_edit_service`` /
``fx_conversion_service``) so caches, snapshots and live ticks see it at once. There is
no "did it run?" prompt: the owner later *settles* the row, either by importing the
broker file (the import code calls :func:`confirm_estimate`) or by typing what they got
(:func:`settle`).

One row per ``(plan, due date)``: checked before writing and enforced by a unique
constraint. ``recurring_plans.generated_through`` remembers how far a plan was handled,
so an est. row the owner deleted is not written again.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy.orm import Session

from investment_dashboard.activity_log import activity
from investment_dashboard.domain import recurrence, recurrence_suggest
from investment_dashboard.domain.kinds import TransactionSource
from investment_dashboard.domain.market_hours import exchange_today, latest_settled_session_date
from investment_dashboard.domain.money_market import (
    MANUAL_SETTLEMENT_DESCRIPTION_PREFIX,
    is_money_market,
    is_settlement_external_id,
    settlement_external_id_for,
)
from investment_dashboard.errors import NotFoundError, ValidationError
from investment_dashboard.repositories import accounts_repo, instruments_repo, transactions_repo
from investment_dashboard.repositories import recurring_repo as repo
from investment_dashboard.services import (
    fx_conversion_service,
    fx_cost_service,
    manual_entry,
    prices_service,
    transaction_edit_service,
    transaction_fx_service,
)

if TYPE_CHECKING:
    from investment_dashboard.models import Account, FxConversion, RecurringPlan, Transaction

KINDS = frozenset({"buy", "deposit", "conversion"})
#: Conversion plans default to Revolut (the owner's automation).
DEFAULT_PROVIDER = "revolut"
PROVIDERS = fx_conversion_service.PROVIDERS
#: A close this many days behind the latest settled session is taken forward-filled
#: instead of waiting forever for a provider that never delivers it.
CLOSE_PATIENCE_DAYS = 10
#: Days an ECB fixing may lag before a weekday due date falls back to the last fixing.
FIXING_PATIENCE_DAYS = 4
_WEEKDAYS = 5
_EST_NOTE = "est. (recurring plan)"


class RecurringError(ValidationError):
    """The plan or the settle request is invalid (HTTP 422)."""


class PlanNotFoundError(NotFoundError):
    """No plan with that id."""


@dataclass(frozen=True)
class PlanInput:
    kind: str
    unit: str
    every: int
    start_date: date
    anchor: int | None = None
    end_date: date | None = None
    account_id: int | None = None
    instrument_id: int | None = None
    amount: Decimal | None = None
    shares: Decimal | None = None
    provider: str | None = None
    expected_fee: Decimal | None = None


@dataclass(frozen=True)
class SettleItem:
    """One row to settle. All figures ``None`` = accept the estimate as it is."""

    kind: str  # "transaction" | "fx_conversion"
    id: int
    price: Decimal | None = None
    quantity: Decimal | None = None
    total: Decimal | None = None
    fees: Decimal | None = None
    sent: Decimal | None = None
    received: Decimal | None = None


@dataclass
class GenerationReport:
    created: int = 0
    pending: int = 0
    plans: list[int] = field(default_factory=list)


def account_name(account: Account) -> str:
    """ "Fidelity Main Brokerage": the broker key made readable, then the account label."""
    return f"{account.broker.replace('_', ' ').title()} {account.account_label}"


def _log(action: str, plan_id: int, kind: str) -> None:
    """One ``changes.log`` line per plan edit: id and kind, never amounts."""
    activity("changes").info("recurring plan %s: id=%s kind=%s", action, plan_id, kind)


def _cadence(unit: str, every: int, anchor: int | None) -> recurrence.Cadence:
    try:
        return recurrence.Cadence(unit, every, anchor)
    except ValueError as exc:
        raise RecurringError(str(exc)) from exc


def _validate(session: Session, data: PlanInput) -> None:  # noqa: PLR0912 - one flat rule list
    if data.kind not in KINDS:
        raise RecurringError("kind must be buy, deposit or conversion")
    _cadence(data.unit, data.every, data.anchor)
    if data.end_date is not None and data.end_date < data.start_date:
        raise RecurringError("the end date is before the start date")
    if data.amount is not None and data.amount <= 0:
        raise RecurringError("amount must be positive")
    if data.shares is not None and data.shares <= 0:
        raise RecurringError("shares must be positive")
    if data.expected_fee is not None and data.expected_fee < 0:
        raise RecurringError("expected fee must not be negative")
    if data.kind == "buy":
        if data.account_id is None or accounts_repo.get_account(session, data.account_id) is None:
            raise RecurringError("a buy plan needs an account")
        if (
            data.instrument_id is None
            or instruments_repo.get_instrument(session, data.instrument_id) is None
        ):
            raise RecurringError("a buy plan needs an instrument")
        if (data.amount is None) == (data.shares is None):
            raise RecurringError("a buy plan needs an amount or shares, not both")
    elif data.kind == "deposit":
        if data.account_id is None or accounts_repo.get_account(session, data.account_id) is None:
            raise RecurringError("a deposit plan needs an account")
        if data.amount is None:
            raise RecurringError("a deposit plan needs a USD amount")
    else:
        if data.amount is None:
            raise RecurringError("a conversion plan needs an EUR amount")
        if data.provider is not None and data.provider not in PROVIDERS:
            raise RecurringError("provider must be wise, revolut or other")


def _fields(data: PlanInput) -> dict[str, object]:
    buy = data.kind == "buy"
    conv = data.kind == "conversion"
    return {
        "kind": data.kind,
        "unit": data.unit,
        "every": data.every,
        "anchor": data.anchor,
        "start_date": data.start_date,
        "end_date": data.end_date,
        "account_id": None if conv else data.account_id,
        "instrument_id": data.instrument_id if buy else None,
        "amount": data.amount,
        "shares": data.shares if buy else None,
        "provider": (data.provider or DEFAULT_PROVIDER) if conv else None,
        "expected_fee": data.expected_fee if conv else None,
    }


def last_fee_for_provider(session: Session, provider: str) -> Decimal | None:
    """The fee of the latest real (non-estimated) conversion with ``provider``."""
    real = repo.list_real_conversions(session, provider)
    return real[-1].fees_eur if real else None


def list_plans(session: Session) -> Sequence[RecurringPlan]:
    return repo.list_plans(session)


def get_plan(session: Session, plan_id: int) -> RecurringPlan:
    plan = repo.get_plan(session, plan_id)
    if plan is None:
        raise PlanNotFoundError(f"Plan {plan_id} not found")
    return plan


def create_plan(session: Session, data: PlanInput) -> RecurringPlan:
    _validate(session, data)
    fields = _fields(data)
    if data.kind == "conversion" and data.expected_fee is None:
        fields["expected_fee"] = last_fee_for_provider(session, str(fields["provider"]))
    plan = repo.add_plan(session, **fields)
    _log("created", plan.id, plan.kind)
    return plan


def update_plan(session: Session, plan_id: int, data: PlanInput) -> RecurringPlan:
    plan = get_plan(session, plan_id)
    if data.kind != plan.kind:
        raise RecurringError("a plan's kind cannot change")
    _validate(session, data)
    repo.update_plan(session, plan, **_fields(data))
    _log("updated", plan.id, plan.kind)
    return plan


def pause_plan(session: Session, plan_id: int) -> RecurringPlan:
    """Stop new est. rows; already generated ones stay."""
    plan = get_plan(session, plan_id)
    repo.update_plan(session, plan, paused=True)
    _log("paused", plan.id, plan.kind)
    return plan


def resume_plan(session: Session, plan_id: int, *, today: date | None = None) -> RecurringPlan:
    """Resume; due dates that fell inside the pause are not made up."""
    plan = get_plan(session, plan_id)
    day = today or exchange_today()
    skip_to = max(plan.generated_through or date.min, day - timedelta(days=1))
    repo.update_plan(session, plan, paused=False, generated_through=skip_to)
    _log("resumed", plan.id, plan.kind)
    return plan


def end_plan(session: Session, plan_id: int, *, today: date | None = None) -> RecurringPlan:
    """End the plan today (or on its start date if that is later). Rows stay."""
    plan = get_plan(session, plan_id)
    day = max(today or exchange_today(), plan.start_date)
    repo.update_plan(session, plan, end_date=day)
    _log("ended", plan.id, plan.kind)
    return plan


def delete_plan(session: Session, plan_id: int) -> None:
    """Delete a plan; the rows it generated stay (their plan link goes ``NULL``)."""
    plan = get_plan(session, plan_id)
    kind = plan.kind
    repo.delete_plan(session, plan)
    _log("deleted", plan_id, kind)


def next_due(plan: RecurringPlan, *, today: date | None = None) -> date | None:
    """The next due date on or after today not yet handled (``None``: ended or paused)."""
    if plan.paused:
        return None
    day = today or exchange_today()
    after = max(plan.generated_through or date.min, day - timedelta(days=1))
    c = _cadence(plan.unit, plan.every, plan.anchor)
    return recurrence.next_due(c, start=plan.start_date, end=plan.end_date, after=after)


# --------------------------------------------------------------------- generation


def _generate_buy(session: Session, plan: RecurringPlan, due: date, settled: date) -> bool | None:
    """Write the est. buy for ``due``. ``None`` = its close is not settled yet."""
    assert plan.account_id is not None
    assert plan.instrument_id is not None
    day = recurrence.roll_to_session(due)
    if day > settled:
        return None
    closes = prices_service.closes_for_instrument(session, plan.instrument_id)
    close = closes.get(day)
    if close is None:
        if day > settled - timedelta(days=CLOSE_PATIENCE_DAYS):
            return None
        close = prices_service.close_as_of(session, plan.instrument_id, day)
        if close is None:
            return None
    instrument = instruments_repo.get_instrument(session, plan.instrument_id)
    assert instrument is not None
    qty, total = recurrence.buy_figures(close=close, amount=plan.amount, shares=plan.shares)
    result = transaction_edit_service.create(
        session,
        transaction_edit_service.TransactionInput(
            account_id=plan.account_id,
            date=day,
            kind="buy",
            symbol=instrument.symbol,
            quantity=qty.quantize(Decimal("0.00000001")),
            price=close,
            total=total,
            fees=Decimal(0),
            description=_EST_NOTE,
        ),
    )
    repo.mark_estimate(result.transaction, plan.id, due)
    leg = _write_settlement_leg(session, result.transaction)
    if leg is not None:
        leg.is_estimate = True  # follows its buy: confirmed with it, never counted on its own
    session.flush()
    return True


def has_settlement_fund(session: Session, account_id: int) -> bool:
    return transactions_repo.find_account_money_market_instrument(session, account_id) is not None


def _write_settlement_leg(session: Session, parent: Transaction) -> Transaction | None:
    """The core-fund draw the broker import books for a real buy (same row shape).

    Cash out ``N`` sells ``N`` fund shares at the $1.00 NAV (``quantity = -N``,
    ``net_native = +N``), linked to its parent by the ``:vmfxx`` external-id
    convention, exactly like the importers and ``resync_settlement_leg``. ``None`` when
    the account holds no settlement fund (the buy then stands alone).
    """
    values = manual_entry.settlement_leg_values(parent.net_native)
    fund = transactions_repo.find_account_money_market_instrument(session, parent.account_id)
    account = accounts_repo.get_account(session, parent.account_id)
    if values is None or fund is None or account is None:
        return None
    if parent.external_id is None:
        parent.external_id = f"manual:{parent.id}"
        session.flush()
    legs = transaction_fx_service.compute_legs(
        session,
        native_currency=account.native_currency,
        net_native=values.net_native,
        on=parent.date,
    )
    txn = transactions_repo.new_transaction(
        account_id=parent.account_id,
        date=parent.date,
        kind=values.kind,
        instrument_id=fund.id,
        quantity=values.quantity,
        price_native=values.price,
        net_native=values.net_native,
        fx_rate_to_eur=legs.fx_rate_to_eur,
        net_eur=legs.net_eur,
        net_usd=legs.net_usd,
        description=f"{MANUAL_SETTLEMENT_DESCRIPTION_PREFIX} · {fund.symbol}",
        external_id=settlement_external_id_for(parent.external_id),
        source=TransactionSource.MANUAL,
    )
    return transactions_repo.insert_transaction(session, txn)


def _find_leg(session: Session, parent: Transaction) -> Transaction | None:
    return transaction_edit_service.find_existing_settlement_leg(
        session,
        account_id=parent.account_id,
        external_id=parent.external_id,
        on=parent.date,
        net_native=parent.net_native,
    )


def _generate_deposit(session: Session, plan: RecurringPlan, due: date, today: date) -> bool | None:
    """Write the est. deposit for ``due``: the shape the broker import gives a real one.

    A cash deposit with its core-fund buy leg (``route_money_market``), dated the due
    date itself. A deposit needs no input, so it never counts as a row to settle (see
    ``recurring_repo.NEEDS_NO_INPUT_KINDS``); it keeps the plan link so a later import
    updates it instead of duplicating it.
    """
    assert plan.account_id is not None
    assert plan.amount is not None
    if due > today:
        return None
    result = transaction_edit_service.create(
        session,
        transaction_edit_service.TransactionInput(
            account_id=plan.account_id,
            date=due,
            kind="deposit",
            total=plan.amount,
            description=_EST_NOTE,
            route_money_market=True,
        ),
    )
    repo.mark_estimate(result.transaction, plan.id, due)
    leg = _find_leg(session, result.transaction)
    if leg is not None and leg.id != result.transaction.id:
        leg.is_estimate = True
    session.flush()
    return True


def _generate_conversion(
    session: Session, plan: RecurringPlan, due: date, today: date
) -> bool | None:
    """Write the est. conversion for ``due``. ``None`` = its ECB fixing is not settled yet."""
    assert plan.amount is not None
    assert plan.provider is not None
    if due > today:
        return None
    fixing = fx_conversion_service.ecb_fixing_for(session, due)
    if fixing is None:
        return None
    ecb, fixing_day = fixing
    if (
        fixing_day != due
        and due.weekday() < _WEEKDAYS
        and (today - due).days < FIXING_PATIENCE_DAYS
    ):
        return None  # a weekday whose own fixing has not been published yet
    avg = fx_cost_service.provider_avg_off_pct(session, plan.provider)
    fee = plan.expected_fee
    if fee is None:
        fee = last_fee_for_provider(session, plan.provider)
    _, usd = recurrence.estimated_conversion(eur_sent=plan.amount, ecb_rate=ecb, avg_off_pct=avg)
    row = fx_conversion_service.create_conversion(
        session,
        on=due,
        eur_sent=plan.amount,
        usd_received=usd.quantize(Decimal("0.000001")),
        fees_eur=fee,
        note=_EST_NOTE,
        provider=plan.provider,
    )
    repo.mark_estimate(row, plan.id, due)
    session.flush()
    return True


def generate_due_estimates(
    session: Session, *, today: date | None = None, settled: date | None = None
) -> GenerationReport:
    """Add the est. row of every due date that has settled, catching up all missed ones.

    Idempotent. A due date that is not settled yet stops that plan's catch-up (later
    dates wait their turn, so a plan never skips ahead of itself).
    """
    today = today or exchange_today()
    settled = settled or latest_settled_session_date()
    report = GenerationReport()
    for plan in repo.list_plans(session):
        if plan.paused:
            continue
        lo = (
            plan.generated_through + timedelta(days=1)
            if plan.generated_through is not None
            else plan.start_date
        )
        cadence = _cadence(plan.unit, plan.every, plan.anchor)
        dues = recurrence.due_dates(
            cadence, start=plan.start_date, end=plan.end_date, window_from=lo, window_to=today
        )
        handled: date | None = None
        made = 0
        for due in dues:
            if repo.estimate_exists(session, plan.id, due):
                handled = due
                continue
            if plan.kind == "buy":
                wrote = _generate_buy(session, plan, due, settled)
            elif plan.kind == "deposit":
                wrote = _generate_deposit(session, plan, due, today)
            else:
                wrote = _generate_conversion(session, plan, due, today)
            if wrote is None:
                report.pending += 1
                break
            made += 1
            handled = due
        if handled is not None:
            repo.update_plan(session, plan, generated_through=handled)
        if made:
            report.created += made
            report.plans.append(plan.id)
    if report.created:
        activity("market_data").info(
            "recurring plans: %s estimated row(s) added at settled prices", report.created
        )
    return report


# ----------------------------------------------------------------------- settling


def estimate_count(session: Session) -> int:
    return repo.count_estimates(session)


def list_estimates(session: Session) -> tuple[Sequence[Transaction], Sequence[FxConversion]]:
    return repo.list_estimate_transactions(session), repo.list_estimate_conversions(session)


def confirm_estimate(session: Session, row: Transaction | FxConversion) -> bool:
    """Clear the **est.** flag of ``row`` (it was settled by an import or typed figures).

    The plan link and due date stay, so the (plan, due date) slot remains taken and the
    plan never writes that date again. ``False`` when the row was not an estimate.
    """
    if not row.is_estimate:
        return False
    row.is_estimate = False
    if not hasattr(row, "eur_sent"):  # a buy: its core-fund leg is confirmed with it
        leg = _find_leg(session, row)  # type: ignore[arg-type]
        if leg is not None and leg.id != row.id:
            leg.is_estimate = False
    session.flush()
    activity("changes").info(
        "estimate settled: %s id=%s date=%s",
        "conversion" if hasattr(row, "eur_sent") else "transaction",
        row.id,
        row.date.isoformat(),
    )
    return True


def _settle_transaction(session: Session, item: SettleItem) -> None:
    row = repo.get_transaction(session, item.id)
    if row is None or not row.is_estimate:
        raise RecurringError(f"Transaction {item.id} is not an estimated row")
    if any(v is not None for v in (item.price, item.quantity, item.total, item.fees)):
        instrument = instruments_repo.get_instrument(session, row.instrument_id or 0)
        quantity, price = item.quantity, item.price
        if item.total is None:
            quantity = quantity if quantity is not None else abs(row.quantity or Decimal(0))
            price = price if price is not None else row.price_native
        elif quantity is None and price is None:
            quantity = abs(row.quantity or Decimal(0))
        try:
            transaction_edit_service.update(
                session,
                row.id,
                transaction_edit_service.TransactionInput(
                    account_id=row.account_id,
                    date=row.date,
                    kind=row.kind,
                    symbol=instrument.symbol if instrument else None,
                    quantity=quantity,
                    price=price,
                    total=item.total,
                    fees=item.fees if item.fees is not None else row.fees_native,
                    description=row.description,
                ),
            )
        except transaction_edit_service.TransactionEditError as exc:
            raise RecurringError(str(exc)) from exc
    confirm_estimate(session, row)


def _settle_conversion(session: Session, item: SettleItem) -> None:
    row = repo.get_conversion(session, item.id)
    if row is None or not row.is_estimate:
        raise RecurringError(f"Conversion {item.id} is not an estimated row")
    if any(v is not None for v in (item.sent, item.received, item.fees)):
        try:
            fx_conversion_service.update_conversion(
                session,
                row.id,
                on=row.date,
                eur_sent=item.sent if item.sent is not None else row.eur_sent,
                usd_received=item.received if item.received is not None else row.usd_received,
                fees_eur=item.fees if item.fees is not None else row.fees_eur,
                note=row.note,
                provider=row.provider,
            )
        except ValueError as exc:
            raise RecurringError(str(exc)) from exc
    confirm_estimate(session, row)


def settle(
    session: Session, items: Sequence[SettleItem] = (), *, due_date: date | None = None
) -> int:
    """Settle the given rows and/or every est. row of ``due_date`` (accepted as they are).

    Returns how many rows were settled. Typed figures replace the estimate's (linked
    fields are recomputed by the client; the server re-checks them like manual entry).
    """
    count = 0
    for item in items:
        if item.kind == "transaction":
            _settle_transaction(session, item)
        elif item.kind == "fx_conversion":
            _settle_conversion(session, item)
        else:
            raise RecurringError("kind must be transaction or fx_conversion")
        count += 1
    if due_date is not None:
        for txn in repo.list_estimate_transactions(session, due=due_date):
            confirm_estimate(session, txn)
            count += 1
        for conv in repo.list_estimate_conversions(session, due=due_date):
            confirm_estimate(session, conv)
            count += 1
    activity("changes").info("recurring estimates settled: count=%s", count)
    return count


# ------------------------------------------------------------------------- views


@dataclass(frozen=True)
class PlanView:
    plan: RecurringPlan
    status: str  # "active" | "paused" | "ended"
    account: str | None
    symbol: str | None
    next_due: date | None
    #: A one-line caution for the list (a buy plan whose account has no settlement fund).
    note: str | None = None


NO_FUND_NOTE = (
    "No settlement fund in this account: cash will go negative until the deposit is imported."
)


@dataclass(frozen=True)
class EstimateView:
    row_type: str  # "transaction" | "fx_conversion"
    id: int
    plan_id: int | None
    due_date: date | None
    date: date
    label: str  # account for a buy, provider for a conversion
    symbol: str | None
    currency: str | None
    price: Decimal | None
    quantity: Decimal | None
    total: Decimal | None
    fees: Decimal | None
    sent: Decimal | None
    received: Decimal | None
    #: Decimals the ledger really holds for this account + instrument (what a stepper moves).
    price_dp: int = 4
    quantity_dp: int = 4


#: Stepper precision when an account + instrument has no history (the plan's 0.0001).
DEFAULT_STEP_DP = 4
_MAX_DP = 8


def _dp(value: Decimal | None) -> int:
    if value is None:
        return 0
    exponent = value.normalize().as_tuple().exponent
    return max(0, -int(exponent)) if isinstance(exponent, int) else 0


def ledger_precision(session: Session, account_id: int, instrument_id: int) -> tuple[int, int]:
    """``(price_dp, quantity_dp)``: the finest precision seen in earlier real trades.

    Looks at settled (non-estimated) buys, sells and reinvestments of the account +
    instrument, so a Fidelity price at 4-6 decimals or a Vanguard quantity at 4 steps by
    the digit the broker really reports. Falls back to :data:`DEFAULT_STEP_DP`.
    """
    price_dp = qty_dp = 0
    for t in transactions_repo.list_transactions(
        session,
        account_id=account_id,
        instrument_id=instrument_id,
        kinds=("buy", "sell", "reinvest"),
    ):
        if t.is_estimate:
            continue
        price_dp = max(price_dp, _dp(t.price_native))
        qty_dp = max(qty_dp, _dp(abs(t.quantity) if t.quantity is not None else None))
    return (
        min(price_dp, _MAX_DP) if price_dp else DEFAULT_STEP_DP,
        min(qty_dp, _MAX_DP) if qty_dp else DEFAULT_STEP_DP,
    )


@dataclass(frozen=True)
class Suggestion:
    kind: str
    cadence: recurrence_suggest.CadenceSuggestion
    account_id: int | None = None
    account: str | None = None
    instrument_id: int | None = None
    symbol: str | None = None
    provider: str | None = None


#: How far back the "Set up your routine" flow looks for a rhythm.
SUGGEST_LOOKBACK_DAYS = 120


def suggest_routine(  # noqa: PLR0912 - three independent collectors, narrated in order
    session: Session, *, today: date | None = None
) -> list[Suggestion]:
    """Plans the recent ledger looks like (deposits, buys, conversions). Suggestions only."""
    day = today or exchange_today()
    since = day - timedelta(days=SUGGEST_LOOKBACK_DAYS)
    deposits: dict[int, list[recurrence_suggest.Observation]] = {}
    buys: dict[tuple[int, int], list[recurrence_suggest.Observation]] = {}
    names: dict[int, str] = {}
    symbols: dict[int, str] = {}
    for t in transactions_repo.list_transactions(session, start=since, end=day):
        if t.is_estimate or is_settlement_external_id(t.external_id):
            continue
        if t.kind == "deposit" and t.net_native is not None and t.net_native > 0:
            deposits.setdefault(t.account_id, []).append(
                recurrence_suggest.Observation(t.date, t.net_native)
            )
        elif t.kind == "buy" and t.instrument_id is not None and t.gross_native:
            inst = instruments_repo.get_instrument(session, t.instrument_id)
            if inst is None or is_money_market(
                inst.symbol, asset_class=inst.asset_class, name=inst.name
            ):
                continue
            symbols[t.instrument_id] = inst.symbol
            buys.setdefault((t.account_id, t.instrument_id), []).append(
                recurrence_suggest.Observation(t.date, abs(t.gross_native))
            )

    def name_of(account_id: int) -> str:
        if account_id not in names:
            a = accounts_repo.get_account(session, account_id)
            names[account_id] = account_name(a) if a else ""
        return names[account_id]

    out: list[Suggestion] = []
    for account_id, obs in deposits.items():
        s = recurrence_suggest.suggest_cadence(obs)
        if s is not None:
            out.append(Suggestion("deposit", s, account_id=account_id, account=name_of(account_id)))
    for (account_id, instrument_id), obs in buys.items():
        s = recurrence_suggest.suggest_cadence(obs)
        if s is not None:
            out.append(
                Suggestion(
                    "buy",
                    s,
                    account_id=account_id,
                    account=name_of(account_id),
                    instrument_id=instrument_id,
                    symbol=symbols[instrument_id],
                )
            )
    by_provider: dict[str, list[recurrence_suggest.Observation]] = {}
    for c in fx_conversion_service.list_conversions(session):
        if not c.is_estimate and since <= c.date <= day:
            by_provider.setdefault(c.provider or DEFAULT_PROVIDER, []).append(
                recurrence_suggest.Observation(c.date, c.eur_sent)
            )
    for provider, obs in by_provider.items():
        s = recurrence_suggest.suggest_cadence(obs)
        if s is not None:
            out.append(Suggestion("conversion", s, provider=provider))
    return out


@dataclass(frozen=True)
class ReminderGroup:
    """One line of the quiet reminder: a plan's est. rows and what input they need."""

    plan_id: int | None
    kind: str  # "buy" | "conversion"
    count: int
    input: str  # "type" (conversions) | "import" (buys; typing stays available)
    message: str
    row_ids: tuple[tuple[str, int], ...]


def _cadence_word(plan: RecurringPlan | None) -> str:
    if plan is None:
        return "Recurring"
    if plan.every == 1:
        return {"days": "Daily", "weeks": "Weekly", "months": "Monthly"}[plan.unit]
    return f"Every {plan.every} {plan.unit}"


def reminder_groups(session: Session) -> list[ReminderGroup]:
    """The estimated rows grouped by plan, each with a plain sentence saying what to do.

    One line per plan, never per row; deposits never appear (they need no input).
    """
    buckets: dict[tuple[int | None, str], list[EstimateView]] = {}
    for v in estimate_views(session):
        buckets.setdefault((v.plan_id, v.row_type), []).append(v)
    out: list[ReminderGroup] = []
    for (plan_id, row_type), views in buckets.items():
        plan = repo.get_plan(session, plan_id) if plan_id is not None else None
        n = len(views)
        refs = tuple((v.row_type, v.id) for v in views)
        if row_type == "fx_conversion":
            provider = (views[0].label or "").title() or "Conversion"
            if n == 1:
                on = views[0].date
                message = (
                    f"{provider} conversion, {on.day} {on.strftime('%b')}: type what you received"
                )
            else:
                message = f"{provider} conversions: {n} to settle: type what you received"
            out.append(ReminderGroup(plan_id, "conversion", n, "type", message, refs))
        else:
            broker = (views[0].label.split(" ")[0] if views[0].label else "").title()
            title = f"{_cadence_word(plan)} buys" + (f" ({broker})" if broker else "")
            file_hint = f"import your {broker} file" if broker else "import your broker file"
            message = f"{title}: {n} to settle. {file_hint[0].upper()}{file_hint[1:]}, or type them"
            out.append(ReminderGroup(plan_id, "buy", n, "import", message, refs))
    return out


def plan_view(session: Session, plan: RecurringPlan, *, today: date | None = None) -> PlanView:
    day = today or exchange_today()
    account = accounts_repo.get_account(session, plan.account_id) if plan.account_id else None
    instrument = (
        instruments_repo.get_instrument(session, plan.instrument_id) if plan.instrument_id else None
    )
    nxt = next_due(plan, today=day)
    if plan.paused:
        status = "paused"
    elif nxt is None:
        status = "ended"
    else:
        status = "active"
    return PlanView(
        plan=plan,
        status=status,
        account=account_name(account) if account else None,
        symbol=instrument.symbol if instrument else None,
        next_due=nxt,
        note=(
            NO_FUND_NOTE
            if plan.kind == "buy"
            and plan.account_id is not None
            and not has_settlement_fund(session, plan.account_id)
            else None
        ),
    )


def estimate_views(session: Session) -> list[EstimateView]:
    """Every est. row to settle, newest first (buys and conversions together)."""
    txns, convs = list_estimates(session)
    out: list[EstimateView] = []
    for t in txns:
        account = accounts_repo.get_account(session, t.account_id)
        instrument = instruments_repo.get_instrument(session, t.instrument_id or 0)
        out.append(
            EstimateView(
                row_type="transaction",
                id=t.id,
                plan_id=t.estimate_plan_id,
                due_date=t.estimate_due_date,
                date=t.date,
                label=account_name(account) if account else "",
                symbol=instrument.symbol if instrument else None,
                currency=account.native_currency if account else None,
                price=t.price_native,
                quantity=abs(t.quantity) if t.quantity is not None else None,
                total=t.gross_native,
                fees=t.fees_native,
                sent=None,
                received=None,
                price_dp=ledger_precision(session, t.account_id, t.instrument_id or 0)[0],
                quantity_dp=ledger_precision(session, t.account_id, t.instrument_id or 0)[1],
            )
        )
    out.extend(
        EstimateView(
            row_type="fx_conversion",
            id=c.id,
            plan_id=c.estimate_plan_id,
            due_date=c.estimate_due_date,
            date=c.date,
            label=c.provider or "",
            symbol=None,
            currency="EUR",
            price=None,
            quantity=None,
            total=None,
            fees=c.fees_eur,
            sent=c.eur_sent,
            received=c.usd_received,
        )
        for c in convs
    )
    return sorted(out, key=lambda v: (v.date, v.id), reverse=True)
