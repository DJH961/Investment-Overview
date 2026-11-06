"""Holdings read-model for ``GET /api/holdings`` (ccy-aware, one row per instrument).

💱 CURRENCY (rule in ``AGENTS.md``): money and returns are *selected* from the
existing EUR / USD legs of :class:`HoldingCard` (each computed independently per
currency); a return is never converted. ``price_native`` stays in the
instrument's native currency. A USD leg that does not exist is ``None``.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.domain import market_hours
from investment_dashboard.domain.instruments import is_nav_priced
from investment_dashboard.domain.late_data import Holding, value_at_rate
from investment_dashboard.domain.returns import capital_gain_excl_income
from investment_dashboard.readmodels._context import build_context
from investment_dashboard.readmodels._serialize import dec, iso
from investment_dashboard.readmodels.queries.overview_query import (
    HoldingCard,
    InstrumentMetrics,
    build_holding_cards,
    compute_instrument_metrics,
    holding_freshness,
)
from investment_dashboard.repositories import instruments_repo
from investment_dashboard.services import fx_service, intraday_snapshots_service, prices_service
from investment_dashboard.services.daily_growth_view import fx_move_pct
from investment_dashboard.services.metrics_service import compute_portfolio_metrics
from investment_dashboard.services.positions_service import Position, compute_positions

ZERO = Decimal(0)


def merge_positions_by_instrument(positions: list[Position]) -> list[Position]:
    """Collapse the per-(account, instrument) positions to one per instrument.

    The per-instrument metrics already span every account, so a card per account
    would repeat the instrument-wide value on each (double counting). Shares,
    cost basis and values are summed; the first account stands for the row.
    """
    merged: dict[int, Position] = {}
    for p in positions:
        iid = p.instrument.id
        prev = merged.get(iid)
        if prev is None:
            merged[iid] = p
            continue
        merged[iid] = replace(
            prev,
            shares=prev.shares + p.shares,
            cost_basis_native=prev.cost_basis_native + p.cost_basis_native,
            current_value_native=prev.current_value_native + p.current_value_native,
            current_value_eur=prev.current_value_eur + p.current_value_eur,
            cumulative_dividends_cash_native=(
                prev.cumulative_dividends_cash_native + p.cumulative_dividends_cash_native
            ),
            value_warning=prev.value_warning or p.value_warning,
        )
    return list(merged.values())


def pick(eur: Decimal | None, usd: Decimal | None, ccy: str) -> Decimal | None:
    """Select the leg for ``ccy`` (no conversion)."""
    return usd if ccy == "USD" else eur


def _gain_split(
    card: HoldingCard, ccy: str
) -> tuple[Decimal | None, Decimal | None, Decimal | None]:
    """``(capital_gain, income, total_return)`` for one holding in ``ccy``.

    Capital gain is the unrealised gain on what is still held, with dividends
    stripped out; income is the holding's lifetime dividends (cash and
    reinvested); total return is their sum. Same basis as the overview's
    portfolio figures, restricted to the positions listed here.
    """
    unrealised = pick(card.unrealised_gain_eur, card.unrealised_gain_usd, ccy)
    income = pick(card.income_eur, card.income_usd, ccy)
    if unrealised is not None and income is not None:
        return unrealised, income, unrealised + income
    # No metrics for this card: fall back to value + cash dividends - cost.
    total_return = pick(card.capital_gain_eur, card.capital_gain_usd, ccy)
    value = pick(card.value_eur, card.value_usd, ccy)
    cost = pick(card.cost_basis_eur, card.cost_basis_usd, ccy)
    if total_return is None or value is None or cost is None:
        return None, None, total_return
    capital_gain = value - cost
    return capital_gain, total_return - capital_gain, total_return


def portfolio_return_split(
    pm: Any, ccy: str
) -> tuple[Decimal | None, Decimal | None, Decimal | None]:
    """``(total_return, capital_gain, dividend_income)`` for the whole portfolio.

    One definition for the Overview and the Holdings page: total return is
    ``value + realised cash dividends - net contributions`` (``pm.capital_gain_*``
    in the service's legacy naming); capital gain is that minus all dividend
    income, so ``capital_gain + dividend_income == total_return``. Each currency
    is built from its own legs; nothing is converted.
    """
    total_return = pick(pm.capital_gain_eur, pm.capital_gain_usd, ccy)
    income = pick(pm.total_dividends_cash_eur, pm.total_dividends_cash_usd, ccy)
    if total_return is None or income is None:
        return total_return, None, income
    return total_return, capital_gain_excl_income(total_return, income), income


def holding_row(
    card: HoldingCard,
    position: Position,
    metrics: InstrumentMetrics | None,
    ccy: str,
) -> dict[str, Any]:
    eff = position.effective
    asset_class = (eff.asset_class if eff is not None else position.instrument.asset_class) or ""
    value = pick(card.value_eur, card.value_usd, ccy)
    gain, dividends, total_return = _gain_split(card, ccy)
    return {
        "instrument_id": card.instrument_id,
        "symbol": card.symbol,
        "name": card.name,
        "category": card.category,
        "asset_class": asset_class,
        "account": position.account.account_label,
        "native_currency": card.native_currency,
        "shares": dec(card.shares),
        "avg_price_native": dec(card.avg_price_native),
        "price_native": dec(card.current_price_native),
        "price_as_of": iso(card.price_as_of),
        "updated_at": iso(card.updated_at),
        "price_market_at": iso(card.price_market_time),
        "price_type": "nav" if card.is_money_market or is_nav_priced(asset_class) else "market",
        "is_money_market": card.is_money_market,
        "market_open": card.market_open,
        "expense_ratio": dec(card.expense_ratio),
        "cost_basis": dec(pick(card.cost_basis_eur, card.cost_basis_usd, ccy)),
        "value": dec(value),
        "capital_gain": dec(gain),
        "dividends": dec(dividends),
        "total_return": dec(total_return),
        "xirr": dec(pick(card.xirr_eur, card.xirr_usd, ccy)),
        "total_growth": dec(pick(card.total_growth_eur, card.total_growth_usd, ccy)),
        "ytd_growth": dec(pick(card.ytd_growth_eur, card.ytd_growth_usd, ccy)),
        "mtd_growth": dec(
            pick(
                metrics.mtd_growth_eur if metrics else None,
                metrics.mtd_growth_usd if metrics else None,
                ccy,
            )
        ),
        "today_pct": dec(pick(card.daily_growth_eur, card.daily_growth_usd, ccy)),
        "today_move": dec(pick(card.daily_move_eur, card.daily_move_usd, ccy)),
        "daily_growth_as_of": iso(card.daily_growth_as_of),
        "daily_is_stale": card.daily_is_stale,
        "weight_pct": dec(card.weight),
        "value_warning": card.value_warning,
        "price_data_warning": card.price_data_warning,
    }


def _summary(rows: list[dict[str, Any]], cards: list[HoldingCard], ccy: str) -> dict[str, Any]:
    scored = [
        (c, pick(c.total_growth_eur, c.total_growth_usd, ccy))
        for c in cards
        if pick(c.total_growth_eur, c.total_growth_usd, ccy) is not None
    ]
    best = max(scored, key=lambda t: t[1], default=None)  # type: ignore[arg-type,return-value]
    worst = min(scored, key=lambda t: t[1], default=None)  # type: ignore[arg-type,return-value]
    largest = max(cards, key=lambda c: c.weight or ZERO, default=None)
    gainers = sum(1 for c in cards if (c.daily_move_eur or ZERO) > ZERO)
    losers = sum(1 for c in cards if (c.daily_move_eur or ZERO) < ZERO)
    # "In profit" is judged on TOTAL return, not the capital gain: a money-market
    # fund earns its whole return as dividends and holds its NAV at par, so its
    # capital gain is 0 by construction and counting on it reported a plainly
    # profitable cash position as neither in profit nor in loss.
    splits = [_gain_split(c, ccy)[2] for c in cards]
    in_profit = sum(1 for g in splits if g is not None and g > ZERO)
    in_loss = sum(1 for g in splits if g is not None and g < ZERO)
    return {
        "best_symbol": best[0].symbol if best else None,
        "best_growth": dec(best[1]) if best else None,
        "worst_symbol": worst[0].symbol if worst else None,
        "worst_growth": dec(worst[1]) if worst else None,
        "most_concentrated_symbol": largest.symbol if largest and largest.weight else None,
        "most_concentrated_weight_pct": dec(
            largest.weight if largest and largest.weight is not None else None
        ),
        "gainers": gainers,
        "losers": losers,
        "in_profit": in_profit,
        "in_loss": in_loss,
    }


GROUP_BY_VALUES = ("none", "account", "asset_class", "currency", "category")


def _group_key(row: dict[str, Any], by: str) -> str:
    field = {
        "account": "account",
        "asset_class": "asset_class",
        "currency": "native_currency",
        "category": "category",
    }[by]
    return str(row[field] or "")


def build_groups(
    rows: list[dict[str, Any]],
    cards: list[HoldingCard],
    by: str,
    ccy: str,
    est_deltas: dict[int, Decimal] | None = None,
    est_moves: dict[int, Decimal | None] | None = None,
) -> list[dict[str, Any]]:
    """Per-group subtotals (``Decimal``, in ``ccy``), largest value first.

    💱 Same rule as the page totals: each figure is the sum of the holdings'
    own ``ccy`` legs; a group missing a leg for any member reports ``None`` for
    that figure instead of a partial sum. Nothing is converted.

    ``est_deltas`` maps an instrument id to ``shares x (est_price - previous NAV)``
    in ``ccy`` for every fund estimated from its ETF twin; a group with such a
    member also reports ``est_value`` / ``est_today_move`` (``None`` otherwise).
    ``est_moves`` maps those ids to the fund's estimated day move (see
    :func:`~investment_dashboard.services.intraday_snapshots_service.estimate_day_move`);
    the group's estimated move is the sum of each member's estimated move (pending)
    or official move, never the pending fund's stale last-session move plus a delta.
    """
    if by == "none":
        return []
    est_deltas = est_deltas or {}
    est_moves = est_moves or {}
    members: dict[str, list[int]] = {}
    for i, row in enumerate(rows):
        members.setdefault(_group_key(row, by), []).append(i)
    out: list[dict[str, Any]] = []
    for key, idx in members.items():
        group_cards = [cards[i] for i in idx]
        splits = [_gain_split(c, ccy) for c in group_cards]
        weights = [c.weight for c in group_cards]
        value = _sum([pick(c.value_eur, c.value_usd, ccy) for c in group_cards])
        cost_basis = _sum([pick(c.cost_basis_eur, c.cost_basis_usd, ccy) for c in group_cards])
        total_return = _sum([sp[2] for sp in splits])
        move = _sum([pick(c.daily_move_eur, c.daily_move_usd, ccy) for c in group_cards])
        est_move = _sum(
            [
                est_moves[c.instrument_id]
                if c.instrument_id in est_moves
                else pick(c.daily_move_eur, c.daily_move_usd, ccy)
                for c in group_cards
            ]
        )
        delta = sum((est_deltas.get(c.instrument_id, ZERO) for c in group_cards), start=ZERO)
        estimating = any(c.instrument_id in est_deltas for c in group_cards)
        # ``today_move`` sums each card's official move, and a pending-NAV fund's official
        # move is its own last *published* session's (see ``_daily_move`` in
        # overview_query) — real, but not today's. The row greys it; a subtotal cannot, so
        # the group carries the estimated percentage alongside the estimated move rather
        # than leaving ``today_pct`` as the only one on screen.
        est_value = value + delta if estimating and value is not None else None
        out.append(
            {
                "key": key,
                "count": len(idx),
                "instrument_ids": [rows[i]["instrument_id"] for i in idx],
                "value": value,
                "cost_basis": cost_basis,
                "capital_gain": _sum([s[0] for s in splits]),
                "dividends": _sum([s[1] for s in splits]),
                "total_return": total_return,
                "total_growth": _growth_on_cost(total_return, cost_basis),
                "weight_pct": _sum(weights),
                "today_move": move,
                "today_pct": move_pct(value, move),
                "est_value": est_value,
                "est_today_move": est_move if estimating else None,
                "est_today_pct": move_pct(est_value, est_move) if estimating else None,
            }
        )
    out.sort(key=lambda g: (-(g["value"] if g["value"] is not None else ZERO), g["key"]))
    return [{k: (dec(v) if isinstance(v, Decimal) else v) for k, v in g.items()} for g in out]


def _growth_on_cost(total_return: Decimal | None, cost_basis: Decimal | None) -> Decimal | None:
    """Group total return over its cost basis (a fraction), ``None`` without a positive cost."""
    if total_return is None or cost_basis is None or cost_basis <= ZERO:
        return None
    return total_return / cost_basis


def move_pct(value: Decimal | None, move: Decimal | None) -> Decimal | None:
    """``move`` over the value before it (``value - move``), or ``None``."""
    if value is None or move is None or value - move <= ZERO:
        return None
    return move / (value - move)


def _delta_in(
    estimates: list[intraday_snapshots_service.TwinEstimate], fx: Decimal | None, ccy: str
) -> Decimal | None:
    """``sum(shares x (est_price - previous NAV))`` of ``estimates`` in ``ccy`` at one rate."""
    adjustment = intraday_snapshots_service.estimate_adjustment(estimates, fx)
    return pick(adjustment[0], adjustment[1], ccy)


def _divergence_view(
    session: Session,
    fd: intraday_snapshots_service.FundDivergence,
    legs: tuple[intraday_snapshots_service.EstimateLeg, ...],
    *,
    ccy: str,
) -> dict[str, Any]:
    """The ``twin.divergence`` block. Gaps are percentage points (fraction x 100).

    💱 ``last_money`` is the gap on ``stats.last_date`` — possibly weeks ago, not
    "today" — so it is valued at THAT session's own close rate
    (:func:`intraday_snapshots_service.session_close_rate`), never the rate now:
    a past valuation is never re-struck at a later rate (the currency rule).
    """
    stats = fd.stats
    hundred = Decimal(100)
    money: Decimal | None = None
    fx = intraday_snapshots_service.session_close_rate(session, stats.last_date)
    if fx is not None and fx > 0:
        # Estimate minus official value of the holding at the last session's close,
        # valued at that session's own close rate.
        step = fd.last_prev_nav * stats.last_gap
        # A leg outside EUR/USD carries ``eur_per_native`` struck now, which would put
        # a present rate on a past gap just as the EUR/USD mark above would. Use that
        # session's own settled rate, and drop the leg if none exists rather than
        # silently valuing it at today's.
        held = []
        for leg in legs:
            native = leg.shares * step
            per_native = (
                leg.eur_per_native
                if leg.currency in {"EUR", "USD"}
                else intraday_snapshots_service.eur_per_native_at(
                    session, stats.last_date, leg.currency
                )
            )
            if per_native is None:
                continue
            held.append(Holding(leg.currency, native, native * per_native))
        eur, usd = value_at_rate(held, fx)
        money = pick(eur, usd, ccy)
    return {
        "last_pp": dec(stats.last_gap * hundred),
        "last_money": dec(money),
        "last_date": stats.last_date.isoformat(),
        "median_abs_pp": dec(stats.median_abs * hundred),
        "bias_pp": dec(stats.bias * hundred),
        "sessions": stats.sessions,
        "window": stats.window,
    }


def _twin_view(
    session: Session,
    *,
    card: HoldingCard,
    position: Position,
    estimates: dict[int, intraday_snapshots_service.TwinEstimate],
    session_date: date,
    now: datetime,
    fx: Decimal | None,
    fx_prev: Decimal | None,
    ccy: str,
    account_positions: Sequence[Position] = (),
) -> tuple[dict[str, Any] | None, Decimal | None, Decimal | None]:
    """``(twin view, value delta in ccy, estimated day move in ccy)`` for one holding.

    ``None`` view: no twin. The estimated day move is the pending fund's value at the
    estimate (rate now) minus its value at the previous NAV (previous close's rate),
    the same figure the tick's ``pct`` is built from; the card's own daily move is the
    stale last-session move of an unposted NAV and is not used.

    ``account_positions`` are this instrument's *unmerged* per-account positions
    (before :func:`merge_positions_by_instrument`), needed only by the NAV-posted
    branch below: a fund held in several accounts can be booked in more than one
    currency, and ``position`` (the merged row) keeps only the first account's
    currency with every account's shares summed, which would book the whole
    divergence money in one arbitrary currency.
    """
    est = estimates.get(card.instrument_id)
    twin = (
        est.twin_symbol if est is not None else intraday_snapshots_service.twin_symbol_of(position)
    )
    if twin is None or not intraday_snapshots_service.is_drifting_nav(position):
        return None, None, None
    fd = intraday_snapshots_service.fund_divergence(
        session, instrument_id=card.instrument_id, twin_symbol=twin, now=now
    )
    if est is not None:
        delta = _delta_in([est], fx, ccy)
        value = pick(card.value_eur, card.value_usd, ccy)
        est_value = value + delta if value is not None and delta is not None else None
        est_move, est_pct = intraday_snapshots_service.estimate_day_move(est, fx, fx_prev, ccy)
        # The estimate moves only the value, so it moves the gain since buying by the
        # same delta: every other row on the page shows money AND percent there, and
        # leaving the twin's cell blank made the estimated row look half-reported.
        _gain, _income, total_return = _gain_split(card, ccy)
        cost = pick(card.cost_basis_eur, card.cost_basis_usd, ccy)
        est_total = total_return + delta if total_return is not None and delta is not None else None
        view: dict[str, Any] = {
            "symbol": twin,
            "tier": est.tier,
            "est_price": dec(est.est_px),
            "est_value": dec(est_value),
            "est_today_move": dec(est_move),
            "est_today_pct": dec(est_pct),
            "est_total_return": dec(est_total),
            "est_total_growth": dec(
                est_total / cost
                if est_total is not None and cost is not None and cost > ZERO
                else None
            ),
            "at": est.at.isoformat(),
            # The twin's price is its settled close when its market is shut and the
            # price we hold was struck at or after that session's closing bell. The
            # row marks it ✓, the same promise a directly priced holding makes.
            "at_close": (
                not market_hours.is_us_market_open(now)
                and est.at >= market_hours.regular_session_close(est.session_date)
            ),
            "pending": True,
            "divergence": _divergence_view(session, fd, est.legs, ccy=ccy) if fd else None,
        }
        return view, delta, est_move
    # NAV posted: until the next open the row only keeps how far the twin was off.
    if fd is None or fd.stats.last_date != session_date:
        return None, None, None
    # One leg per *account*, not one leg from the merged row (see the docstring):
    # each account's own currency and share count, so a fund split across a EUR
    # and a USD account books its divergence money correctly in both, instead of
    # all of it in whichever account the merge happened to keep. ``session_date``
    # is exactly ``fd.stats.last_date`` here (the gate above), so these current
    # shares are the shares actually held on the session the gap is about — no
    # staleness to guard against.
    legs = tuple(
        intraday_snapshots_service.EstimateLeg(
            p.account.native_currency.upper(),
            p.shares,
            p.current_value_eur / p.current_value_native if p.current_value_native else ZERO,
        )
        for p in account_positions
        if p.shares > ZERO
    ) or (
        intraday_snapshots_service.EstimateLeg(
            position.account.native_currency.upper(),
            position.shares,
            position.current_value_eur / position.current_value_native
            if position.current_value_native
            else ZERO,
        ),
    )
    return (
        {
            "symbol": twin,
            "tier": intraday_snapshots_service.twin_tier(card.symbol, twin),
            "est_price": None,
            "est_value": None,
            "est_today_move": None,
            "est_today_pct": None,
            "est_total_return": None,
            "est_total_growth": None,
            "at": None,
            "at_close": False,
            "pending": False,
            "divergence": _divergence_view(session, fd, legs, ccy=ccy),
        },
        None,
        None,
    )


def _fx_block(
    session: Session,
    *,
    ccy: str,
    live_fx: Decimal | None,
    prev_fx: Decimal | None,
    native_currencies: set[str],
    today: date,
) -> dict[str, Any] | None:
    """Current FX stamp for the second KPI row, or ``None`` when no rate exists.

    The move is a display-relative fraction (strength of the foreign currency).

    This used to return ``None`` when every holding already traded in ``ccy``, on
    the grounds that FX could not move such a book. But the page shows the rate in
    that view anyway (from ``fx_eur_usd``) — it only lost the move beside it, so
    one view carried a bare number where the other carried a number and its change.
    The rate's own move is a fact whichever currency is being reported; whether it
    moved *this* book is a separate question the total already answers.
    """
    if live_fx is None or live_fx <= 0:
        return None
    in_usd = ccy == "USD"
    info = fx_service.eur_quote_as_of(session, quote="USD", today=today)
    move = fx_move_pct(live_fx, prev_fx, ccy)
    return {
        "pair": "EUR/USD" if in_usd else "USD/EUR",
        "spot": dec(live_fx if in_usd else Decimal(1) / live_fx),
        "move_pct": dec(move / Decimal(100) if move is not None else None),
        "as_of": iso(info.as_of) if info else None,
        "source": info.source if info else None,
        "observed_at": iso(info.observed_at) if info and info.observed_at else None,
    }


def build(
    session: Session,
    *,
    ccy: str,
    group_by: str = "none",
    as_of: date | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """The ``GET /api/holdings`` payload."""
    now = now or datetime.now(UTC)
    ctx = build_context(session, as_of=as_of)
    pm = compute_portfolio_metrics(session, as_of=ctx.as_of)
    raw_positions = compute_positions(session, as_of=ctx.as_of)
    positions = merge_positions_by_instrument(raw_positions)
    # Unmerged, per-account positions by instrument — the twin-divergence view
    # needs each account's own currency and share count (see ``_twin_view``), not
    # the merged row's arbitrary single currency and summed shares.
    by_instrument_unmerged: dict[int, list[Position]] = {}
    for p in raw_positions:
        by_instrument_unmerged.setdefault(p.instrument.id, []).append(p)
    metrics = compute_instrument_metrics(session, positions, as_of=ctx.as_of)
    freshness = holding_freshness(session, positions)
    anomalies = prices_service.instruments_with_price_anomalies(
        session, [p.instrument.id for p in positions]
    )
    cards = build_holding_cards(
        positions, metrics=metrics, freshness=freshness, price_anomaly_ids=anomalies
    )
    by_id = {p.instrument.id: p for p in positions}
    rows = [
        holding_row(c, by_id[c.instrument_id], metrics.get(c.instrument_id), ccy) for c in cards
    ]
    # Mutual funds with an ETF twin: the estimate while the NAV is pending, the
    # twin's accuracy once it posted. Money is valued at the one rate now.
    estimates = intraday_snapshots_service.twin_estimates(session, now)
    # Switched off, the whole sub-row goes, not only the estimate half: a "twin was
    # 0.3 pp off" line under a holding is twin machinery too, and reads oddly for a
    # feature that is disabled. The accuracy figures stay available where you would
    # go to judge them, Health & Repair > ETF twins, which reads them directly.
    twins_on = intraday_snapshots_service.estimates_enabled(session)
    session_date = intraday_snapshots_service.last_session_date(now)
    fx_prev = intraday_snapshots_service.previous_close_fx(session, session_date)
    est_deltas: dict[int, Decimal] = {}
    est_moves: dict[int, Decimal | None] = {}
    for card, row in zip(cards, rows, strict=True):
        if not twins_on:
            row["twin"] = None
            continue
        view, delta, est_move = _twin_view(
            session,
            card=card,
            position=by_id[card.instrument_id],
            estimates=estimates,
            session_date=session_date,
            now=now,
            fx=ctx.fx_rate_eur_usd,
            fx_prev=fx_prev,
            ccy=ccy,
            account_positions=by_instrument_unmerged.get(card.instrument_id, []),
        )
        row["twin"] = view
        if delta is not None:
            est_deltas[card.instrument_id] = delta
        if view is not None and view["pending"]:
            est_moves[card.instrument_id] = est_move
    total_value = _sum([pick(c.value_eur, c.value_usd, ccy) for c in cards])
    splits = [_gain_split(c, ccy) for c in cards]
    unrealised = _sum([s[0] for s in splits])
    held_income = _sum([s[1] for s in splits])
    total_return, total_gain, _income = portfolio_return_split(pm, ccy)
    # Whatever the listed positions do not explain: gains realised by selling,
    # closed positions, cash and savings balances, fees.
    realised_other = (
        total_gain - unrealised if total_gain is not None and unrealised is not None else None
    )
    total_cost = _sum([pick(c.cost_basis_eur, c.cost_basis_usd, ccy) for c in cards])
    return {
        "ccy": ccy,
        "as_of": ctx.as_of.isoformat(),
        "fx_eur_usd": dec(ctx.fx_rate_eur_usd),
        "total_value": dec(total_value),
        "total_cost_basis": dec(total_cost),
        "total_capital_gain": dec(total_gain),
        "total_unrealised_gain": dec(unrealised),
        "total_realised_other": dec(realised_other),
        "total_dividends": dec(held_income),
        "total_return": dec(total_return),
        "xirr": dec(pick(pm.xirr, pm.xirr_usd, ccy)),
        "total_growth": dec(
            pick(pm.total_growth_compounded_eur, pm.total_growth_compounded_usd, ccy)
        ),
        "dividend_income": dec(pick(pm.total_dividends_cash_eur, pm.total_dividends_cash_usd, ccy)),
        "dividends_ttm": dec(pick(pm.dividends_ttm_eur, pm.dividends_ttm_usd, ccy)),
        "dividend_yield_pct": dec(pm.dividend_yield_pct),
        "dividend_yield_ttm_pct": dec(pm.dividend_yield_ttm_pct),
        "weighted_expense_ratio": dec(pm.weighted_expense_ratio),
        "annual_expense_cost": dec(_expense_cost(pm.annual_expense_cost_eur, ccy, ctx)),
        "fx": _fx_block(
            session,
            ccy=ccy,
            live_fx=pm.daily_growth_fx_eur_usd or ctx.fx_rate_eur_usd,
            prev_fx=pm.daily_growth_fx_eur_usd_prev,
            native_currencies={r["native_currency"] for r in rows},
            today=ctx.as_of,
        ),
        "group_by": group_by,
        "groups": build_groups(rows, cards, group_by, ccy, est_deltas, est_moves),
        "holdings": rows,
        "summary": _summary(rows, cards, ccy),
    }


def _expense_cost(cost_eur: Decimal | None, ccy: str, ctx: Any) -> Decimal | None:
    """Annual fee estimate: a single-instant value, so converted at the spot rate."""
    if cost_eur is None or ccy != "USD":
        return cost_eur
    rate = ctx.fx_rate_eur_usd
    return cost_eur * rate if rate is not None else None


def _sum(values: list[Decimal | None]) -> Decimal | None:
    """Sum of the present legs; ``None`` when any holding lacks the leg."""
    if any(v is None for v in values):
        return None
    return sum((v for v in values if v is not None), start=ZERO)


#: Upper bound on daily closes read for one chart (about 24 years of trading days).
_HISTORY_MAX_POINTS = 6000


def _history_start(range_key: str, today: date) -> date | None:
    if range_key == "all":
        return None
    if range_key == "ytd":
        return date(today.year, 1, 1)
    days = {"1m": 31, "3m": 92, "6m": 183, "1y": 366}[range_key]
    return today - timedelta(days=days)


def build_history(session: Session, instrument_id: int, *, range_key: str) -> dict[str, Any] | None:
    """Daily closes of one instrument in its NATIVE currency, or ``None`` for an unknown id.

    No conversion happens here (currency rule): ``ccy`` is the instrument's
    native currency, to label the axis. Read through ``prices_service`` only.
    """
    instrument = instruments_repo.get_instrument(session, instrument_id)
    if instrument is None:
        return None
    today = market_hours.exchange_today()
    pairs = prices_service.recent_closes_by_instrument(
        session, [instrument_id], on_or_before=today, limit=_HISTORY_MAX_POINTS
    ).get(instrument_id, [])
    start = _history_start(range_key, today)
    points = sorted((d, c) for d, c in pairs if start is None or d >= start)
    return {
        "instrument_id": instrument_id,
        "symbol": instrument.symbol,
        "range": range_key,
        "ccy": instrument.native_currency,
        "points": [{"t": d.isoformat(), "v": dec(c)} for d, c in points],
    }
