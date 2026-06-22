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
from investment_dashboard.domain.money_market import is_money_market
from investment_dashboard.domain.returns import Cashflow
from investment_dashboard.models import Transaction
from investment_dashboard.readmodels import analytics, deposits, periods, transactions
from investment_dashboard.readmodels._context import ReadModelContext, build_context
from investment_dashboard.readmodels._serialize import dec, iso, now_utc_iso
from investment_dashboard.repositories import accounts_repo, transactions_repo
from investment_dashboard.services import metrics_service, positions_service, prices_service
from investment_dashboard.services.positions_service import Position

SCHEMA_VERSION = 1

_NAV_ASSET_CLASSES = {"mutual_fund", "cash", "savings", "money_market", "money-market"}
_CASH_ACCOUNT_TYPES = {"savings", "cash"}


def _cashflow_dict(flow: Cashflow) -> dict[str, str | None]:
    return {"date": iso(flow.date), "amount": dec(flow.amount)}


def _position_name(position: Position) -> str | None:
    if position.effective is not None and position.effective.name:
        return position.effective.name
    return position.instrument.name


def _asset_class(position: Position) -> str:
    if position.effective is not None:
        return position.effective.asset_class
    return position.instrument.asset_class


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
    price_dates: dict[int, date],
) -> dict[str, Any]:
    return {
        "symbol": position.instrument.symbol,
        "name": _position_name(position),
        "asset_class": _asset_class(position),
        "broker": position.account.broker,
        "account": position.account.account_label,
        "native_currency": position.account.native_currency,
        "shares": dec(position.shares),
        "cost_basis_native": dec(position.cost_basis_native),
        "cumulative_dividends_cash_native": dec(position.cumulative_dividends_cash_native),
        "price_symbol": position.instrument.symbol,
        "price_type": _price_type(position),
        "last_known_price_native": dec(position.current_price_native),
        # The trading day the exported ``last_known_price_native`` actually came
        # from (the latest cached close on/before the export date), so the web
        # companion can show *when the value was last updated* — e.g. a fund's
        # last NAV strike — instead of stamping the export date on a price that
        # is really days old. ``null`` for rows with no cached price history
        # (e.g. money-market funds pinned at their constant NAV).
        "last_price_date": iso(price_dates.get(position.instrument.id)),
        "cashflows": [_cashflow_dict(flow) for flow in cashflows.get(position.instrument.id, [])],
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
    flows = metrics_service.build_portfolio_cashflows(
        txns,
        retained_cash_account_ids=retained_ids,
    )
    return [_cashflow_dict(flow) for flow in flows]


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
    return {
        "month_start_value_eur": dec(sum(month_by_symbol.values(), start=Decimal(0))),
        "year_start_value_eur": dec(sum(year_by_symbol.values(), start=Decimal(0))),
        "holdings": {
            symbol: {
                "month_start_value_eur": dec(month_by_symbol.get(symbol, Decimal(0))),
                "year_start_value_eur": dec(year_by_symbol.get(symbol, Decimal(0))),
            }
            for symbol in sorted(set(month_by_symbol) | set(year_by_symbol))
        },
    }


def build_mobile_export(
    session: Session,
    *,
    as_of: date | None = None,
    include_transactions: bool = False,
) -> dict[str, Any]:
    """Assemble the minimized, JSON-serializable live-web export."""
    context = build_context(session, as_of=as_of)
    positions = positions_service.compute_positions(session, as_of=context.as_of)
    instrument_cashflows_eur, _ = metrics_service.build_instrument_cashflows(
        session,
        as_of=context.as_of,
    )
    # The trading day each holding's exported price actually came from, so the
    # web can show "value last updated on …" rather than the export date.
    instrument_ids = [p.instrument.id for p in positions]
    recent_closes = prices_service.recent_closes_by_instrument(
        session, instrument_ids, on_or_before=context.as_of, limit=1
    )
    price_dates: dict[int, date] = {
        instr_id: rows[0][0] for instr_id, rows in recent_closes.items() if rows
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
            _holding_dict(position, cashflows=instrument_cashflows_eur, price_dates=price_dates)
            for position in positions
        ],
        "portfolio_cashflows": _portfolio_cashflows(session, txns),
        "cash": _cash_balances(session, as_of=context.as_of),
        "period_openings": _period_openings(session, as_of=context.as_of),
        "monthly": periods.build_monthly(session, context=usd_context),
        "yearly": periods.build_yearly(session, context=usd_context),
        "analytics": analytics.build(session, context=context, full_history_curve=True),
        "deposits": deposits.build(session, context=context),
    }
    if include_transactions:
        export["transactions"] = transactions.build(session, context=context)
    return export
