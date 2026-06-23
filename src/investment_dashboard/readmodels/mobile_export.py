"""Minimized live-web export for the v3.0 browser companion.

The export carries live-recompute primitives plus the existing as-of-export
read-models. Completed periods ride along unchanged; the browser uses
``period_openings`` and exported cashflows to recompute the current month/year
against live prices.

``meta.fx_pivot`` is not a portfolio base currency. It only names the FX
reference pair used by existing valuation/read-model code; USD-native booked
amounts remain lossless and each holding declares its own native currency.

SECURITY — this repository is PUBLIC (proposal §7.4). The dict assembled here is
encrypted before it ever leaves the machine. Never log, commit, or persist its
contents, and never add tokens or passphrases to it.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard import __version__
from investment_dashboard.domain.currency import lookup_rate_with_forward_fill
from investment_dashboard.domain.money_market import is_money_market
from investment_dashboard.domain.returns import Cashflow
from investment_dashboard.models import Transaction
from investment_dashboard.readmodels import analytics, deposits, periods, transactions
from investment_dashboard.readmodels._context import ReadModelContext, build_context
from investment_dashboard.readmodels._serialize import dec, iso, now_utc_iso
from investment_dashboard.repositories import (
    accounts_repo,
    allocations_repo,
    instruments_repo,
    transactions_repo,
)
from investment_dashboard.services import (
    fx_service,
    metrics_service,
    positions_service,
    prices_service,
)
from investment_dashboard.services.positions_service import Position
from investment_dashboard.ui.pages._overview_query import compute_instrument_metrics

SCHEMA_VERSION = 1

_NAV_ASSET_CLASSES = {"mutual_fund", "cash", "savings", "money_market", "money-market"}
_CASH_ACCOUNT_TYPES = {"savings", "cash"}


def _cashflow_dict(flow: Cashflow) -> dict[str, str | None]:
    return {"date": iso(flow.date), "amount": dec(flow.amount)}


def _paired_cashflows(
    eur_flows: list[Cashflow],
    usd_flows: list[Cashflow],
) -> list[dict[str, str | None]]:
    """Serialize aligned EUR/USD cashflow streams into per-flow dicts.

    The dual builders emit the EUR and USD legs in a single ledger pass, so the
    two lists are index-aligned (same transactions, same order). Each USD leg is
    converted at its own trade-date FX rate, letting the web recompute currency-
    correct growth (XIRR, total gain) in USD without rescaling at today's spot.
    """
    rows: list[dict[str, str | None]] = []
    for eur, usd in zip(eur_flows, usd_flows, strict=True):
        rows.append(
            {"date": iso(eur.date), "amount": dec(eur.amount), "amount_usd": dec(usd.amount)}
        )
    return rows


def _position_name(position: Position) -> str | None:
    if position.effective is not None and position.effective.name:
        return position.effective.name
    return position.instrument.name


def _asset_class(position: Position) -> str:
    if position.effective is not None:
        return position.effective.asset_class
    return position.instrument.asset_class


def _category(position: Position) -> str | None:
    """The override/effective category for this holding (``None`` when unset).

    Mirrors the desktop calculator's grouping key, where a holding falls back to
    its ``asset_class`` (then ``"Uncategorized"``) when no explicit category has
    been assigned — that fallback is applied on the web so the calculator can
    group funds into the same category buckets the desktop shows.
    """
    if position.effective is not None:
        return position.effective.category
    return position.category


def _price_type(position: Position) -> str:
    asset_class = _asset_class(position)
    name = _position_name(position)
    if is_money_market(position.instrument.symbol, asset_class=asset_class, name=name):
        return "nav"
    if asset_class in {"etf", "stock"}:
        return "market"
    if asset_class in _NAV_ASSET_CLASSES:
        return "nav"
    return "market"


def build_meta(context: ReadModelContext) -> dict[str, Any]:
    """Top-level metadata block describing generation and currency context."""
    return {
        "schema_version": SCHEMA_VERSION,
        "app_version": __version__,
        "generated_at": now_utc_iso(),
        "as_of": iso(context.as_of),
        "display_currency": context.display_currency,
        "fx_pivot": "EUR",
        "fx_rate_eur_usd": dec(context.fx_rate_eur_usd),
        "currency_note": (
            "EUR is an FX conversion reference, not the user's base currency. "
            "Each holding carries native_currency; USD is the booked currency "
            "for most rows."
        ),
    }


def _holding_dict(
    position: Position,
    *,
    cashflows: dict[int, list[Cashflow]],
    cashflows_usd: dict[int, list[Cashflow]],
    cost_basis_eur: dict[int, Decimal],
    cost_basis_usd: dict[int, Decimal],
    price_dates: dict[int, date],
    previous_closes: dict[int, tuple[date, Decimal]],
) -> dict[str, Any]:
    iid = position.instrument.id
    prev_close = previous_closes.get(iid)
    return {
        "symbol": position.instrument.symbol,
        "name": _position_name(position),
        "asset_class": _asset_class(position),
        # The holding's category (an Overview/Calculator grouping key). May be
        # ``null`` when no explicit category was assigned; the web falls back to
        # ``asset_class`` then "Uncategorized", mirroring the desktop calculator.
        "category": _category(position),
        "broker": position.account.broker,
        "account": position.account.account_label,
        "native_currency": position.account.native_currency,
        "shares": dec(position.shares),
        "cost_basis_native": dec(position.cost_basis_native),
        # Cost basis converted at each buy's own trade-date FX (not today's
        # spot), so the web can show a currency-correct total gain *and growth*
        # independently per currency. ``cost_basis_eur`` mirrors the desktop's
        # per-currency ``InstrumentMetrics`` so EUR growth reflects the EUR the
        # buys actually cost; without it the web derived the EUR cost basis at
        # today's spot, which made EUR and USD growth collapse to the same
        # (native) number. Both fall back to ``null`` when no figure is
        # available.
        "cost_basis_eur": dec(cost_basis_eur.get(iid)),
        "cost_basis_usd": dec(cost_basis_usd.get(iid)),
        "cumulative_dividends_cash_native": dec(position.cumulative_dividends_cash_native),
        "price_symbol": position.instrument.symbol,
        "price_type": _price_type(position),
        "is_money_market": is_money_market(
            position.instrument.symbol,
            asset_class=_asset_class(position),
            name=_position_name(position),
        ),
        "last_known_price_native": dec(position.current_price_native),
        # The trading day the exported ``last_known_price_native`` actually came
        # from (the latest cached close on/before the export date), so the web
        # companion can show *when the value was last updated* — e.g. a fund's
        # last NAV strike — instead of stamping the export date on a price that
        # is really days old. ``null`` for rows with no cached price history
        # (e.g. money-market funds pinned at their constant NAV).
        "last_price_date": iso(price_dates.get(iid)),
        # The prior published close (native) and its date, so the web can derive a
        # today's move from the export alone when the live price provider serves no
        # usable quote for this symbol. ``None`` when under two closes are cached.
        "previous_close_native": dec(prev_close[1]) if prev_close else None,
        "previous_close_date": iso(prev_close[0]) if prev_close else None,
        "cashflows": _paired_cashflows(
            cashflows.get(iid, []),
            cashflows_usd.get(iid, []),
        ),
    }


def _portfolio_metrics(session: Session, *, as_of: date) -> dict[str, str | None]:
    """Portfolio-level scalars the web needs to recompute the headline **capital
    gain** and **cumulative dividend return** live (against live prices), matching
    the desktop's definitions exactly.

    The desktop identity is ``capital_gain = total_value + dividends_cash −
    net_contributions`` (see :func:`domain.returns.capital_gain`). The web
    substitutes its *own live* total value into that identity, so it only needs
    the two fixed offsets — net contributions and realized cash dividends — plus
    lifetime dividend *income* (incl. reinvested distributions) for the cumulative
    dividend return (``dividend_income ÷ total_value``). Carrying these makes the
    web's "Total gain" the desktop's capital gain (cash dividends added back,
    measured against net contributions) rather than a bare value−cost unrealised
    P/L, and its "Div. return" the lifetime cumulative figure rather than a
    YTD-only one (it is a lifetime total, not an annualised yield).
    """
    m = metrics_service.compute_portfolio_metrics(session, as_of=as_of)
    # Realized cash dividends = capital_gain − total_value + net_contributions
    # (the inverse of the capital-gain identity above), a constant the web adds
    # back to its live total value.
    dividends_cash_eur = m.capital_gain_eur - m.total_value_eur + m.total_contributions_eur
    dividends_cash_usd = (
        m.capital_gain_usd - m.total_value_usd + m.total_contributions_usd
        if m.capital_gain_usd is not None and m.total_value_usd is not None
        else None
    )
    return {
        "net_contributions_eur": dec(m.total_contributions_eur),
        "net_contributions_usd": dec(m.total_contributions_usd),
        "dividends_cash_eur": dec(dividends_cash_eur),
        "dividends_cash_usd": dec(dividends_cash_usd),
        # Lifetime dividend income incl. reinvested distributions (desktop's
        # ``total_dividends_cash_eur`` is this income figure) for the cumulative
        # dividend return.
        "dividends_income_eur": dec(m.total_dividends_cash_eur),
        "dividends_income_usd": dec(m.total_dividends_cash_usd),
    }


def _cash_balances(session: Session, *, as_of: date) -> list[dict[str, str | None]]:
    rows: list[dict[str, str | None]] = []
    for account in accounts_repo.list_accounts(session):
        if account.account_type not in _CASH_ACCOUNT_TYPES:
            continue
        rows.append(
            {
                "account_label": account.account_label,
                "broker": account.broker,
                "native_currency": account.native_currency,
                "balance_native": dec(
                    positions_service.compute_cash_balance(session, account.id, as_of=as_of)
                ),
            }
        )
    return rows


def _portfolio_cashflows(
    session: Session,
    txns: list[Transaction],
) -> list[dict[str, str | None]]:
    retained_ids = metrics_service.build_retained_cash_account_ids(session, txns)
    eur_to_usd = fx_service.get_rates(session, base="EUR", quote="USD")

    def _usd_amount(t: Transaction) -> Decimal:
        return metrics_service._txn_usd_amount(t, eur_to_usd=eur_to_usd)

    eur_flows, usd_flows = metrics_service.build_portfolio_cashflows_dual(
        txns,
        retained_cash_account_ids=retained_ids,
        usd_amount_fn=_usd_amount,
    )
    return _paired_cashflows(eur_flows, usd_flows)


def _position_values_by_symbol(positions: list[Position]) -> dict[str, Decimal]:
    values: dict[str, Decimal] = {}
    for position in positions:
        symbol = position.instrument.symbol
        values[symbol] = values.get(symbol, Decimal(0)) + position.current_value_eur
    return values


def _period_openings(session: Session, *, as_of: date) -> dict[str, Any]:
    month_start = as_of.replace(day=1)
    year_start = as_of.replace(month=1, day=1)
    month_positions = positions_service.compute_positions(session, as_of=month_start)
    year_positions = positions_service.compute_positions(session, as_of=year_start)
    month_by_symbol = _position_values_by_symbol(month_positions)
    year_by_symbol = _position_values_by_symbol(year_positions)
    # Convert each boundary's EUR opening value at the EUR→USD rate in force on
    # that boundary date (forward-filled), mirroring the desktop's
    # ``sv_usd = sv_eur * fx_boundary``. This lets the web compute currency-
    # correct MTD/YTD growth in USD instead of rescaling at today's spot. When
    # no rate is available the USD figure is ``null`` and the web falls back to
    # the always-present EUR opening.
    eur_to_usd = fx_service.get_rates(session, base="EUR", quote="USD")
    month_rate = lookup_rate_with_forward_fill(eur_to_usd, month_start)
    year_rate = lookup_rate_with_forward_fill(eur_to_usd, year_start)

    def _usd(value: Decimal, rate: Decimal | None) -> Decimal | None:
        return value * rate if rate is not None else None

    month_total = sum(month_by_symbol.values(), start=Decimal(0))
    year_total = sum(year_by_symbol.values(), start=Decimal(0))
    return {
        "month_start_value_eur": dec(month_total),
        "year_start_value_eur": dec(year_total),
        "month_start_value_usd": dec(_usd(month_total, month_rate)),
        "year_start_value_usd": dec(_usd(year_total, year_rate)),
        "holdings": {
            symbol: {
                "month_start_value_eur": dec(month_by_symbol.get(symbol, Decimal(0))),
                "year_start_value_eur": dec(year_by_symbol.get(symbol, Decimal(0))),
                "month_start_value_usd": dec(
                    _usd(month_by_symbol.get(symbol, Decimal(0)), month_rate)
                ),
                "year_start_value_usd": dec(
                    _usd(year_by_symbol.get(symbol, Decimal(0)), year_rate)
                ),
            }
            for symbol in sorted(set(month_by_symbol) | set(year_by_symbol))
        },
    }


def _target_allocations(session: Session) -> list[dict[str, Any]]:
    """Serialize saved target allocations for the live-web companion.

    Each saved target carries its per-fund weights plus the central **no-buy**
    flag and the calculator settings (rebalance mode, display currency) frozen
    when it was saved, so the browser can show the same plan the desktop built.
    Items are keyed by both ``instrument_id`` (stable) and ``symbol`` (what the
    web holdings are keyed by); a fund with no matching instrument is skipped.
    """
    symbol_by_id = {i.id: i.symbol for i in instruments_repo.list_instruments(session)}
    allocations: list[dict[str, Any]] = []
    for alloc in allocations_repo.list_allocations(session):
        items = [
            {
                "instrument_id": item.instrument_id,
                "symbol": symbol_by_id[item.instrument_id],
                "weight_pct": dec(item.weight_pct),
                "no_buy": bool(item.no_buy),
            }
            for item in alloc.items
            if item.instrument_id in symbol_by_id
        ]
        allocations.append(
            {
                "name": alloc.name,
                "active": bool(alloc.active),
                "allow_sell": bool(alloc.allow_sell),
                "display_currency": alloc.display_currency,
                "items": items,
            }
        )
    return allocations


def build_mobile_export(
    session: Session,
    *,
    as_of: date | None = None,
    include_transactions: bool = False,
) -> dict[str, Any]:
    """Assemble the minimized, JSON-serializable live-web export."""
    context = build_context(session, as_of=as_of)
    positions = positions_service.compute_positions(session, as_of=context.as_of)
    instrument_cashflows_eur, instrument_cashflows_usd = metrics_service.build_instrument_cashflows(
        session,
        as_of=context.as_of,
    )
    # Per-instrument cost basis in USD at each buy's own trade-date FX, so the
    # web can show a currency-correct USD total gain (mirrors the desktop's
    # per-currency InstrumentMetrics rather than rescaling EUR at today's spot).
    instrument_metrics = compute_instrument_metrics(session, positions, as_of=context.as_of)
    cost_basis_eur = {iid: m.cost_basis_eur for iid, m in instrument_metrics.items()}
    cost_basis_usd = {iid: m.cost_basis_usd for iid, m in instrument_metrics.items()}
    # The trading day each holding's exported price actually came from, so the
    # web can show "value last updated on …" rather than the export date.
    instrument_ids = [p.instrument.id for p in positions]
    recent_closes = prices_service.recent_closes_by_instrument(
        session, instrument_ids, on_or_before=context.as_of, limit=2
    )
    price_dates: dict[int, date] = {
        instr_id: rows[0][0] for instr_id, rows in recent_closes.items() if rows
    }
    # The trading day's prior close (and its date) per instrument, so the web can
    # derive a today's move from the export alone when no live quote is available
    # (e.g. a fund the live price provider has stopped serving). ``rows`` are
    # newest-first; index ``[1]`` is the close one trading day before the exported
    # ``last_known_price_native``. Absent for instruments with under two closes.
    previous_closes: dict[int, tuple[date, Decimal]] = {
        instr_id: rows[1] for instr_id, rows in recent_closes.items() if len(rows) >= 2
    }
    txns = list(transactions_repo.list_transactions(session, end=context.as_of))
    # The web companion carries figures in EUR as its internal FX-pivot (USD is
    # the native booked currency) but lets the reader flip to USD on the
    # device, independently of whatever display currency the desktop happens to
    # be set to. Period figures are sums of *historical* flows / point-in-time
    # valuations, so they must be converted at the FX rate in force on each
    # trade/boundary date — not today's spot. Building the period read-models
    # against a USD context makes the per-trade-date ``*_display`` (USD) figures
    # always present (alongside the always-present ``*_eur``), so the browser
    # never has to rescale a historical EUR total by today's rate. The deposits
    # read-model already emits per-date-FX ``*_usd`` figures unconditionally.
    # When no EUR→USD history exists (``fx_rate_eur_usd is None``) the period
    # aggregation simply leaves the ``*_display`` fields null and the browser
    # falls back to the always-present ``*_eur`` figures.
    usd_context = replace(
        context,
        display_currency="USD",
        fx_rate_eur_to_display=context.fx_rate_eur_usd,
    )
    export: dict[str, Any] = {
        "meta": build_meta(context),
        "holdings": [
            _holding_dict(
                position,
                cashflows=instrument_cashflows_eur,
                cashflows_usd=instrument_cashflows_usd,
                cost_basis_eur=cost_basis_eur,
                cost_basis_usd=cost_basis_usd,
                price_dates=price_dates,
                previous_closes=previous_closes,
            )
            for position in positions
        ],
        "portfolio_cashflows": _portfolio_cashflows(session, txns),
        "portfolio_metrics": _portfolio_metrics(session, as_of=context.as_of),
        "cash": _cash_balances(session, as_of=context.as_of),
        "period_openings": _period_openings(session, as_of=context.as_of),
        "monthly": periods.build_monthly(session, context=usd_context),
        "yearly": periods.build_yearly(session, context=usd_context),
        "analytics": analytics.build(session, context=context, full_history_curve=True),
        "deposits": deposits.build(session, context=context),
        "target_allocations": _target_allocations(session),
    }
    if include_transactions:
        export["transactions"] = transactions.build(session, context=context)
    return export
