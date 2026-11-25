"""Journey fields other read models add to their rows (7.4 contract §8, "Other additions").

Each function is pure over :class:`readmodels.currency_journey.JourneyInputs` and
returns plain values; the owning read model adds them to its payload with one line
(see each docstring). :func:`inputs_for` gives the cached inputs for a session, or
``None`` before the pool service exists, in which case every hook is a no-op.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from decimal import Decimal
from typing import Any, Literal

from investment_dashboard.domain import kinds
from investment_dashboard.domain.cash_pool import OUTSIDE_ACCOUNT
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.readmodels.currency_journey import (
    VS_IMPACT_NOTE,
    ZERO,
    JourneyInputs,
    TxnInfo,
    build_journey,
    context_for,
    fees_of,
    load_inputs_cached,
    origin_usd,
    rate4,
    your_rates,
)

EurBasis = Literal["your_rate", "pool", "ecb", "native"]
TrailKind = Literal["deposit", "buy", "sell", "withdrawal"]


def inputs_for(session: Any) -> JourneyInputs | None:
    return load_inputs_cached(session)


# ----------------------------------------------------------------- Overview card


def lifetime_fields(inputs: JourneyInputs) -> dict[str, Any]:
    """The rebuilt ``CurrencyLifetime`` fields (contract §8).

    ``fx_pnl_eur`` is the journey bridge total and ``breakeven_rate`` your rate.
    Hook (``readmodels/overview.py`` ``_currency_block``): ``lifetime.update(...)``.
    """
    j = build_journey(inputs)
    realised = sum((c.realised_eur for c in j.cash_outs), ZERO) if j.cash_outs else None
    return {
        "your_rate": dec(rate4(j.your_rate)),
        "ecb_avg": dec(rate4(j.ecb_avg)),
        "conversion_cost_eur": dec(j.conversion_cost_eur),
        "realised_eur": dec(realised),
        "vs_impact_note": VS_IMPACT_NOTE,
        "breakeven_rate": dec(j.your_rate),
        "fx_pnl_eur": dec(j.bridge_total),
    }


def lifetime_overrides(session: Any) -> dict[str, Any]:
    """:func:`lifetime_fields` for a session; ``{}`` (no change) without a pool."""
    inputs = inputs_for(session)
    return {} if inputs is None else lifetime_fields(inputs)


def holdings_fx_your_rate(inputs: JourneyInputs) -> str | None:
    """Holdings KPI ``fx_your_rate`` (the FX tile hint)."""
    return dec(rate4(your_rates(inputs)[0]))


# ------------------------------------------------------------------ one holding


def holding_your_rate(inputs: JourneyInputs, instrument_id: int) -> Decimal | None:
    """Dollars per original euro behind a holding (its conversions' blend, all accounts)."""
    ctx = context_for(inputs)
    usd = eur = ZERO
    for (_acc, inst), h in inputs.snapshot.state.holdings.items():
        if inst != instrument_id or h.shares <= 0:
            continue
        conv = [o for o in h.origins if o.conversion_id is not None and o.eur != 0]
        usd += origin_usd(ctx, conv)
        eur += sum((o.eur for o in conv), ZERO)
    return usd / eur if eur > 0 else None


def ecb_buy_avg(inputs: JourneyInputs, instrument_id: int) -> Decimal | None:
    """The ECB fixing on the holding's buy days, weighted by the dollars of each buy."""
    usd = at_ecb = ZERO
    for t in inputs.txns.values():
        if t.kind != kinds.BUY or t.instrument_id != instrument_id or t.amount <= 0:
            continue
        if t.id not in inputs.snapshot.state.buy_cost_eur:
            continue  # a money-market sweep
        r = inputs.ecb_rate(t.ccy, t.date)
        if r is None or r <= 0:
            continue
        usd += t.amount
        at_ecb += t.amount / r
    return usd / at_ecb if at_ecb > 0 else None


def fx_effect_pp(growth_eur: Decimal | None, growth_usd: Decimal | None) -> Decimal | None:
    """EUR growth minus USD growth (each computed on its own): a residual, in points."""
    if growth_eur is None or growth_usd is None:
        return None
    return growth_eur - growth_usd


def key_facts_fields(
    inputs: JourneyInputs,
    instrument_id: int,
    *,
    growth_eur: Decimal | None,
    growth_usd: Decimal | None,
) -> dict[str, Any]:
    """Holding performance ``KeyFacts``: ``your_rate``, ``ecb_buy_avg``, ``fx_effect_pp``."""
    return {
        "your_rate": dec(rate4(holding_your_rate(inputs, instrument_id))),
        "ecb_buy_avg": dec(rate4(ecb_buy_avg(inputs, instrument_id))),
        "fx_effect_pp": dec(fx_effect_pp(growth_eur, growth_usd)),
    }


def peek_your_rate(inputs: JourneyInputs, instrument_id: int) -> str | None:
    """``HoldingPeek.your_rate``."""
    return dec(rate4(holding_your_rate(inputs, instrument_id)))


# --------------------------------------------------------------------- tranches


def _sale_back_in_euros(inputs: JourneyInputs, sell_txn_id: int) -> bool:
    """True once every dollar of a sale has gone back to euros (via a withdrawal)."""
    state = inputs.snapshot.state
    sale_lot = f"sale:{sell_txn_id}:0"
    if any(lot.lot_id == sale_lot for lot in state.lots):
        return False
    withdrawals: list[str] = []
    seen = False
    for d in state.draws:
        if d.lot_id != sale_lot:
            continue
        seen = True
        t = inputs.txns.get(d.event_txn_id) if d.event_txn_id is not None else None
        if t is None or t.kind not in (kinds.WITHDRAWAL, kinds.TRANSFER_OUT):
            return False  # spent again inside the broker: still in dollars
        backs = {id(x) for ds in state.conversions_back.values() for x in ds}
        mine = [x for x in state.draws if x.event_txn_id == t.id and id(x) not in backs]
        n = next(i for i, x in enumerate(mine) if x is d)
        withdrawals.append(f"withdrawal:{t.id}:{n}")
    if not seen:
        return False
    outside = {lot.lot_id for lot in state.lots if lot.account_key == OUTSIDE_ACCOUNT}
    return not any(w in outside for w in withdrawals)


def tranche_fields(
    inputs: JourneyInputs,
    *,
    account_id: int,
    instrument_id: int,
    cost_native: Decimal,
    value_native: Decimal | None,
    sell_txn_id: int | None = None,
) -> dict[str, Any]:
    """``TrancheRowOut`` journey fields (pro rata by native cost, FIFO view).

    ``cost_eur`` / ``orig_eur`` are the holding's pool EUR times this tranche's share
    of its native cost; ``gain_eur = value / rate_now - cost_eur`` splits into
    ``market_eur = (value - cost_native) / rate_now`` and the currency rest.
    ``back_in_euros``: ``None`` while held, then whether the sale's dollars have gone
    back to euros.
    """
    h = inputs.snapshot.state.holdings.get((account_id, instrument_id))
    out: dict[str, Any] = {
        "cost_eur": None,
        "orig_eur": None,
        "your_rate": None,
        "gain_eur": None,
        "market_eur": None,
        "currency_eur": None,
        "back_in_euros": None if sell_txn_id is None else _sale_back_in_euros(inputs, sell_txn_id),
    }
    if h is None or h.cost_native <= 0 or sell_txn_id is not None:
        return out
    share = cost_native / h.cost_native
    cost = h.book_eur * share
    orig = h.orig_eur * share
    out.update(
        cost_eur=dec(cost),
        orig_eur=dec(orig),
        your_rate=dec(rate4(holding_your_rate(inputs, instrument_id))),
    )
    rate = inputs.rate_now
    if value_native is not None and rate is not None:
        gain = value_native / rate - cost
        market = (value_native - cost_native) / rate
        out.update(gain_eur=dec(gain), market_eur=dec(market), currency_eur=dec(gain - market))
    return out


# ----------------------------------------------------------------- transactions


def transaction_fields(inputs: JourneyInputs, txn: TxnInfo) -> dict[str, Any]:
    """Transaction record ``eur_basis`` and ``trail_kind``.

    ``your_rate``: a deposit matched to conversions; ``pool``: a buy priced from the
    cash pool; ``ecb``: an ECB fallback (deposit or uncovered buy) or any other
    dollar row; ``native``: a row in a euro account (no conversion).
    """
    snap = inputs.snapshot
    state = snap.state
    basis: EurBasis = "ecb"
    if txn.ccy.upper() == "EUR":
        basis = "native"
    elif txn.kind == kinds.DEPOSIT:
        m = next((x for x in snap.deposit_matches.deposits if x.deposit_id == txn.id), None)
        if m is not None and m.matched_usd > 0:
            basis = "your_rate"
    elif txn.kind == kinds.BUY and txn.id in state.buy_cost_eur and snap.basis == "pool":
        basis = "ecb" if txn.id in state.uncovered else "pool"
    trail: TrailKind | None = None
    if txn.ccy.upper() != "EUR":
        if txn.kind == kinds.DEPOSIT:
            trail = "deposit"
        elif txn.kind == kinds.BUY and txn.id in state.buy_cost_eur:
            trail = "buy"
        elif txn.kind == kinds.SELL and txn.id in state.sale_market_eur:
            trail = "sell"
        elif txn.kind in (kinds.WITHDRAWAL, kinds.TRANSFER_OUT) and any(
            d.event_txn_id == txn.id for d in state.draws
        ):
            trail = "withdrawal"
    return {"eur_basis": basis, "trail_kind": trail}


# ------------------------------------------------------------ Deposits / Periods


def cashed_out_eur(
    inputs: JourneyInputs, start: date | None = None, end: date | None = None
) -> Decimal:
    """Euros that came back (received minus fees) from cash-outs dated in ``[start, end]``.

    ``0`` when there is none (the Deposits page and each Periods row).
    """
    total = ZERO
    for co in inputs.snapshot.cash_outs:
        if (start is None or co.date >= start) and (end is None or co.date <= end):
            total += co.eur_received - fees_of(co)
    return total


def cashed_out_by_period(
    inputs: JourneyInputs, *, by: Literal["month", "year"]
) -> Mapping[str, Decimal]:
    """``cashed_out_eur`` per ``YYYY-MM`` or ``YYYY`` key."""
    out: dict[str, Decimal] = {}
    for co in inputs.snapshot.cash_outs:
        key = co.date.strftime("%Y-%m" if by == "month" else "%Y")
        out[key] = out.get(key, ZERO) + co.eur_received - fees_of(co)
    return out
