"""`/api/fx-conversions` router: EUR -> USD batches and the FIFO USD pool."""

from __future__ import annotations

from decimal import Decimal
from typing import TYPE_CHECKING

from fastapi import APIRouter, HTTPException, Response

from investment_dashboard.api.deps import SessionDep
from investment_dashboard.api.schemas.fx_conversions import (
    DepositMatchOut,
    FxConversionIn,
    FxConversionOut,
    PoolOut,
    RemainingBatchOut,
    SliceOut,
)
from investment_dashboard.domain.fx_pool import DepositMatch
from investment_dashboard.services import fx_conversion_service as service

if TYPE_CHECKING:
    from investment_dashboard.models import FxConversion

router = APIRouter(tags=["fx-conversions"])


def _s(value: Decimal) -> str:
    return format(value, "f")


def _out(row: FxConversion) -> FxConversionOut:
    return FxConversionOut(
        id=row.id,
        date=row.date.isoformat(),
        eur_sent=_s(row.eur_sent),
        usd_received=_s(row.usd_received),
        fees_eur=None if row.fees_eur is None else _s(row.fees_eur),
        note=row.note,
        effective_rate=_s(row.usd_received / row.eur_sent),
    )


def _match_out(m: DepositMatch) -> DepositMatchOut:
    rate = m.blended_rate
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
    )


def _bad(exc: ValueError) -> HTTPException:
    return HTTPException(status_code=422, detail=str(exc))


@router.get("/fx-conversions", response_model=list[FxConversionOut])
def list_conversions(session: SessionDep) -> list[FxConversionOut]:
    return [_out(r) for r in service.list_conversions(session)]


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
        )
    except ValueError as exc:
        raise _bad(exc) from exc
    return _out(row)


@router.get("/fx-conversions/pool", response_model=PoolOut)
def pool(session: SessionDep) -> PoolOut:
    report = service.pool_report(session)
    deposits = [_match_out(m) for m in report.result.deposits]
    return PoolOut(
        balance_usd=_s(report.result.remaining_usd),
        balance_eur=_s(report.result.remaining_eur),
        remaining=[
            RemainingBatchOut(conversion_id=r.conversion_id, usd=_s(r.usd), eur=_s(r.eur))
            for r in report.result.remaining
        ],
        deposits=deposits,
        fallbacks=[d for d in deposits if d.fallback_to_ecb],
    )


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
        )
    except ValueError as exc:
        raise _bad(exc) from exc
    if row is None:
        raise HTTPException(status_code=404, detail="conversion not found")
    return _out(row)


@router.delete("/fx-conversions/{conversion_id}", status_code=204)
def delete_conversion(conversion_id: int, session: SessionDep) -> Response:
    if not service.delete_conversion(session, conversion_id):
        raise HTTPException(status_code=404, detail="conversion not found")
    return Response(status_code=204)
