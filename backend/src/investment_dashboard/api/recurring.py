"""`/api/recurring` router: recurring plans (buys, conversions) and their est. rows (7.3, P14)."""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Literal, cast

from fastapi import APIRouter, Query, Response

from investment_dashboard.api.deps import SessionDep
from investment_dashboard.api.schemas.recurring import (
    BuySplitOut,
    ConversionEstimateOut,
    EstimateOut,
    EstimatesOut,
    LegOut,
    PlanIn,
    PlanKind,
    PlanOut,
    PlanStatus,
    Provider,
    ReminderGroupOut,
    RowType,
    SettleIn,
    SettleOut,
    SetupPlanOut,
    SplitLegOut,
    SuggestedLegOut,
    SuggestionOut,
    Unit,
)
from investment_dashboard.readmodels import recurring_setup
from investment_dashboard.services import recurring_service as service

router = APIRouter(tags=["recurring"])


def _s(value: Decimal | None) -> str | None:
    return None if value is None else format(value, "f")


def _plan_out(session: SessionDep, plan_id: int) -> PlanOut:
    view = service.plan_view(session, service.get_plan(session, plan_id))
    p = view.plan
    return PlanOut(
        id=p.id,
        kind=cast("PlanKind", p.kind),
        unit=cast("Unit", p.unit),
        every=p.every,
        anchor=p.anchor,
        start_date=p.start_date.isoformat(),
        end_date=p.end_date.isoformat() if p.end_date else None,
        status=cast("PlanStatus", view.status),
        paused=p.paused,
        account_id=p.account_id,
        account=view.account,
        legs=[
            LegOut(
                id=leg.id,
                instrument_id=leg.instrument_id,
                symbol=leg.symbol,
                amount=_s(leg.amount),
                shares=_s(leg.shares),
            )
            for leg in view.legs
        ],
        amount=_s(p.amount),
        provider=cast("Provider | None", p.provider),
        expected_fee=_s(p.expected_fee),
        next_due=view.next_due.isoformat() if view.next_due else None,
        note=view.note,
    )


def _input(body: PlanIn) -> service.PlanInput:
    return service.PlanInput(
        kind=body.kind,
        unit=body.unit,
        every=body.every,
        anchor=body.anchor,
        start_date=body.start_date,
        end_date=body.end_date,
        account_id=body.account_id,
        amount=body.amount,
        legs=tuple(
            service.LegInput(leg.instrument_id, leg.amount, leg.shares) for leg in body.legs
        ),
        provider=body.provider,
        expected_fee=body.expected_fee,
    )


@router.get("/recurring/plans", response_model=list[PlanOut])
def list_plans(session: SessionDep) -> list[PlanOut]:
    return [_plan_out(session, p.id) for p in service.list_plans(session)]


@router.post("/recurring/plans", response_model=PlanOut, status_code=201)
def create_plan(body: PlanIn, session: SessionDep) -> PlanOut:
    return _plan_out(session, service.create_plan(session, _input(body)).id)


@router.put("/recurring/plans/{plan_id}", response_model=PlanOut)
def update_plan(plan_id: int, body: PlanIn, session: SessionDep) -> PlanOut:
    return _plan_out(session, service.update_plan(session, plan_id, _input(body)).id)


@router.post("/recurring/plans/{plan_id}/pause", response_model=PlanOut)
def pause_plan(plan_id: int, session: SessionDep) -> PlanOut:
    return _plan_out(session, service.pause_plan(session, plan_id).id)


@router.post("/recurring/plans/{plan_id}/resume", response_model=PlanOut)
def resume_plan(plan_id: int, session: SessionDep) -> PlanOut:
    return _plan_out(session, service.resume_plan(session, plan_id).id)


@router.post("/recurring/plans/{plan_id}/end", response_model=PlanOut)
def end_plan(plan_id: int, session: SessionDep) -> PlanOut:
    return _plan_out(session, service.end_plan(session, plan_id).id)


@router.delete("/recurring/plans/{plan_id}", status_code=204)
def delete_plan(plan_id: int, session: SessionDep) -> Response:
    service.delete_plan(session, plan_id)
    return Response(status_code=204)


@router.get("/recurring/suggestions", response_model=list[SuggestionOut])
def suggestions(session: SessionDep) -> list[SuggestionOut]:
    """Plans the last months of the ledger look like (deposits, buys, conversions).

    Suggestions only: the "Set up your routine" flow prefills its form from these and
    nothing is created until the owner confirms.
    """
    return [
        SuggestionOut(
            kind=cast("PlanKind", s.kind),
            unit=cast("Unit", s.cadence.unit),
            every=s.cadence.every,
            anchor=s.cadence.anchor,
            amount=format(s.cadence.amount, "f"),
            occurrences=s.cadence.occurrences,
            account_id=s.account_id,
            account=s.account,
            legs=[
                SuggestedLegOut(
                    instrument_id=g.instrument_id, symbol=g.symbol, amount=format(g.amount, "f")
                )
                for g in s.legs
            ],
            provider=cast("Provider | None", s.provider),
        )
        for s in service.suggest_routine(session)
    ]


@router.get("/recurring/setup-plan", response_model=SetupPlanOut)
def setup_plan(
    session: SessionDep,
    eur_amount: Annotated[Decimal | None, Query(gt=0, description="Step 1: EUR converted.")] = None,
    provider: Provider = "revolut",
    expected_fee: Annotated[Decimal | None, Query(ge=0)] = None,
    buy_total_usd: Annotated[
        Decimal | None,
        Query(gt=0, description="Step 3: the dollars to buy with (step 2's deposit)."),
    ] = None,
    account_id: int | None = None,
) -> SetupPlanOut:
    """Defaults that flow between the setup steps; every figure is computed here.

    Each step inherits only from the one before it: the deposit starts from the conversion's
    dollars, the buys from the deposit amount (split by the allocation plan, else by the
    recent buys, else equally).
    """
    conv = (
        recurring_setup.conversion_estimate(
            session, eur=eur_amount, provider=provider, fee_eur=expected_fee
        )
        if eur_amount is not None
        else None
    )
    split = (
        recurring_setup.buy_split(session, account_id=account_id, total=buy_total_usd)
        if buy_total_usd is not None and account_id is not None
        else None
    )
    return SetupPlanOut(
        conversion=None
        if conv is None
        else ConversionEstimateOut(
            eur=format(conv.eur, "f"),
            fee_eur=format(conv.fee_eur, "f"),
            ecb_rate=format(conv.ecb_rate, "f"),
            off_pct=None if conv.off_pct is None else format(conv.off_pct, "f"),
            rate=format(conv.rate, "f"),
            usd=format(conv.usd, "f"),
        ),
        split=None
        if split is None
        else BuySplitOut(
            total=format(split.total, "f"),
            method=cast("Literal['allocation', 'history', 'equal', 'none']", split.method),
            allocation_name=split.allocation_name,
            has_allocation_plan=split.has_allocation_plan,
            legs=[
                SplitLegOut(
                    instrument_id=g.instrument_id, symbol=g.symbol, amount=format(g.amount, "f")
                )
                for g in split.legs
            ],
        ),
    )


@router.get("/recurring/estimates", response_model=EstimatesOut)
def estimates(session: SessionDep) -> EstimatesOut:
    rows = service.estimate_views(session)
    return EstimatesOut(
        count=service.estimate_count(session),
        groups=[
            ReminderGroupOut(
                plan_id=g.plan_id,
                kind=cast("Literal['buy', 'conversion']", g.kind),
                count=g.count,
                input=cast("Literal['type', 'import']", g.input),
                message=g.message,
                provider=cast("Provider | None", g.provider),
            )
            for g in service.reminder_groups(session)
        ],
        rows=[
            EstimateOut(
                row_type=cast("RowType", v.row_type),
                id=v.id,
                plan_id=v.plan_id,
                due_date=v.due_date.isoformat() if v.due_date else None,
                date=v.date.isoformat(),
                label=v.label,
                symbol=v.symbol,
                currency=v.currency,
                price=_s(v.price),
                quantity=_s(v.quantity),
                total=_s(v.total),
                fees=_s(v.fees),
                sent=_s(v.sent),
                received=_s(v.received),
                price_dp=v.price_dp,
                quantity_dp=v.quantity_dp,
                eur_rate=_s(v.eur_rate),
                eur_rate_source=cast("Literal['conversion', 'ecb'] | None", v.eur_rate_source),
                eur_rate_date=v.eur_rate_date.isoformat() if v.eur_rate_date else None,
            )
            for v in rows
        ],
    )


@router.post("/recurring/settle", response_model=SettleOut)
def settle(body: SettleIn, session: SessionDep) -> SettleOut:
    items = [
        service.SettleItem(
            kind=r.row_type,
            id=r.id,
            price=r.price,
            quantity=r.quantity,
            total=r.total,
            fees=r.fees,
            sent=r.sent,
            received=r.received,
        )
        for r in body.rows
    ]
    settled = service.settle(session, items, due_date=body.due_date)
    return SettleOut(settled=settled, remaining=service.estimate_count(session))
