"""Allocations read-model: current mix, saved targets, drift, and saving a target.

💱 CURRENCY (rule in ``AGENTS.md``): ratios are fractions (0.01 = 1 %) of same-instant
values (currency-neutral). A USD *value* is the EUR value times the EUR->USD
spot - a single-instant conversion; it is ``None`` when no spot exists.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.domain.allocation import current_weights_pct
from investment_dashboard.errors import ConflictError, ValidationError
from investment_dashboard.readmodels._context import build_context
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.readmodels.rebalance import round_to_100, scale_to_100
from investment_dashboard.repositories import allocations_repo, instruments_repo
from investment_dashboard.services.positions_service import Position, compute_positions

ZERO = Decimal(0)
HUNDRED = Decimal(100)
UNCATEGORIZED = "Uncategorized"


class AllocationInputError(ValidationError):
    """The submitted target is invalid (maps to HTTP 422)."""


class AllocationConflictError(ConflictError):
    """The submitted target clashes with an existing one (maps to HTTP 409)."""


def _val(value_eur: Decimal, ccy: str, fx: Decimal | None) -> Decimal | None:
    if ccy == "EUR":
        return value_eur
    return value_eur * fx if fx is not None and fx > ZERO else None


def serialize_targets(session: Session) -> list[dict[str, Any]]:
    """Saved targets with their items (symbol + category resolved)."""
    instruments = {i.id: i for i in instruments_repo.list_instruments(session)}
    out: list[dict[str, Any]] = []
    for alloc in allocations_repo.list_allocations(session):
        items = [
            {
                "instrument_id": item.instrument_id,
                "symbol": instruments[item.instrument_id].symbol,
                "weight_pct": dec(item.weight_pct / HUNDRED),  # stored as percent -> fraction
                "no_buy": bool(item.no_buy),
            }
            for item in alloc.items
            if item.instrument_id in instruments
        ]
        out.append(
            {
                "id": alloc.id,
                "name": alloc.name,
                "active": bool(alloc.active),
                "allow_sell": bool(alloc.allow_sell),
                "display_currency": alloc.display_currency,
                "items": items,
            }
        )
    return out


@dataclass
class _InstrumentAgg:
    instrument_id: int
    symbol: str
    name: str
    category: str
    asset_class: str
    value_eur: Decimal


def _aggregate(positions: list[Position]) -> dict[int, _InstrumentAgg]:
    out: dict[int, _InstrumentAgg] = {}
    for p in positions:
        eff = p.effective
        asset_class = (eff.asset_class if eff is not None else p.instrument.asset_class) or ""
        name = (eff.name if eff is not None else p.instrument.name) or p.instrument.symbol
        agg = out.get(p.instrument.id)
        if agg is None:
            out[p.instrument.id] = _InstrumentAgg(
                instrument_id=p.instrument.id,
                symbol=p.instrument.symbol,
                name=name,
                category=p.category or asset_class or UNCATEGORIZED,
                asset_class=asset_class or UNCATEGORIZED,
                value_eur=p.current_value_eur,
            )
        else:
            agg.value_eur += p.current_value_eur
    return out


def _buckets(
    aggs: list[_InstrumentAgg], attr: str, total: Decimal, ccy: str, fx: Decimal | None
) -> list[dict[str, Any]]:
    bucket: dict[str, Decimal] = {}
    for a in aggs:
        key = getattr(a, attr)
        bucket[key] = bucket.get(key, ZERO) + a.value_eur
    rows = [(k, v) for k, v in bucket.items() if v > ZERO]
    rows.sort(key=lambda kv: kv[1], reverse=True)
    return [
        {
            "label": k,
            "value": dec(_val(v, ccy, fx)),
            "pct": dec(v / total if total > ZERO else ZERO),
        }
        for k, v in rows
    ]


def build(session: Session, *, ccy: str, as_of: date | None = None) -> dict[str, Any]:
    """The ``GET /api/allocations`` payload."""
    ctx = build_context(session, as_of=as_of)
    fx = ctx.fx_rate_eur_usd
    positions = compute_positions(session, as_of=ctx.as_of)
    aggs = _aggregate(positions)
    total = sum((a.value_eur for a in aggs.values()), start=ZERO)
    targets = serialize_targets(session)

    drift: list[dict[str, Any]] = []
    active = next((t for t in targets if t["active"]), None)
    if active is not None:
        symbols = {i.id: i.symbol for i in instruments_repo.list_instruments(session)}
        target_pct = {
            item["instrument_id"]: Decimal(item["weight_pct"]) * HUNDRED for item in active["items"]
        }
        ids = set(aggs) | set(target_pct)
        values = {i: aggs[i].value_eur if i in aggs else ZERO for i in ids}
        current_pct = current_weights_pct(values)
        for iid in sorted(
            ids, key=lambda i: abs(current_pct[i] - target_pct.get(i, ZERO)), reverse=True
        ):
            agg = aggs.get(iid)
            tgt = target_pct.get(iid, ZERO)
            cur = current_pct[iid]
            target_value_eur = total * tgt / HUNDRED
            drift.append(
                {
                    "key": str(iid),
                    "instrument_id": iid,
                    "label": agg.symbol if agg else symbols.get(iid, str(iid)),
                    "category": agg.category if agg else UNCATEGORIZED,
                    "asset_class": agg.asset_class if agg else UNCATEGORIZED,
                    "current_pct": dec(cur / HUNDRED),
                    "target_pct": dec(tgt / HUNDRED),
                    "drift_pp": dec(cur - tgt),
                    "current_value": dec(_val(values[iid], ccy, fx)),
                    "delta_value": dec(_val(target_value_eur - values[iid], ccy, fx)),
                }
            )

    agg_list = list(aggs.values())
    return {
        "ccy": ccy,
        "as_of": ctx.as_of.isoformat(),
        "total_value": dec(_val(total, ccy, fx)),
        "targets": targets,
        "active_target_id": active["id"] if active else None,
        "drift": drift,
        "current_by_category": _buckets(agg_list, "category", total, ccy, fx),
        "current_by_asset_class": _buckets(agg_list, "asset_class", total, ccy, fx),
    }


def save_target(
    session: Session,
    *,
    target_id: int | None,
    name: str,
    active: bool,
    allow_sell: bool,
    display_currency: str | None,
    items: list[tuple[int, Decimal, bool]],
) -> dict[str, Any]:
    """Create or replace a saved target (weights normalised to 100).

    ``items`` are ``(instrument_id, weight, no_buy)``; weights are relative and
    normalised, so the input unit (fraction or percent) does not matter. With ``target_id`` the
    existing allocation is updated in place (its id is kept). Raises :class:`AllocationInputError` / :class:`AllocationConflictError`.
    """
    name = name.strip()
    if not name:
        raise AllocationInputError("Name is required")
    known = {i.id for i in instruments_repo.list_instruments(session)}
    raw: dict[int, Decimal] = {}
    for iid, weight, _no_buy in items:
        if iid not in known:
            raise AllocationInputError(f"Unknown instrument id {iid}")
        if weight < ZERO:
            raise AllocationInputError("Weights must not be negative")
        raw[iid] = raw.get(iid, ZERO) + weight
    weights = round_to_100(scale_to_100(raw))
    if not weights:
        raise AllocationInputError("Set at least one positive weight")
    no_buy = {iid for iid, _w, nb in items if nb and iid in weights}

    existing = list(allocations_repo.list_allocations(session))
    current = next((a for a in existing if a.id == target_id), None) if target_id else None
    if target_id is not None and current is None:
        raise AllocationInputError(f"Unknown target id {target_id}")
    clash = next((a for a in existing if a.name == name and a is not current), None)
    if clash is not None:
        raise AllocationConflictError(f"A target named '{name}' already exists")
    if current is not None:
        created = allocations_repo.update_allocation(
            session,
            current,
            name,
            weights,
            active=active,
            no_buy_ids=no_buy,
            allow_sell=allow_sell,
            display_currency=display_currency,
        )
    else:
        created = allocations_repo.create_allocation(
            session,
            name,
            weights,
            active=active,
            no_buy_ids=no_buy,
            allow_sell=allow_sell,
            display_currency=display_currency,
        )
    session.flush()
    saved = next(t for t in serialize_targets(session) if t["id"] == created.id)
    return saved
