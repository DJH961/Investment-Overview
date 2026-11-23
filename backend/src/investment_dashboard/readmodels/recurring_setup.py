"""Defaults that flow between the steps of "Set up your routine" (7.3, P14).

Step 1 converts EUR: :func:`conversion_estimate` says what that yields in dollars (the same
rule as an est. conversion: the settled ECB fixing pushed by the provider's average
spread, less the expected fee). Step 2 deposits those dollars; step 3 buys with them:
:func:`buy_split` splits a dollar total across the account's holdings, by the allocation
plan if one is set, else by the split of the recent buys, else equally. All arithmetic is
here; the client only shows the numbers.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import timedelta
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy.orm import Session

from investment_dashboard.domain import recurrence
from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.domain.money_market import is_money_market, is_settlement_external_id
from investment_dashboard.readmodels import rebalance
from investment_dashboard.repositories import instruments_repo, transactions_repo
from investment_dashboard.services import fx_cost_service, fx_service, recurring_service

#: How far back the buys of an account say which holdings it buys and in what proportion.
LOOKBACK_DAYS = 120
_ONE = Decimal(1)


@dataclass(frozen=True)
class ConversionEstimate:
    eur: Decimal
    fee_eur: Decimal
    ecb_rate: Decimal
    off_pct: Decimal | None
    rate: Decimal
    #: Whole dollars the conversion yields: ``(eur - fee) * rate``.
    usd: Decimal
    #: What each deposit run takes from it: ``usd`` spread over the deposit cadence (whole dollars).
    deposit_usd: Decimal


@dataclass(frozen=True)
class SplitLeg:
    instrument_id: int
    symbol: str
    amount: Decimal


@dataclass(frozen=True)
class BuySplit:
    #: What each buy run invests (whole dollars).
    total: Decimal
    #: The deposit it comes from, per deposit run (whole dollars; equals ``total`` without cadences).
    deposit_total: Decimal
    #: ``allocation`` | ``history`` | ``equal`` | ``none`` (no holdings known for the account).
    method: str
    allocation_name: str | None
    #: Whether an allocation plan exists at all (the client nudges to set one when not).
    has_allocation_plan: bool
    legs: tuple[SplitLeg, ...]


def conversion_estimate(
    session: Session,
    *,
    eur: Decimal,
    provider: str,
    fee_eur: Decimal | None = None,
    conversion: tuple[str, int] | None = None,
    deposit: tuple[str, int] | None = None,
) -> ConversionEstimate | None:
    """What converting ``eur`` with ``provider`` yields in whole dollars; ``None`` without an ECB rate."""
    ecb = fx_service.get_settled_rate(session, exchange_today(), base="EUR", quote="USD")
    if ecb is None or eur <= 0:
        return None
    avg = fx_cost_service.provider_avg_off_pct(session, provider)
    rate, _ = recurrence.estimated_conversion(eur_sent=eur, ecb_rate=ecb, avg_off_pct=avg)
    fee = (
        fee_eur
        if fee_eur is not None
        else recurring_service.last_fee_for_provider(session, provider)
    )
    fee = fee or Decimal(0)
    exact = (eur - fee) * rate
    usd = exact.quantize(_ONE, rounding=ROUND_HALF_UP)
    per_deposit = (
        exact
        if conversion is None or deposit is None
        else recurrence.per_run_amount(exact, paid=conversion, spent=deposit)
    )
    return ConversionEstimate(
        eur, fee, ecb, avg, rate, usd, per_deposit.quantize(_ONE, rounding=ROUND_HALF_UP)
    )


def split_whole_dollars(total: Decimal, weights: Mapping[int, Decimal]) -> dict[int, Decimal]:
    """``total`` (whole dollars) split by ``weights``, each part a whole number, summing to ``total``.

    Largest-remainder rounding: every part gets its floored share, the leftover dollars go to
    the biggest fractional remainders (ties to the lower id, so the result is deterministic).
    """
    whole = total.quantize(_ONE, rounding=ROUND_HALF_UP)
    positive = {k: w for k, w in weights.items() if w > 0}
    weight_sum = sum(positive.values(), Decimal(0))
    if whole <= 0 or weight_sum <= 0:
        return {}
    exact = {k: whole * w / weight_sum for k, w in positive.items()}
    parts = {k: v.to_integral_value(rounding="ROUND_FLOOR") for k, v in exact.items()}
    leftover = int(whole - sum(parts.values(), Decimal(0)))
    for k in sorted(exact, key=lambda k: (-(exact[k] - parts[k]), k))[:leftover]:
        parts[k] += 1
    return {k: v for k, v in parts.items() if v > 0}


def _account_holdings(
    session: Session, account_id: int
) -> tuple[dict[int, str], dict[int, Decimal]]:
    """``(symbol by id, recent buy total by id)`` of the account's buyable holdings."""
    since = exchange_today() - timedelta(days=LOOKBACK_DAYS)
    symbols: dict[int, str] = {}
    recent: dict[int, Decimal] = {}
    for t in transactions_repo.list_transactions(session, account_id=account_id, kinds=("buy",)):
        if t.instrument_id is None or is_settlement_external_id(t.external_id):
            continue
        inst = instruments_repo.get_instrument(session, t.instrument_id)
        if inst is None or is_money_market(
            inst.symbol, asset_class=inst.asset_class, name=inst.name
        ):
            continue
        symbols[inst.id] = inst.symbol
        if t.date >= since and t.gross_native:
            recent[inst.id] = recent.get(inst.id, Decimal(0)) + abs(t.gross_native)
    return symbols, recent


def buy_split(
    session: Session,
    *,
    account_id: int,
    total: Decimal,
    deposit: tuple[str, int] | None = None,
    buy: tuple[str, int] | None = None,
) -> BuySplit:
    """Split what each buy run invests across the holdings ``account_id`` buys.

    ``total`` is the deposit amount. With both cadences known (``deposit`` and ``buy`` as
    ``(unit, every)``) each buy run invests its share of it: a monthly deposit spent weekly
    is ``total x 12 / 52`` a run, so the deposit is invested in full each month. Without
    them the whole ``total`` is one run.
    """
    symbols, recent = _account_holdings(session, account_id)
    deposit_whole = total.quantize(_ONE, rounding=ROUND_HALF_UP)
    run = (
        total
        if deposit is None or buy is None
        else recurrence.per_run_amount(total, paid=deposit, spent=buy)
    )
    whole = run.quantize(_ONE, rounding=ROUND_HALF_UP)
    if not symbols or whole <= 0:
        return BuySplit(whole, deposit_whole, "none", None, False, ())

    def legs_of(parts: Mapping[int, Decimal]) -> tuple[SplitLeg, ...]:
        return tuple(
            SplitLeg(i, symbols[i], a)
            for i, a in sorted(parts.items(), key=lambda p: symbols[p[0]])
        )

    name: str | None = None
    has_plan = False
    try:
        plan = rebalance.build_target_plan(
            session, amount=whole, ccy="USD", allow_fractional=True, allow_sell=False
        )
        has_plan = True
        name = plan.target_name
        weights = {
            r.instrument_id: r.add_value
            for r in plan.rows
            if r.instrument_id in symbols and r.add_value is not None and r.add_value > 0
        }
        parts = split_whole_dollars(whole, weights)
        if parts:
            return BuySplit(whole, deposit_whole, "allocation", name, True, legs_of(parts))
    except rebalance.RebalanceInputError:
        pass
    history = split_whole_dollars(whole, recent)
    if history:
        return BuySplit(whole, deposit_whole, "history", name, has_plan, legs_of(history))
    equal = split_whole_dollars(whole, {i: Decimal(1) for i in symbols})
    return BuySplit(whole, deposit_whole, "equal", name, has_plan, legs_of(equal))
