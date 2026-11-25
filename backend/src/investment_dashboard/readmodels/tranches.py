"""``GET /api/holdings/{instrument_id}/tranches``: the FIFO purchase-tranche view.

Native figures per tranche, plus (7.4) the EUR cost of the shares still held: the
cash-pool EUR of the holding shared out by native cost (see :func:`_eur_costs`). The
rows come from :mod:`investment_dashboard.domain.tranches`;
today's price and the position's share count come from ``positions_service``, so
the gain is valued exactly as the holding row values its shares. Tranche figures
never feed an aggregate.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.domain import tranches as tranches_domain
from investment_dashboard.domain.instruments import is_money_market_effective
from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.readmodels import journey_fields as jf
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.repositories import (
    accounts_repo,
    instrument_overrides_repo,
    instruments_repo,
    transactions_repo,
)
from investment_dashboard.services import (
    cash_pool_service,
    fx_service,
    positions_service,
    prices_service,
)
from investment_dashboard.services.instrument_enrichment_service import effective_instrument

ZERO = Decimal(0)


def build(session: Session, instrument_id: int) -> dict[str, Any] | None:
    """The tranche view of one instrument, or ``None`` when it does not exist."""
    instr = instruments_repo.get_instrument(session, instrument_id)
    if instr is None:
        return None
    as_of = exchange_today()
    overrides = instrument_overrides_repo.get_override_map(session, [instrument_id])
    money_market = is_money_market_effective(
        instr, effective_instrument(instr, overrides.get(instrument_id))
    )
    txns = [
        tranches_domain.TrancheTxn(
            id=t.id,
            account_id=t.account_id,
            date=t.date,
            kind=t.kind,
            quantity=t.quantity,
            net_native=t.net_native,
            price_native=t.price_native,
        )
        for t in transactions_repo.list_transactions(
            session, instrument_id=instrument_id, end=as_of
        )
    ]
    tranches = tranches_domain.replay(txns, money_market=money_market)

    held = [
        p
        for p in positions_service.compute_positions(session, as_of=as_of)
        if p.instrument.id == instrument_id
    ]
    position_quantity = sum((p.shares for p in held), start=ZERO)
    price = next((p.current_price_native for p in held if p.current_price_native), None)
    if price is None:
        price = prices_service.latest_closes(session, [instrument_id]).get(instrument_id)

    view = tranches_domain.build_view(
        tranches, as_of=as_of, price_native=price, position_quantity=position_quantity
    )
    names = {a.id: a.account_label for a in accounts_repo.list_accounts(session)}
    currency = next((p.account.native_currency for p in held), instr.native_currency).upper()
    native_of = {a.id: a.native_currency.upper() for a in accounts_repo.list_accounts(session)}
    snapshot = cash_pool_service.build_pool_snapshot(session, as_of=as_of)
    eur = _eur_costs(session, view.rows, instrument_id, snapshot, native_of)
    inputs = jf.inputs_for(session) if snapshot.basis == "pool" else None
    rows = [_row(r, names, eur.get(r.tranche.id)) for r in view.rows]
    if inputs is not None:
        for r, row in zip(view.rows, rows, strict=True):
            t = r.tranche
            value = t.quantity_left * price if price is not None else None
            fields = jf.tranche_fields(
                inputs,
                account_id=t.account_id,
                instrument_id=instrument_id,
                cost_native=t.cost_native,
                value_native=value,
            )
            # a EUR account (or no pool holding) keeps its own cost
            row.update({k: v for k, v in fields.items() if v is not None or k not in row})
    return {
        "instrument_id": instrument_id,
        "symbol": instr.symbol,
        "currency": currency,
        "method": "fifo_view",
        "eur_basis": snapshot.basis,
        "as_of": as_of.isoformat(),
        "price_native": dec(price),
        "rows": rows,
        "groups": [
            {
                "account_id": g.account_id,
                "source": "reinvest",
                "count": g.count,
                "quantity_left": dec(g.quantity_left),
                "cost_native": dec(g.cost_native),
                "avg_cost_per_share_native": dec(g.avg_cost_per_share_native),
                "gain_native": dec(g.gain_native),
                "gain_pct": dec(g.gain_pct),
                "long_count": g.long_count,
                "short_count": g.short_count,
                "row_ids": list(g.row_ids),
            }
            for g in view.groups
        ],
        "totals": {
            "quantity_left": dec(view.totals.quantity_left),
            "position_quantity": dec(view.totals.position_quantity),
            "matches_position": view.totals.matches_position,
            "long_quantity": dec(view.totals.long_quantity),
            "short_quantity": dec(view.totals.short_quantity),
            "fully_sold_count": view.totals.fully_sold_count,
        },
    }


def _eur_costs(
    session: Session,
    rows: Sequence[tranches_domain.TrancheRow],
    instrument_id: int,
    snapshot: cash_pool_service.PoolSnapshot,
    native_of: Mapping[int, str],
) -> dict[int, tuple[Decimal, Decimal]]:
    """Tranche id -> ``(cost_eur, orig_eur)`` of the shares still held.

    ``pool``: the holding's pool EUR (book and original euros, per account) shared
    out over its open tranches by ``cost_native`` (a FIFO view of an average-cost
    figure, so the rows of one account add up to the holding's EUR cost).
    ``buy_date``: each tranche's native cost at the settled ECB fixing of its own
    acquisition date (the 7.3.1 basis). A EUR account's cost is its own. A tranche
    with no EUR figure (a money-market fund, a missing rate) is left out.
    """
    out: dict[int, tuple[Decimal, Decimal]] = {}
    by_account: dict[int, list[tranches_domain.TrancheRow]] = {}
    for r in rows:
        by_account.setdefault(r.tranche.account_id, []).append(r)
    for account_id, group in by_account.items():
        ccy = native_of.get(account_id, "EUR")
        if ccy == "EUR":
            for r in group:
                out[r.tranche.id] = (r.tranche.cost_native, r.tranche.cost_native)
            continue
        if snapshot.basis == "buy_date":
            for r in group:
                rate = fx_service.get_settled_rate(
                    session, r.tranche.acquired_on, base="EUR", quote=ccy
                )
                if rate:
                    eur = r.tranche.cost_native / rate
                    out[r.tranche.id] = (eur, eur)
            continue
        holding = snapshot.state.holdings.get((account_id, instrument_id))
        total = sum((r.tranche.cost_native for r in group), ZERO)
        if holding is None or total <= 0:
            continue
        for r in group:
            share = r.tranche.cost_native / total
            out[r.tranche.id] = (holding.book_eur * share, holding.orig_eur * share)
    return out


def _row(
    r: tranches_domain.TrancheRow,
    names: dict[int, str],
    eur: tuple[Decimal, Decimal] | None = None,
) -> dict[str, Any]:
    t = r.tranche
    return {
        "cost_eur": None if eur is None else dec(eur[0]),
        "orig_eur": None if eur is None else dec(eur[1]),
        "id": t.id,
        "account_id": t.account_id,
        "account_name": names.get(t.account_id, ""),
        "acquired_on": t.acquired_on.isoformat(),
        "source": t.source,
        "quantity_bought": dec(t.quantity_bought),
        "quantity_left": dec(t.quantity_left),
        "cost_per_share_native": dec(t.cost_per_share_native),
        "cost_native": dec(t.cost_native),
        "age_days": r.age_days,
        "long_term_on": r.long_term_on.isoformat(),
        "days_to_long_term": r.days_to_long_term,
        "status": r.status,
        "gain_native": dec(r.gain_native),
        "gain_pct": dec(r.gain_pct),
    }
