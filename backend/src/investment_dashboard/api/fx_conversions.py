"""`/api/fx-conversions` router: EUR -> USD batches, the USD pool and deposit pins."""

from __future__ import annotations

from datetime import date as date_type
from decimal import Decimal
from typing import TYPE_CHECKING, Annotated, Literal, cast

from fastapi import APIRouter, HTTPException, Query, Response
from sqlalchemy.orm import Session

from investment_dashboard.api.deps import SessionDep
from investment_dashboard.api.schemas.common import ByCurrency
from investment_dashboard.api.schemas.currency_rate import RateRange
from investment_dashboard.api.schemas.fx_conversions import (
    CostsOut,
    DepositMatchOut,
    DepositSliceOut,
    FxConversionIn,
    FxConversionOut,
    PinsIn,
    PoolOut,
    ReferenceOut,
    RejectedPinOut,
    RemainingBatchOut,
    SliceOut,
    UsedByOut,
)
from investment_dashboard.domain import fx_spread
from investment_dashboard.domain.fx_pool import DepositMatch, PoolResult
from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.readmodels import fx_costs
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.services import fx_conversion_service as service

if TYPE_CHECKING:
    from investment_dashboard.models import FxConversion

router = APIRouter(tags=["fx-conversions"])


def _s(value: Decimal) -> str:
    return format(value, "f")


def _out(
    session: Session,
    row: FxConversion,
    result: PoolResult,
    dates: dict[int, date_type],
) -> FxConversionOut:
    use = next((u for u in result.by_conversion if u.conversion_id == row.id), None)
    fees = row.fees_eur if row.fees_eur is not None else Decimal(0)
    fixing = service.ecb_fixing_for(session, row.date)
    ecb = None if fixing is None else fixing[0]
    direction = service.direction(row)
    cost = fx_spread.conversion_cost(
        fx_spread.Conversion(
            id=row.id,
            date=row.date,
            eur_sent=row.eur_sent,
            usd_received=row.usd_received,
            fees_eur=fees,
            provider=row.provider,
            ecb_rate=ecb,
            ecb_rate_date=None if fixing is None else fixing[1],
            direction=direction,
        )
    )
    if direction == "to_usd":
        remaining = use.remaining_usd if use is not None else row.usd_received - row.kept_usd
    else:
        remaining = Decimal(0)  # a conversion back never fills the deposit pool
    used = sorted(
        use.slices if use is not None else (),
        key=lambda sl: (dates.get(sl.deposit_id), sl.deposit_id),
        reverse=True,
    )
    return FxConversionOut(
        id=row.id,
        date=row.date.isoformat(),
        eur_sent=_s(row.eur_sent),
        usd_received=_s(row.usd_received),
        fees_eur=None if row.fees_eur is None else _s(row.fees_eur),
        note=row.note,
        effective_rate=_s(row.usd_received / row.eur_sent),
        from_ccy=row.from_ccy,
        to_ccy=row.to_ccy,
        provider=cast("Literal['wise', 'revolut', 'other'] | None", row.provider),
        kept_usd=_s(row.kept_usd),
        rate=_s(row.usd_received / row.eur_sent),
        all_in_rate=_s(cost.all_in_rate),
        direction=direction,
        ecb_rate=None if ecb is None else _s(ecb),
        ecb_rate_date=None if fixing is None else fixing[1].isoformat(),
        off_pct=None if cost.off_pct is None else _s(cost.off_pct),
        spread_eur=dec(cost.spread_eur),
        cost_eur=dec(cost.cost_eur),
        fees_usd=dec(cost.fees_usd),
        cost_usd=dec(cost.cost_usd),
        used_by=[
            UsedByOut(
                deposit_id=sl.deposit_id,
                date=dates[sl.deposit_id].isoformat(),
                usd=_s(sl.usd),
                eur=_s(sl.eur),
                pinned=sl.pinned,
            )
            for sl in used
            if sl.deposit_id in dates
        ],
        remaining_usd=_s(remaining),
        is_estimate=bool(row.is_estimate),
    )


def _match_out(
    m: DepositMatch, convs: dict[int, FxConversion], received: frozenset[int] = frozenset()
) -> DepositMatchOut:
    rate = m.blended_rate
    status: Literal["matched", "partial", "ecb_only", "received_usd"]
    if not m.is_fallback:
        status = "matched"
    elif m.matched_usd > 0:
        status = "partial"
    elif m.deposit_id in received:
        status = "received_usd"
    else:
        status = "ecb_only"
    slices = []
    for s in m.matched:
        c = convs[s.conversion_id]
        fees = c.fees_eur if c.fees_eur is not None else Decimal(0)
        slices.append(
            DepositSliceOut(
                conversion_id=s.conversion_id,
                conversion_date=c.date.isoformat(),
                usd=_s(s.usd),
                eur=_s(s.eur),
                rate=_s(c.usd_received / (c.eur_sent + fees)),
                pinned=s.pinned,
            )
        )
    return DepositMatchOut(
        transaction_id=m.deposit_id,
        date=m.date.isoformat(),
        usd=_s(m.usd),
        matched=[
            SliceOut(conversion_id=s.conversion_id, usd=_s(s.usd), eur=_s(s.eur)) for s in m.matched
        ],
        fallback_usd=_s(m.fallback_usd),
        fallback_eur=_s(m.fallback_eur),
        fallback_rate=None if m.fallback_rate is None else _s(m.fallback_rate),
        fallback_to_ecb=m.is_fallback,
        rate_missing=m.rate_missing,
        eur_actual=_s(m.eur_total),
        effective_rate=None if rate is None else _s(rate),
        status=status,
        slices=slices,
        # the lookup date; the fixing itself is forward-filled from the last published day
        fallback_rate_date=m.date.isoformat() if m.is_fallback else None,
        pinned=any(s.pinned for s in m.matched),
        received_in_usd=m.deposit_id in received,
    )


def _bad(exc: ValueError) -> HTTPException:
    return HTTPException(status_code=422, detail=str(exc))


@router.get("/fx-conversions", response_model=list[FxConversionOut])
def list_conversions(
    session: SessionDep,
    direction: Annotated[Literal["to_usd", "to_eur"] | None, Query()] = None,
) -> list[FxConversionOut]:
    """Every conversion, newest first; ``direction`` keeps one way only (default both)."""
    report = service.pool_report(session)
    dates = {m.deposit_id: m.date for m in report.result.deposits}
    listed = service.list_conversions(session, direction=direction)
    rows = sorted(listed, key=lambda r: (r.date, r.id), reverse=True)
    return [_out(session, r, report.result, dates) for r in rows]


def _created(session: SessionDep, row: FxConversion) -> FxConversionOut:
    report = service.pool_report(session)
    dates = {m.deposit_id: m.date for m in report.result.deposits}
    return _out(session, row, report.result, dates)


@router.post("/fx-conversions", response_model=FxConversionOut, status_code=201)
def create_conversion(body: FxConversionIn, session: SessionDep) -> FxConversionOut:
    try:
        row = service.create_conversion(
            session,
            on=body.date,
            eur_sent=body.eur_sent,
            usd_received=body.usd_received,
            fees_eur=body.fees_eur,
            note=body.note,
            provider=body.provider,
            kept_usd=body.kept_usd,
            from_ccy=body.from_ccy,
            to_ccy=body.to_ccy,
        )
    except ValueError as exc:
        raise _bad(exc) from exc
    return _created(session, row)


@router.get("/fx-conversions/pool", response_model=PoolOut)
def pool(session: SessionDep) -> PoolOut:
    report = service.pool_report(session)
    convs = {c.id: c for c in report.conversions}
    ordered = sorted(report.result.deposits, key=lambda m: (m.date, m.deposit_id), reverse=True)
    deposits = [_match_out(m, convs, report.received_in_usd) for m in ordered]
    return PoolOut(
        balance_usd=_s(report.result.remaining_usd),
        balance_eur=_s(report.result.remaining_eur),
        remaining=[
            RemainingBatchOut(conversion_id=r.conversion_id, usd=_s(r.usd), eur=_s(r.eur))
            for r in report.result.remaining
        ],
        deposits=deposits,
        fallbacks=[d for d in deposits if d.fallback_to_ecb],
        rejected_pins=[
            RejectedPinOut(
                deposit_id=p.deposit_id, conversion_id=p.conversion_id, usd=_s(p.usd), reason=why
            )
            for p, why in report.result.rejected_pins
        ],
    )


@router.get("/fx-conversions/costs", response_model=ByCurrency[CostsOut])
def costs(
    session: SessionDep,
    range_key: Annotated[RateRange, Query(alias="range")] = "all",
) -> ByCurrency[CostsOut]:
    """What converting costs you, per reporting currency (a plain read, not logged)."""
    sides = fx_costs.build_costs_both(session, range_key, exchange_today())
    return ByCurrency[CostsOut].model_validate(
        {c: CostsOut.model_validate(p) for c, p in sides.items()}
    )


@router.get("/fx-conversions/reference", response_model=ReferenceOut)
def reference(date: date_type, session: SessionDep) -> ReferenceOut:
    fixing = service.ecb_fixing_for(session, date)
    return ReferenceOut(
        date=date.isoformat(),
        ecb_rate=None if fixing is None else _s(fixing[0]),
        ecb_rate_date=None if fixing is None else fixing[1].isoformat(),
        published=fixing is not None and fixing[1] == date,
    )


@router.put("/fx-conversions/pins/{deposit_txn_id}", response_model=DepositMatchOut)
def put_pins(deposit_txn_id: int, body: PinsIn, session: SessionDep) -> DepositMatchOut:
    try:
        match = service.set_pins(
            session, deposit_txn_id, [(p.conversion_id, p.usd) for p in body.pins]
        )
    except ValueError as exc:
        raise _bad(exc) from exc
    convs = {c.id: c for c in service.list_conversions(session)}
    return _match_out(match, convs)


@router.put("/fx-conversions/received-in-usd/{deposit_txn_id}", response_model=DepositMatchOut)
def mark_received_in_usd(deposit_txn_id: int, session: SessionDep) -> DepositMatchOut:
    """Mark a USD deposit as received in USD (no conversion); it keeps its ECB valuation."""
    try:
        service.set_received_in_usd(session, deposit_txn_id, True)
    except ValueError as exc:
        raise _bad(exc) from exc
    report = service.pool_report(session)
    convs = {c.id: c for c in report.conversions}
    match = next(m for m in report.result.deposits if m.deposit_id == deposit_txn_id)
    return _match_out(match, convs, report.received_in_usd)


@router.delete("/fx-conversions/received-in-usd/{deposit_txn_id}", status_code=204)
def unmark_received_in_usd(deposit_txn_id: int, session: SessionDep) -> Response:
    try:
        service.set_received_in_usd(session, deposit_txn_id, False)
    except ValueError as exc:
        raise _bad(exc) from exc
    return Response(status_code=204)


@router.delete("/fx-conversions/pins/{deposit_txn_id}", status_code=204)
def delete_pins(deposit_txn_id: int, session: SessionDep) -> Response:
    service.clear_pins(session, deposit_txn_id)
    return Response(status_code=204)


@router.put("/fx-conversions/{conversion_id}", response_model=FxConversionOut)
def update_conversion(
    conversion_id: int, body: FxConversionIn, session: SessionDep
) -> FxConversionOut:
    try:
        row = service.update_conversion(
            session,
            conversion_id,
            on=body.date,
            eur_sent=body.eur_sent,
            usd_received=body.usd_received,
            fees_eur=body.fees_eur,
            note=body.note,
            provider=body.provider,
            kept_usd=body.kept_usd,
            from_ccy=body.from_ccy,
            to_ccy=body.to_ccy,
        )
    except ValueError as exc:
        raise _bad(exc) from exc
    if row is None:
        raise HTTPException(status_code=404, detail="conversion not found")
    return _created(session, row)


@router.delete("/fx-conversions/{conversion_id}", status_code=204)
def delete_conversion(conversion_id: int, session: SessionDep) -> Response:
    if not service.delete_conversion(session, conversion_id):
        raise HTTPException(status_code=404, detail="conversion not found")
    return Response(status_code=204)
