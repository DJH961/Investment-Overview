"""``/api/instruments``: list instruments and edit their overrides (Settings → Instruments)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from investment_dashboard.api.deps import SessionDep
from investment_dashboard.api.guards import ActorDep
from investment_dashboard.api.schemas.instruments import (
    InstrumentErrorDto,
    InstrumentOut,
    InstrumentPatch,
    InstrumentUpdateResult,
    TwinSuggestionDto,
)
from investment_dashboard.domain.index_twins import all_suggestions
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.services import instruments_service
from investment_dashboard.services.instruments_service import InstrumentView

router = APIRouter(tags=["instruments"])

_ERRORS: dict[int | str, dict[str, Any]] = {422: {"model": InstrumentErrorDto}}


def _out(v: InstrumentView) -> InstrumentOut:
    return InstrumentOut(
        id=v.id,
        symbol=v.symbol,
        name=v.name,
        ledger_name=v.ledger_name,
        name_override=v.name_override,
        asset_class=v.asset_class,
        ledger_asset_class=v.ledger_asset_class,
        asset_class_override=v.asset_class_override,
        native_currency=v.native_currency,
        expense_ratio=dec(v.expense_ratio),
        expense_ratio_override=dec(v.expense_ratio_override),
        category=v.category,
        active=v.active,
        provider_symbol=v.provider_symbol,
        fetch_symbol=v.fetch_symbol,
        pricing_mode=v.pricing_mode,  # type: ignore[arg-type]
        transaction_count=v.transaction_count,
        latest_price_date=v.latest_price_date.isoformat() if v.latest_price_date else None,
        intraday_twin=v.intraday_twin,
        twin_suggestion=(
            TwinSuggestionDto(
                etf=v.twin_suggestion.etf,
                tier=v.twin_suggestion.tier,
                index=v.twin_suggestion.index,
                typical_daily_gap=v.twin_suggestion.typical_daily_gap,
            )
            if v.twin_suggestion is not None
            else None
        ),
        twin_daily_gap=dec(v.twin_daily_gap),
    )


@router.get("/instruments", response_model=list[InstrumentOut])
def list_instruments(session: SessionDep) -> list[InstrumentOut]:
    return [_out(v) for v in instruments_service.list_instruments(session)]


@router.get("/instruments/twin-suggestions", response_model=dict[str, TwinSuggestionDto])
def twin_suggestions() -> dict[str, TwinSuggestionDto]:
    """The built-in fund -> ETF twin list (identical-index pairs, then measured close twins)."""
    return {
        s.fund: TwinSuggestionDto(
            etf=s.etf, tier=s.tier, index=s.index, typical_daily_gap=s.typical_daily_gap
        )
        for s in all_suggestions()
    }


@router.get("/instruments/{instrument_id}", response_model=InstrumentOut)
def get_instrument(instrument_id: int, session: SessionDep) -> InstrumentOut:
    return _out(instruments_service.get_instrument(session, instrument_id))


@router.patch(
    "/instruments/{instrument_id}", response_model=InstrumentUpdateResult, responses=_ERRORS
)
def update_instrument(
    instrument_id: int, body: InstrumentPatch, session: SessionDep, actor: ActorDep
) -> Any:
    changes = {k: getattr(body, k) for k in body.model_fields_set}
    try:
        result = instruments_service.update_instrument(session, instrument_id, changes, actor=actor)
    except instruments_service.InstrumentEditError as exc:
        session.rollback()
        return JSONResponse({"detail": str(exc), "errors": exc.errors}, status_code=422)
    return InstrumentUpdateResult(
        instrument=_out(result.view),
        changed=result.changed,
        redownload_suggested=result.redownload_suggested,
    )
