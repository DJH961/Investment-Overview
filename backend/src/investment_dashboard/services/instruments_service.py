"""Instruments editor: list instruments with their effective settings and edit them.

Edits are **config-tier overrides** (``instrument_overrides``); the ledger row
(symbol, currency, imported name) is never changed, so a re-import still finds
the instrument by its broker symbol:

* display name, asset class, TER and category (display overrides),
* ``active`` (hidden from refreshes and most listings),
* ``provider_symbol`` — the ticker the price provider knows it by,
* ``pricing_mode`` — ``auto`` (fetched), ``manual`` (closes come from manual
  price fixes, ``/api/maintenance/prices``) or ``delisted`` (no more fetches; the
  last known close keeps valuing it).

The native currency is read-only (the currency rule: amounts are stored in it).
Every change is validated as a whole (422 with per-field errors), invalidates
the valuation history when it can change a value, and leaves a line in the
``changes`` activity log.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.activity_log import activity
from investment_dashboard.db import config_read_session, config_write_session
from investment_dashboard.domain.instruments import (
    ASSET_CLASSES,
    PRICING_AUTO,
    PRICING_MODES,
    fetch_symbol,
    is_fetched,
)
from investment_dashboard.errors import NotFoundError, ValidationError
from investment_dashboard.repositories import instrument_overrides_repo, instruments_repo
from investment_dashboard.services import prices_service
from investment_dashboard.services.instrument_enrichment_service import effective_instrument

log = logging.getLogger(__name__)

#: Fields a PATCH may carry.
EDITABLE: tuple[str, ...] = (
    "name",
    "asset_class",
    "expense_ratio",
    "category",
    "active",
    "provider_symbol",
    "pricing_mode",
)
_SYMBOL_RE = re.compile(r"^[A-Z0-9^][A-Z0-9.\-=^]{0,31}$")
_MAX_NAME = 256
_MAX_CATEGORY = 64
_MAX_TER = Decimal("0.2")


class InstrumentEditError(ValidationError):
    """Invalid instrument changes -> 422 with ``errors`` per field."""

    def __init__(self, errors: dict[str, str]) -> None:
        super().__init__("; ".join(f"{k}: {v}" for k, v in errors.items()))
        self.errors = errors


@dataclass(frozen=True)
class InstrumentView:
    """One editor row: the effective values plus what the ledger says underneath."""

    id: int
    symbol: str
    name: str | None
    ledger_name: str | None
    name_override: str | None
    asset_class: str
    ledger_asset_class: str
    asset_class_override: str | None
    native_currency: str
    expense_ratio: Decimal | None
    expense_ratio_override: Decimal | None
    category: str | None
    active: bool
    provider_symbol: str | None
    fetch_symbol: str | None
    pricing_mode: str
    transaction_count: int
    latest_price_date: date | None


@dataclass(frozen=True)
class UpdateResult:
    view: InstrumentView
    changed: list[str]
    #: The price mapping changed: re-download this instrument's history
    #: (maintenance job ``prices.redownload``) so old closes don't linger.
    redownload_suggested: bool


def _views(session: Session, ids: set[int] | None = None) -> list[InstrumentView]:
    instruments = [
        i for i in instruments_repo.list_instruments(session) if ids is None or i.id in ids
    ]
    with config_read_session(session) as cfg:
        overrides = instrument_overrides_repo.get_override_map(cfg, [i.id for i in instruments])
    counts = instruments_repo.transaction_counts(session)
    latest = prices_service.latest_price_dates_for(session, [i.id for i in instruments])
    out: list[InstrumentView] = []
    for instr in instruments:
        ov = overrides.get(instr.id)
        eff = effective_instrument(instr, ov)
        synthetic = eff.asset_class in {"cash", "savings"}
        out.append(
            InstrumentView(
                id=instr.id,
                symbol=instr.symbol,
                name=eff.name,
                ledger_name=instr.name,
                name_override=ov.name_override if ov else None,
                asset_class=eff.asset_class,
                ledger_asset_class=instr.asset_class,
                asset_class_override=ov.asset_class_override if ov else None,
                native_currency=instr.native_currency,
                expense_ratio=eff.expense_ratio,
                expense_ratio_override=ov.expense_ratio_override if ov else None,
                category=eff.category,
                active=eff.active,
                provider_symbol=eff.provider_symbol,
                fetch_symbol=(
                    None
                    if synthetic or not eff.active or not is_fetched(eff.pricing_mode)
                    else fetch_symbol(instr.symbol, eff.provider_symbol)
                ),
                pricing_mode=eff.pricing_mode,
                transaction_count=counts.get(instr.id, 0),
                latest_price_date=latest.get(instr.id),
            )
        )
    return out


def list_instruments(session: Session) -> list[InstrumentView]:
    """Every instrument, ordered by symbol, with its effective settings."""
    return _views(session)


def get_instrument(session: Session, instrument_id: int) -> InstrumentView:
    rows = _views(session, {instrument_id})
    if not rows:
        raise NotFoundError(f"instrument {instrument_id} not found")
    return rows[0]


# -- validation ---------------------------------------------------------------------


def _text(value: Any, limit: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("must be text")
    cleaned = value.strip()
    if len(cleaned) > limit:
        raise ValueError(f"at most {limit} characters")
    return cleaned or None


def _clean(field: str, value: Any) -> Any:  # noqa: PLR0911, PLR0912 - one branch per field
    if field == "name":
        return _text(value, _MAX_NAME)
    if field == "category":
        return _text(value, _MAX_CATEGORY)
    if field == "asset_class":
        cleaned = _text(value, 16)
        if cleaned is not None and cleaned not in ASSET_CLASSES:
            raise ValueError(f"one of {', '.join(ASSET_CLASSES)}")
        return cleaned
    if field == "expense_ratio":
        if value is None or value == "":
            return None
        if isinstance(value, bool | float):
            raise ValueError("send the TER as a string or integer, as a fraction (0.0003)")
        try:
            ter = Decimal(str(value).strip())
        except InvalidOperation as exc:
            raise ValueError("not a number") from exc
        if not ter.is_finite() or ter < 0 or ter > _MAX_TER:
            raise ValueError(f"a fraction between 0 and {_MAX_TER}")
        return ter
    if field == "active":
        if not isinstance(value, bool):
            raise ValueError("must be true or false")
        return value
    if field == "provider_symbol":
        cleaned = _text(value, 32)
        if cleaned is None:
            return None
        upper = cleaned.upper()
        if not _SYMBOL_RE.match(upper):
            raise ValueError(f"{cleaned!r} is not a valid ticker")
        return upper
    if field == "pricing_mode":
        if value not in PRICING_MODES:
            raise ValueError(f"one of {', '.join(PRICING_MODES)}")
        return value
    raise ValueError("not editable")  # pragma: no cover - filtered by the caller


def _validate(
    session: Session, instrument_id: int, symbol: str, changes: Mapping[str, Any]
) -> dict[str, Any]:
    errors: dict[str, str] = {}
    typed: dict[str, Any] = {}
    for field, value in changes.items():
        if field not in EDITABLE:
            errors[field] = "not editable"
            continue
        try:
            typed[field] = _clean(field, value)
        except ValueError as exc:
            errors[field] = str(exc)
    mapped = typed.get("provider_symbol")
    if mapped:
        if mapped == symbol:
            typed["provider_symbol"] = None  # same as the ledger symbol: no mapping
        else:
            with config_read_session(session) as cfg:
                taken = instrument_overrides_repo.provider_symbol_map(cfg)
            clash = instruments_repo.get_by_symbol(session, mapped)
            if (clash is not None and clash.id != instrument_id) or any(
                sym == mapped and iid != instrument_id for iid, sym in taken.items()
            ):
                errors["provider_symbol"] = f"{mapped} already prices another instrument"
    if errors:
        raise InstrumentEditError(errors)
    return typed


_FIELD_TO_COLUMN = {
    "name": "name_override",
    "asset_class": "asset_class_override",
    "expense_ratio": "expense_ratio_override",
    "category": "category",
    "active": "active",
    "provider_symbol": "provider_symbol",
    "pricing_mode": "pricing_mode",
}


def update_instrument(
    session: Session,
    instrument_id: int,
    changes: Mapping[str, Any],
    *,
    actor: str,
) -> UpdateResult:
    """Validate ``changes`` (all or nothing) and store them as overrides.

    ``None`` / ``""`` clears an override (back to the ledger value). Pricing mode
    ``auto`` is stored as ``NULL``.
    """
    instr = instruments_repo.get_instrument(session, instrument_id)
    if instr is None:
        raise NotFoundError(f"instrument {instrument_id} not found")
    typed = _validate(session, instrument_id, instr.symbol, changes)
    before = get_instrument(session, instrument_id)
    with config_write_session(session) as cfg:
        current = instrument_overrides_repo.get(cfg, instrument_id)
        kwargs: dict[str, Any] = {}
        changed: list[str] = []
        for field, value in typed.items():
            column = _FIELD_TO_COLUMN[field]
            stored = None if field == "pricing_mode" and value == PRICING_AUTO else value
            old = getattr(current, column) if current is not None else None
            if field == "active" and current is None:
                old = True
            if old != stored:
                kwargs[column] = stored
                changed.append(field)
        if kwargs:
            instrument_overrides_repo.upsert(cfg, instrument_id, **kwargs)
    remap = "provider_symbol" in changed or (
        "pricing_mode" in changed and typed.get("pricing_mode") == PRICING_AUTO
    )
    if {"asset_class", "active", "provider_symbol", "pricing_mode"} & set(changed):
        _valuations_changed(session)
    if changed:
        activity("changes").info(
            "instrument %s (id %d) edited by %s: %s",
            instr.symbol,
            instrument_id,
            actor,
            ", ".join(sorted(changed)),
        )
    return UpdateResult(
        view=get_instrument(session, instrument_id) if changed else before,
        changed=changed,
        redownload_suggested=remap,
    )


def _valuations_changed(session: Session) -> None:
    """A pricing or class change can move any historic value: rebuild lazily."""
    from investment_dashboard.services import refresh_status, snapshots_service  # noqa: PLC0415

    snapshots_service.invalidate_all(session)
    refresh_status._publish({"type": "refresh", "reason": "instrument settings"})
