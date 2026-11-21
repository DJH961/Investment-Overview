"""``/api/lookup``: look up any symbol (held or not) without touching the ledger."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Path, Query

from investment_dashboard.api.deps import SessionDep
from investment_dashboard.api.schemas.lookup import (
    LookupHistory,
    LookupHit,
    LookupPoint,
    LookupQuote,
    LookupRange,
    LookupSearchResponse,
    LookupSession,
)
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.services import lookup_service

router = APIRouter(tags=["lookup"])

SymbolPath = Annotated[
    str,
    Path(pattern=r"^[A-Z0-9.\-^=]{1,15}$", description="Upper-case provider symbol."),
]


@router.get("/lookup/search", response_model=LookupSearchResponse)
def search(
    session: SessionDep, q: Annotated[str, Query(min_length=1, max_length=60)]
) -> LookupSearchResponse:
    return LookupSearchResponse(
        results=[
            LookupHit(
                symbol=r.symbol,
                name=r.name,
                exchange=r.exchange,
                type=r.type,
                currency=r.currency,
                held_instrument_id=r.held_instrument_id,
            )
            for r in lookup_service.search(session, q)
        ]
    )


@router.get("/lookup/{symbol}/quote", response_model=LookupQuote)
def quote(symbol: SymbolPath, session: SessionDep) -> LookupQuote:
    q = lookup_service.get_quote(session, symbol)
    return LookupQuote(
        symbol=q.symbol,
        name=q.name,
        exchange=q.exchange,
        type=q.type,
        currency=q.currency,
        price_native=dec(q.price_native) or "0",
        day_change_native=dec(q.day_change_native),
        day_pct=dec(q.day_pct),
        captured_at=q.captured_at.isoformat().replace("+00:00", "Z"),
        week52_low=dec(q.week52_low),
        week52_high=dec(q.week52_high),
        fx_eur_usd=dec(q.fx_eur_usd),
    )


@router.get("/lookup/{symbol}/history", response_model=LookupHistory)
def history(
    symbol: SymbolPath,
    session: SessionDep,
    range: Annotated[LookupRange, Query()] = "1y",
) -> LookupHistory:
    h = lookup_service.get_history(session, symbol, range)
    return LookupHistory(
        symbol=h.symbol,
        currency=h.currency,
        range=range,
        x_mode=h.x_mode,  # type: ignore[arg-type]
        sessions=[LookupSession(open=s.open, close=s.close) for s in h.sessions],
        points=[
            LookupPoint(
                t=p.t, price_native=dec(p.price_native) or "0", fx_eur_usd=dec(p.fx_eur_usd)
            )
            for p in h.points
        ],
    )
