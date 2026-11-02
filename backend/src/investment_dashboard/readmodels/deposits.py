"""Deposits read-model — contribution KPIs + raw cash-flow rows."""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.domain import dividends as dividends_domain
from investment_dashboard.readmodels._context import ReadModelContext, build_context
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.readmodels.queries.deposits_query import (
    DepositRecord,
    DepositSummary,
    compute_summary,
    list_deposit_records,
)
from investment_dashboard.repositories import transactions_repo
from investment_dashboard.services import cashflows, fx_conversion_service, fx_service
from investment_dashboard.services.metrics_service import compute_portfolio_metrics

ZERO = Decimal(0)

#: ``kind`` filter values; ``transfer`` covers both directions.
KIND_FILTERS: dict[str, frozenset[str]] = {
    "deposit": frozenset({"deposit"}),
    "withdrawal": frozenset({"withdrawal"}),
    "transfer": frozenset({"transfer_in", "transfer_out"}),
}


def _conversion_info(session: Session) -> dict[int, dict[str, Any]]:
    """Per USD deposit id: the conversion batches it was paid from and its rate.

    Empty when no conversions are recorded (then no deposit claims a source).
    ``effective_rate`` is USD per EUR actually obtained; ``rate_source`` is
    ``"conversions"``, ``"ecb"`` (pool did not cover it) or ``"mixed"``.
    """
    report = fx_conversion_service.pool_report(session)
    if not report.conversions:
        return {}
    dates = {c.id: c.date for c in report.conversions}
    info: dict[int, dict[str, Any]] = {}
    for m in report.result.deposits:
        if not m.matched:
            source = "ecb"
        elif m.is_fallback:
            source = "mixed"
        else:
            source = "conversions"
        info[m.deposit_id] = {
            "effective_rate": None if m.rate_missing else dec(m.blended_rate),
            "rate_source": source,
            "conversion_batches": [
                {
                    "conversion_id": sl.conversion_id,
                    "date": dates[sl.conversion_id].isoformat(),
                    "usd": dec(sl.usd),
                    "eur": dec(sl.eur),
                }
                for sl in m.matched
            ],
        }
    return info


def _summary_dict(s: DepositSummary) -> dict[str, Any]:
    return {
        "total_contrib_native": dec(s.total_contrib_native),
        "total_contrib_eur": dec(s.total_contrib_eur),
        "ytd_contrib_eur": dec(s.ytd_contrib_eur),
        "mtd_contrib_eur": dec(s.mtd_contrib_eur),
        "total_contrib_usd": dec(s.total_contrib_usd),
        "ytd_contrib_usd": dec(s.ytd_contrib_usd),
        "mtd_contrib_usd": dec(s.mtd_contrib_usd),
    }


def _record_dict(r: DepositRecord) -> dict[str, Any]:
    return {
        "id": r.id,
        "date": r.date.isoformat(),
        "account": r.account_label,
        "kind": r.kind,
        "amount_native": dec(r.amount_native),
        "currency": r.native_currency,
        "amount_eur": dec(r.amount_eur),
        "amount_usd": dec(r.amount_usd) if r.amount_usd is not None else None,
        "description": r.description,
    }


def build(session: Session, *, context: ReadModelContext | None = None) -> dict[str, Any]:
    """Return the JSON-serializable deposits read-model."""
    ctx = context or build_context(session)
    summary = compute_summary(session, today=ctx.as_of)
    rows = list_deposit_records(session)
    return {
        "summary": _summary_dict(summary),
        "rows": [_record_dict(r) for r in rows],
    }


def _summary_for(summary: DepositSummary, ccy: str) -> dict[str, Any]:
    usd = ccy == "USD"
    return {
        "total_contrib": dec(summary.total_contrib_usd if usd else summary.total_contrib_eur),
        "ytd_contrib": dec(summary.ytd_contrib_usd if usd else summary.ytd_contrib_eur),
        "mtd_contrib": dec(summary.mtd_contrib_usd if usd else summary.mtd_contrib_eur),
        "total_contrib_native": dec(summary.total_contrib_native),
    }


def _by_year(records: list[DepositRecord], ccy: str, other: str) -> list[dict[str, Any]]:
    """Per-year count and net total in ``ccy`` and ``other`` (newest year first).

    💱 Each row contributes its own trade-date leg (never a converted total); a
    row whose leg cannot be derived counts toward ``count`` but adds nothing.
    """

    def leg(r: DepositRecord, code: str) -> Decimal:
        value = r.amount_usd if code == "USD" else r.amount_eur
        return value if value is not None else ZERO

    count: dict[int, int] = defaultdict(int)
    total: dict[int, Decimal] = defaultdict(lambda: ZERO)
    total_other: dict[int, Decimal] = defaultdict(lambda: ZERO)
    for r in records:
        count[r.date.year] += 1
        total[r.date.year] += leg(r, ccy)
        total_other[r.date.year] += leg(r, other)
    return [
        {
            "year": y,
            "count": count[y],
            "total": dec(total[y]),
            "total_other": dec(total_other[y]),
        }
        for y in sorted(count, reverse=True)
    ]


def build_for_ccy(
    session: Session,
    *,
    ccy: str,
    account_id: int | None = None,
    kind: str | None = None,
    year: int | None = None,
    context: ReadModelContext | None = None,
) -> dict[str, Any]:
    """Deposits summary + rows in one reporting currency.

    ``amount`` is the per-transaction leg in ``ccy`` at the trade-date rate
    (``None`` when it cannot be derived); ``amount_other`` is the same in the
    other reporting currency (second line on the page). Rows keep the native
    amount. ``kind`` / ``year`` / ``account_id`` filter the rows and ``by_year``;
    ``summary`` stays the whole-ledger KPI block.
    """
    ccy = ccy.upper()
    other = "EUR" if ccy == "USD" else "USD"
    ctx = context or build_context(session)
    summary = compute_summary(session, today=ctx.as_of)
    all_records = list_deposit_records(session, account_id=account_id)
    records = [
        r
        for r in all_records
        if (kind is None or r.kind in KIND_FILTERS[kind]) and (year is None or r.date.year == year)
    ]
    usd = ccy == "USD"
    conv = _conversion_info(session)
    no_conv: dict[str, Any] = {
        "effective_rate": None,
        "rate_source": None,
        "conversion_batches": [],
    }
    return {
        "ccy": ccy,
        "other_ccy": other,
        "as_of": ctx.as_of.isoformat(),
        "summary": _summary_for(summary, ccy),
        "summary_other": _summary_for(summary, other),
        "years": sorted({r.date.year for r in all_records}, reverse=True),
        "by_year": _by_year(records, ccy, other),
        "rows": [
            {
                "id": r.id,
                "date": r.date.isoformat(),
                "account": r.account_label,
                "kind": r.kind,
                "amount_native": dec(r.amount_native),
                "currency": r.native_currency,
                "amount": dec(r.amount_usd if usd else r.amount_eur),
                "amount_other": dec(r.amount_eur if usd else r.amount_usd),
                "description": r.description,
                **(conv.get(r.id, no_conv) if r.id is not None else no_conv),
            }
            for r in records
        ],
    }


# -- dividends ------------------------------------------------------------------


def _one_year_before(as_of: date) -> date:
    try:
        return as_of.replace(year=as_of.year - 1)
    except ValueError:  # 29 Feb
        return date(as_of.year - 1, 3, 1)


def _dividend_payment(
    t: Any,
    keys: set[tuple[int, int | None, date]],
    eur_to_usd: dict[date, Decimal],
    ccy: str,
    other: str,
) -> tuple[dict[str, Any], Decimal | None, Decimal | None] | None:
    """``(row, amount in ccy, amount in other)`` for one income transaction, or ``None``."""
    if t.kind == "interest":
        kind = "interest"
        amt = cashflows.txn_amount(t, ccy, eur_to_usd=eur_to_usd)
        amt_o = cashflows.txn_amount(t, other, eur_to_usd=eur_to_usd)
        native = t.net_native
    else:
        eur, usd_leg = dividends_domain.income_dual(t, keys, eur_to_usd=eur_to_usd)
        if eur is None and usd_leg is None:
            return None
        amt, amt_o = (usd_leg, eur) if ccy == "USD" else (eur, usd_leg)
        native = dividends_domain.income_value_native(t, keys)
        kind = "reinvest" if t.kind == "dividend_reinvest" else "cash"
    account: Any = t.account
    row = {
        "id": t.id,
        "date": t.date.isoformat(),
        "symbol": t.instrument.symbol if t.instrument is not None else "",
        "account": account.account_label if account else "",
        "kind": kind,
        "amount_native": dec(native),
        "currency": account.native_currency if account else "",
        "amount": dec(amt),
        "amount_other": dec(amt_o),
    }
    return row, amt, amt_o


def build_dividends(
    session: Session, *, ccy: str, context: ReadModelContext | None = None
) -> dict[str, Any]:
    """Dividend + interest income: payments, per-year, per-holding, TTM and yield.

    💱 Income is recognised once per distribution (``domain.dividends``, the same
    rule as the Overview KPIs) and valued at its own trade date's rate in ``ccy``
    (``other`` for the second line). Interest is listed but kept out of the
    dividend totals, as on the Overview. The yield ratios come from
    ``compute_portfolio_metrics`` so they match the Overview exactly.
    """
    ccy = ccy.upper()
    other = "EUR" if ccy == "USD" else "USD"
    ctx = context or build_context(session)
    ttm_start = _one_year_before(ctx.as_of)
    txns = list(
        transactions_repo.list_by_kinds_with_account(
            session, ("dividend_cash", "dividend_reinvest", "interest"), newest_first=True
        )
    )
    eur_to_usd = fx_service.get_rates(session, base="EUR", quote="USD")
    keys = dividends_domain.reinvest_keys(txns)

    rows: list[dict[str, Any]] = []
    # (symbol) -> accumulators in ccy / other
    holding: dict[str, dict[str, Any]] = {}
    year_div: dict[int, Decimal] = defaultdict(lambda: ZERO)
    year_div_other: dict[int, Decimal] = defaultdict(lambda: ZERO)
    year_int: dict[int, Decimal] = defaultdict(lambda: ZERO)
    year_int_other: dict[int, Decimal] = defaultdict(lambda: ZERO)
    year_count: dict[int, int] = defaultdict(int)
    life = ttm = life_o = ttm_o = ZERO
    for t in txns:
        payment = _dividend_payment(t, keys, eur_to_usd, ccy, other)
        if payment is None:
            continue  # cash leg of a reinvested dividend: counted via its pair
        row, amt, amt_o = payment
        is_interest = row["kind"] == "interest"
        symbol = row["symbol"]
        rows.append(row)
        y = t.date.year
        year_count[y] += 1
        if is_interest:
            year_int[y] += amt or ZERO
            year_int_other[y] += amt_o or ZERO
            continue
        year_div[y] += amt or ZERO
        year_div_other[y] += amt_o or ZERO
        life += amt or ZERO
        life_o += amt_o or ZERO
        in_ttm = t.date >= ttm_start
        if in_ttm:
            ttm += amt or ZERO
            ttm_o += amt_o or ZERO
        h = holding.setdefault(
            symbol,
            {
                "symbol": symbol,
                "name": (t.instrument.name if t.instrument is not None else "") or "",
                "count": 0,
                "lifetime": ZERO,
                "ttm": ZERO,
                "lifetime_other": ZERO,
                "ttm_other": ZERO,
                "last_date": t.date,
            },
        )
        h["count"] += 1
        h["lifetime"] += amt or ZERO
        h["lifetime_other"] += amt_o or ZERO
        if in_ttm:
            h["ttm"] += amt or ZERO
            h["ttm_other"] += amt_o or ZERO
        h["last_date"] = max(h["last_date"], t.date)

    metrics = compute_portfolio_metrics(session, as_of=ctx.as_of) if txns else None
    by_holding = sorted(holding.values(), key=lambda h: (-h["lifetime"], h["symbol"]))
    return {
        "ccy": ccy,
        "other_ccy": other,
        "as_of": ctx.as_of.isoformat(),
        "lifetime_total": dec(life),
        "lifetime_total_other": dec(life_o),
        "ttm_total": dec(ttm),
        "ttm_total_other": dec(ttm_o),
        "yield_ttm": dec(metrics.dividend_yield_ttm_pct if metrics else None),
        "yield_lifetime": dec(metrics.dividend_yield_pct if metrics else None),
        "by_year": [
            {
                "year": y,
                "count": year_count[y],
                "dividends": dec(year_div[y]),
                "interest": dec(year_int[y]),
                "dividends_other": dec(year_div_other[y]),
                "interest_other": dec(year_int_other[y]),
            }
            for y in sorted(year_count, reverse=True)
        ],
        "by_holding": [
            {
                "symbol": h["symbol"],
                "name": h["name"],
                "count": h["count"],
                "lifetime": dec(h["lifetime"]),
                "ttm": dec(h["ttm"]),
                "lifetime_other": dec(h["lifetime_other"]),
                "ttm_other": dec(h["ttm_other"]),
                "last_date": h["last_date"].isoformat(),
            }
            for h in by_holding
        ],
        "rows": rows,
    }
