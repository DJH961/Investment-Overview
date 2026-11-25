"""The money trail: one transaction's dollars, step by step (7.4 contract §8).

``GET /api/trail/{kind}/{id}`` for a deposit, buy, sell, withdrawal or conversion. A
trail is derived from the cash pool's draws and origins (never stored):

* **upstream** (where the dollars came from): each origin's conversion (``sent`` ->
  ``converted``), the days they waited, the deposit; a sale's proceeds keep their
  cost (``sold``); a withdrawal moves them to the USD account (``withdrawn``);
* **downstream** (where they went): ``bought`` -> ``worth_now``, ``withdrawn``,
  ``back`` in euros, or still waiting.

One path per (draw, conversion origin): a buy paid from two deposits has two paths.
The first :data:`MAX_PATHS` are sent; ``more_paths`` counts the rest. Every step's
``detail`` is at most :data:`DETAIL_MAX` characters (the trail's aligned rows never
wrap).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_EVEN, Decimal
from typing import Any

from investment_dashboard.domain import kinds
from investment_dashboard.domain.cash_pool import Draw, Origin, PoolLot
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.readmodels.currency_journey import (
    CENT,
    RATE_DP,
    ZERO,
    JourneyInputs,
    context_for,
    draw_embedded,
    origin_usd,
)

MAX_PATHS = 3
DETAIL_MAX = 24
KINDS = ("deposit", "buy", "sell", "withdrawal", "conversion")


def _detail(text: str | None) -> str | None:
    if text is None or len(text) <= DETAIL_MAX:
        return text
    return text[: DETAIL_MAX - 1] + "…"


def _money(x: Decimal) -> str:
    return dec(x.quantize(CENT, rounding=ROUND_HALF_EVEN)) or "0"


def _r(x: Decimal | None) -> str | None:
    return None if x is None else dec(x.quantize(RATE_DP, rounding=ROUND_HALF_EVEN))


def _step(
    key: str,
    on: date | None,
    label: str,
    figure: str | None,
    ccy: str | None,
    detail: str | None = None,
    link: str | None = None,
) -> dict[str, Any]:
    return {
        "key": key,
        "date": on.isoformat() if on is not None else None,
        "label": label,
        "figure": figure,
        "figure_ccy": ccy,
        "detail": _detail(detail),
        "link": link,
    }


@dataclass
class _Path:
    usd: Decimal
    steps: list[dict[str, Any]]
    flagged: bool = False


class _Trail:
    def __init__(self, inputs: JourneyInputs) -> None:
        self.inputs = inputs
        self.ctx = context_for(inputs)
        self.state = inputs.snapshot.state
        self.backs = {id(d): cid for cid, ds in self.state.conversions_back.items() for d in ds}
        self.convs = {b.id: b for b in inputs.conversions}
        self.matches = {m.deposit_id: m for m in inputs.snapshot.deposit_matches.deposits}
        self.cash_outs = {c.conversion_id: c for c in inputs.snapshot.cash_outs}

    # ------------------------------------------------------------------ pieces

    def ecb(self, on: date) -> Decimal | None:
        r = self.inputs.ecb_rate("USD", on)
        return r if r is not None and r > 0 else None

    def _sym(self, txn_id: int | None) -> str:
        t = self.inputs.txns.get(txn_id) if txn_id is not None else None
        return (t.symbol if t is not None and t.symbol else "") or "holding"

    def conversion_steps(self, o: Origin) -> list[dict[str, Any]]:
        b = self.convs.get(o.conversion_id) if o.conversion_id is not None else None
        if b is None:
            return []
        usd = origin_usd(self.ctx, (o,))
        rate = b.usd_received / b.eur_cost if b.eur_cost > 0 else None
        ecb = self.ecb(b.date)
        detail = f"at {_r(rate)}" + (f" · ECB {_r(ecb)}" if ecb is not None else "")
        link = f"/conversions?highlight={b.id}"
        return [
            _step("sent", b.date, "€ sent", _money(o.eur), "EUR", "your conversion", link),
            _step("converted", b.date, "$ received", _money(usd), "USD", detail, link),
        ]

    def lot_source(self, lot_id: str) -> tuple[str, int | None]:
        head, _, rest = lot_id.partition(":")
        num = rest.partition(":")[0]
        return head, int(num) if num.lstrip("-").isdigit() else None

    def upstream(self, lot_id: str, origin: Origin | None, usd: Decimal) -> _Path:
        """Steps from the euros to the point the dollars left ``lot_id``."""
        head, src = self.lot_source(lot_id)
        steps: list[dict[str, Any]] = []
        flagged = False
        if origin is not None:
            steps += self.conversion_steps(origin)
        t = self.inputs.txns.get(src) if src is not None else None
        if head in ("deposit", "fallback") and t is not None:
            b = self.convs.get(origin.conversion_id) if origin and origin.conversion_id else None
            if b is not None and (t.date - b.date).days > 0:
                days = (t.date - b.date).days
                steps.append(
                    _step("waited", b.date, "Waited", f"{days} days", None, "in your USD account")
                )
            fallback = head == "fallback" or not steps
            flagged = flagged or head == "fallback"
            steps.append(
                _step(
                    "deposited",
                    t.date,
                    "Deposited",
                    _money(usd),
                    "USD",
                    "at ECB, no conversion" if fallback else "to the broker",
                    f"/transactions?txn={t.id}",
                )
            )
        elif head == "sale" and t is not None:
            steps.append(
                _step(
                    "sold",
                    t.date,
                    f"Sold {self._sym(t.id)}",
                    _money(usd),
                    "USD",
                    "cost carried",
                    f"/transactions?txn={t.id}",
                )
            )
        elif head == "income" and t is not None:
            steps.append(
                _step(
                    "deposited",
                    t.date,
                    "Dividend" if t.kind != kinds.INTEREST else "Interest",
                    _money(usd),
                    "USD",
                    "at that day's ECB",
                    f"/transactions?txn={t.id}",
                )
            )
        elif head == "withdrawal" and t is not None:
            steps.append(self.withdrawn_step(t.id, t.date, usd))
        elif head in ("uncovered", "kept") or t is None:
            flagged = flagged or head == "uncovered"
        return _Path(usd, steps, flagged)

    def withdrawn_step(self, txn_id: int, on: date, usd: Decimal) -> dict[str, Any]:
        return _step(
            "withdrawn",
            on,
            "Withdrawn",
            _money(usd),
            "USD",
            "to your USD account",
            f"/transactions?txn={txn_id}",
        )

    def back_step(self, conversion_id: int, usd: Decimal) -> dict[str, Any]:
        co = self.cash_outs.get(conversion_id)
        if co is None or co.usd_sent <= 0:
            return _step("back", None, "Back in euros", None, "EUR")
        eur = co.eur_received * usd / co.usd_sent
        rate = co.usd_sent / co.eur_received if co.eur_received > 0 else None
        return _step(
            "back",
            co.date,
            "Back in euros",
            _money(eur),
            "EUR",
            f"at {_r(rate)}",
            f"/conversions?highlight={conversion_id}",
        )

    def worth_now(self, txn_id: int, usd: Decimal) -> dict[str, Any] | None:
        t = self.inputs.txns.get(txn_id)
        rate = self.inputs.rate_now
        if t is None or t.instrument_id is None:
            return None
        h = self.state.holdings.get((t.account_id, t.instrument_id))
        value = self.inputs.values.get((t.account_id, t.instrument_id))
        if h is None or h.shares <= 0 or value is None or h.cost_native <= 0 or rate is None:
            return None
        part = value * min(usd / h.cost_native, Decimal(1))
        return _step(
            "worth_now",
            self.inputs.today,
            "Worth now",
            _money(part / rate),
            "EUR",
            f"${_money(part)}",
            f"/holdings/{t.instrument_id}",
        )

    def bought_step(self, txn_id: int, usd: Decimal) -> dict[str, Any]:
        t = self.inputs.txns.get(txn_id)
        on = t.date if t is not None else None
        detail = None
        if t is not None and t.amount > 0 and t.quantity > 0:
            shares = (t.quantity * usd / t.amount).quantize(Decimal("0.001"))
            detail = f"{shares.normalize():f} sh"
        return _step(
            "bought",
            on,
            f"Bought {self._sym(txn_id)}",
            _money(usd),
            "USD",
            detail,
            f"/transactions?txn={txn_id}",
        )

    def downstream(self, lot_id: str, depth: int = 0) -> list[tuple[Decimal, list[dict[str, Any]]]]:
        """Where a lot's dollars went: one (usd, steps) per draw, plus what is left."""
        out: list[tuple[Decimal, list[dict[str, Any]]]] = []
        for d in self.state.draws:
            if d.lot_id != lot_id:
                continue
            back = self.backs.get(id(d))
            if back is not None:
                out.append((d.amount, [self.back_step(back, d.amount)]))
                continue
            t = self.inputs.txns.get(d.event_txn_id) if d.event_txn_id is not None else None
            if t is None:
                continue
            if t.kind == kinds.BUY:
                steps = [self.bought_step(t.id, d.amount)]
                now = self.worth_now(t.id, d.amount)
                if now is not None:
                    steps.append(now)
                out.append((d.amount, steps))
            elif t.kind in (kinds.WITHDRAWAL, kinds.TRANSFER_OUT):
                steps = [self.withdrawn_step(t.id, t.date, d.amount)]
                n = self.withdrawal_index(t.id, d)
                if depth < 2 and n is not None:
                    tail = self.downstream(f"withdrawal:{t.id}:{n}", depth + 1)
                    if tail:
                        steps += tail[0][1]
                out.append((d.amount, steps))
            elif t.kind == kinds.FEE:
                out.append((d.amount, [_step("bought", t.date, "Fee", _money(d.amount), "USD")]))
        left = next((x for x in self.state.lots if x.lot_id == lot_id), None)
        if left is not None and left.amount > 0:
            out.append((left.amount, [self.waiting_step(left)]))
        return out

    def waiting_step(self, lot: PoolLot) -> dict[str, Any]:
        outside = lot.account_key == "usd_account"
        rate = self.inputs.rate_now
        return _step(
            "worth_now",
            self.inputs.today,
            "In your USD account" if outside else "In broker cash",
            _money(lot.amount / rate) if rate is not None else _money(lot.amount),
            "EUR" if rate is not None else "USD",
            f"${_money(lot.amount)} waiting",
        )

    def withdrawal_index(self, withdrawal_id: int, draw: Draw) -> int | None:
        mine = [
            d
            for d in self.state.draws
            if d.event_txn_id == withdrawal_id and id(d) not in self.backs
        ]
        for n, d in enumerate(mine):
            if d is draw:
                return n
        return None

    # ------------------------------------------------------------------ paths

    def paths_for_draws(self, draws: Sequence[Draw], tail: Any, total: Decimal) -> list[_Path]:
        """One path per (draw, conversion origin); ``tail(draw, usd)`` adds the end steps."""
        paths: list[_Path] = []
        for d in draws:
            convs = [o for o in d.origins if o.conversion_id is not None and o.eur != 0]
            pieces: list[tuple[Origin | None, Decimal]] = []
            if convs and d.orig_eur > 0:
                for o in convs:
                    pieces.append((o, d.amount * o.eur / d.orig_eur))
            else:
                pieces.append((None, d.amount))
            for origin, usd in pieces:
                p = self.upstream(d.lot_id, origin, usd)
                p.flagged = p.flagged or d.flagged
                p.steps += tail(d, usd)
                paths.append(p)
        _ = total
        return paths


def _split(
    market: Decimal, currency: Decimal, cost: Decimal, total: Decimal | None = None
) -> dict[str, str]:
    q = [x.quantize(CENT, rounding=ROUND_HALF_EVEN) for x in (market, currency, cost)]
    return {
        "market_eur": dec(q[0]) or "0",
        "currency_eur": dec(q[1]) or "0",
        "conversion_cost_eur": dec(q[2]) or "0",
        "total_eur": dec(sum(q, ZERO)) or "0",
    }


def _out(
    kind: str,
    id_: int,
    paths: list[_Path],
    total: Decimal,
    *,
    split: dict[str, str] | None,
    your_rate: Decimal | None,
    ecb_rate: Decimal | None,
    flagged: bool = False,
) -> dict[str, Any]:
    shown = paths[:MAX_PATHS]
    return {
        "kind": kind,
        "id": id_,
        "paths": [
            {
                "usd_share": dec((p.usd / total).quantize(RATE_DP)) if total > 0 else None,
                "steps": p.steps,
            }
            for p in shown
        ],
        "more_paths": max(len(paths) - MAX_PATHS, 0),
        "split": split,
        "your_rate": _r(your_rate),
        "ecb_rate": _r(ecb_rate),
        "flagged": flagged or any(p.flagged for p in paths),
    }


def _rate_of(tr: _Trail, origins: Sequence[Origin]) -> Decimal | None:
    conv = [o for o in origins if o.conversion_id is not None and o.eur != 0]
    eur = sum((o.eur for o in conv), ZERO)
    return origin_usd(tr.ctx, conv) / eur if eur > 0 else None


def _buy(tr: _Trail, id_: int) -> dict[str, Any] | None:
    t = tr.inputs.txns.get(id_)
    if t is None or t.kind != kinds.BUY:
        return None
    draws = [d for d in tr.state.draws if d.event_txn_id == id_ and id(d) not in tr.backs]
    if not draws:
        return None

    def tail(_d: Draw, usd: Decimal) -> list[dict[str, Any]]:
        steps = [tr.bought_step(id_, usd)]
        now = tr.worth_now(id_, usd)
        if now is not None:
            steps.append(now)
        return steps

    paths = tr.paths_for_draws(draws, tail, t.amount)
    split = None
    rate = tr.inputs.rate_now
    h = tr.state.holdings.get((t.account_id, t.instrument_id or -1))
    value = tr.inputs.values.get((t.account_id, t.instrument_id or -1))
    book = tr.state.buy_cost_eur.get(id_)
    if h is not None and h.cost_native > 0 and value is not None and rate and book is not None:
        part = value * min(t.amount / h.cost_native, Decimal(1))

        cost = sum((draw_embedded(tr.ctx, d) for d in draws), ZERO)
        market = (part - t.amount) / rate
        currency = t.amount / rate - book - cost
        split = _split(market, currency, cost)
    origins = [o for d in draws for o in d.origins]
    return _out(
        "buy",
        id_,
        paths,
        t.amount,
        split=split,
        your_rate=_rate_of(tr, origins),
        ecb_rate=tr.ecb(t.date),
        flagged=id_ in tr.state.uncovered,
    )


def _from_lots(
    tr: _Trail, lot_ids: Sequence[str], start: list[dict[str, Any]] | None
) -> list[_Path]:
    """Downstream paths of the given lots, each prefixed by the lot's upstream steps."""
    paths: list[_Path] = []
    for lot_id in lot_ids:
        for usd, steps in tr.downstream(lot_id):
            paths.append(_Path(usd, [*(start or []), *steps]))
    return paths


def _deposit(tr: _Trail, id_: int) -> dict[str, Any] | None:
    t = tr.inputs.txns.get(id_)
    if t is None or t.kind != kinds.DEPOSIT:
        return None
    m = tr.matches.get(id_)
    paths: list[_Path] = []
    for lot_id in (f"deposit:{id_}:0", f"fallback:{id_}:0"):
        fallback = lot_id.startswith("fallback")
        slices = [] if fallback or m is None else list(m.matched)
        for usd, steps in tr.downstream(lot_id):
            if slices:
                lot_usd = sum((s.usd for s in slices), ZERO)
                for s in slices:
                    share = usd * s.usd / lot_usd
                    o = Origin(
                        s.conversion_id, tr.convs[s.conversion_id].date, s.eur * share / s.usd
                    )
                    up = tr.upstream(lot_id, o, share)
                    paths.append(_Path(share, [*up.steps, *steps], up.flagged))
            else:
                up = tr.upstream(lot_id, None, usd)
                paths.append(_Path(usd, [*up.steps, *steps], fallback or up.flagged))
    if not paths and m is None:
        return None
    return _out(
        "deposit",
        id_,
        paths,
        t.amount,
        split=None,
        your_rate=m.blended_rate if m is not None else None,
        ecb_rate=tr.ecb(t.date),
        flagged=m is not None and m.fallback_usd > 0,
    )


def _sell(tr: _Trail, id_: int) -> dict[str, Any] | None:
    t = tr.inputs.txns.get(id_)
    if t is None or t.kind != kinds.SELL:
        return None
    lot_id = f"sale:{id_}:0"
    origins: list[Origin] = []
    for d in tr.state.draws:
        if d.lot_id == lot_id:
            origins += d.origins
    left = next((x for x in tr.state.lots if x.lot_id == lot_id), None)
    if left is not None:
        origins += left.origins
    head = tr.upstream(lot_id, _main(origins), t.amount).steps
    paths = _from_lots(tr, [lot_id], head)
    return _out(
        "sell",
        id_,
        paths,
        t.amount,
        split=None,
        your_rate=_rate_of(tr, origins),
        ecb_rate=tr.ecb(t.date),
    )


def _main(origins: Sequence[Origin]) -> Origin | None:
    merged: dict[int, Origin] = {}
    for o in origins:
        if o.conversion_id is None or o.eur == 0:
            continue
        prior = merged.get(o.conversion_id)
        eur = o.eur + (prior.eur if prior else ZERO)
        merged[o.conversion_id] = Origin(o.conversion_id, o.conv_date, eur)
    return max(merged.values(), key=lambda o: o.eur, default=None)


def _withdrawal(tr: _Trail, id_: int) -> dict[str, Any] | None:
    t = tr.inputs.txns.get(id_)
    if t is None or t.kind not in (kinds.WITHDRAWAL, kinds.TRANSFER_OUT):
        return None
    draws = [d for d in tr.state.draws if d.event_txn_id == id_ and id(d) not in tr.backs]

    def tail(d: Draw, usd: Decimal) -> list[dict[str, Any]]:
        steps = [tr.withdrawn_step(id_, t.date, usd)]
        n = tr.withdrawal_index(id_, d)
        if n is not None:
            down = tr.downstream(f"withdrawal:{id_}:{n}")
            if down:
                steps += down[0][1]
        return steps

    paths = tr.paths_for_draws(draws, tail, t.amount)
    origins = [o for d in draws for o in d.origins]
    return _out(
        "withdrawal",
        id_,
        paths,
        t.amount,
        split=None,
        your_rate=_rate_of(tr, origins),
        ecb_rate=tr.ecb(t.date),
    )


def _conversion(tr: _Trail, id_: int) -> dict[str, Any] | None:
    co = tr.cash_outs.get(id_)
    if co is not None:
        draws = list(tr.state.conversions_back.get(id_, co.draws))
        back_paths = tr.paths_for_draws(
            draws, lambda _d, usd: [tr.back_step(id_, usd)], co.usd_sent
        )
        rate = co.usd_sent / co.eur_received if co.eur_received > 0 else None
        split = _split(co.market_eur, co.currency_eur, co.conversion_cost_eur)
        return _out(
            "conversion",
            id_,
            back_paths,
            co.usd_sent,
            split=split,
            your_rate=rate,
            ecb_rate=tr.ecb(co.date),
            flagged=co.flagged,
        )
    b = tr.convs.get(id_)
    if b is None:
        return None
    paths: list[_Path] = []
    for m in tr.inputs.snapshot.deposit_matches.deposits:
        for s in m.matched:
            if s.conversion_id != id_:
                continue
            o = Origin(id_, b.date, s.eur)
            up = tr.upstream(f"deposit:{m.deposit_id}:0", o, s.usd)
            paths.append(_Path(s.usd, up.steps, up.flagged))
    rest = next(
        (r for r in tr.inputs.snapshot.deposit_matches.remaining if r.conversion_id == id_), None
    )
    if rest is not None and rest.usd > 0:
        steps = tr.conversion_steps(Origin(id_, b.date, rest.eur))
        days = (tr.inputs.today - b.date).days
        steps.append(
            _step(
                "waited",
                b.date,
                "Waiting",
                f"{days} days",
                None,
                f"${_money(rest.usd)} not deposited",
            )
        )
        paths.append(_Path(rest.usd, steps))
    rate = b.usd_received / b.eur_cost if b.eur_cost > 0 else None
    return _out(
        "conversion",
        id_,
        paths,
        b.usd_received,
        split=None,
        your_rate=rate,
        ecb_rate=tr.ecb(b.date),
    )


_BUILDERS = {
    "buy": _buy,
    "deposit": _deposit,
    "sell": _sell,
    "withdrawal": _withdrawal,
    "conversion": _conversion,
}


def build_trail(inputs: JourneyInputs, kind: str, id_: int) -> dict[str, Any] | None:
    """``TrailOut`` for one transaction or conversion; ``None`` when there is no trail."""
    fn = _BUILDERS.get(kind)
    if fn is None:
        return None
    return fn(_Trail(inputs), id_)
