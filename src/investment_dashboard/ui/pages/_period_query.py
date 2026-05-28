"""Period aggregation helpers used by ``/monthly`` and ``/yearly``.

Both pages share a common shape — bucket cashflow transactions by month/year,
compute contributions + dividends + end-of-period mark-to-market closing
balance.

Closing balance is computed via
:func:`investment_dashboard.services.positions_service.total_portfolio_value`
evaluated at the last day of the period (capped at today). It uses
last-known prices and FX rates with forward-fill, so periods preceding
the first available price tick will report a best-effort value.

v2.2 made the aggregation **FX-aware** per trade date. When the caller
passes ``display_currency`` other than ``"EUR"``, each transaction's EUR
amount is converted using the EUR→quote rate **on the trade date** (not
today's spot), and each period's opening/closing balance is converted
using the rate on that period boundary. The Modified Dietz growth % is
then computed in the display currency, so a USD or DKK reader sees the
return their wallet actually experienced — including the FX drift the
old code silently scaled away. EUR-display callers and callers that
omit ``display_currency`` keep their original behaviour.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from investment_dashboard.domain.currency import lookup_rate_with_forward_fill
from investment_dashboard.models import Transaction

ZERO = Decimal(0)


@dataclass(frozen=True)
class PeriodRow:
    """One row of the monthly or yearly aggregation.

    All ``*`` fields without a currency suffix are in EUR — the storage
    convention of the ledger. The optional ``*_display`` fields are
    pre-converted into the page's display currency using per-trade-date
    FX (for cashflows) and per-period-end FX (for balances). They are
    populated only when :func:`aggregate` was called with a
    non-EUR ``display_currency`` and FX history is available; otherwise
    they remain ``None`` and the table renderer falls back to scaling
    the EUR series by today's spot rate (legacy v1.3 behaviour).
    """

    label: str
    contributions: Decimal
    dividends: Decimal
    interest: Decimal
    net_flow: Decimal
    closing_value_eur: Decimal = ZERO
    opening_value_eur: Decimal = ZERO
    growth_pct: Decimal | None = None
    #: Per-trade-date FX-converted values into the display currency.
    contributions_display: Decimal | None = None
    dividends_display: Decimal | None = None
    interest_display: Decimal | None = None
    net_flow_display: Decimal | None = None
    closing_value_display: Decimal | None = None
    opening_value_display: Decimal | None = None
    growth_pct_display: Decimal | None = None
    #: The currency the ``*_display`` fields are denominated in (upper
    #: case ISO code). Empty when no FX-aware path was taken.
    display_currency: str = field(default="")


def _amount_eur(t: Transaction) -> Decimal:
    if t.net_eur is not None:
        return t.net_eur
    return t.net_native or ZERO


def _period_key(d: date, *, monthly: bool) -> str:
    return d.strftime("%Y-%m") if monthly else str(d.year)


def _period_end(label: str, *, monthly: bool, today: date) -> date:
    """End-of-period date (capped at ``today``) for a bucket label."""
    if monthly:
        year, month = (int(p) for p in label.split("-"))
        last_day = calendar.monthrange(year, month)[1]
        period_end = date(year, month, last_day)
    else:
        period_end = date(int(label), 12, 31)
    return min(period_end, today)


def _period_start(label: str, *, monthly: bool) -> date:
    """First-of-period date for a bucket label (uncapped)."""
    if monthly:
        year, month = (int(p) for p in label.split("-"))
        return date(year, month, 1)
    return date(int(label), 1, 1)


def _modified_dietz(
    opening: Decimal,
    closing: Decimal,
    net_external_flow: Decimal,
) -> Decimal | None:
    """Modified Dietz period return: ``(V_end - V_start - F) / (V_start + 0.5·F)``.

    ``net_external_flow`` is contributions (positive) minus withdrawals
    (negative-already-signed) — dividends and interest stay *inside* the
    portfolio for this calc (they're internal gains, not external cash).
    Returns ``None`` if the denominator is non-positive.
    """
    denom = opening + net_external_flow / Decimal(2)
    if denom <= 0:
        return None
    return (closing - opening - net_external_flow) / denom


def _display_value(value_eur: Decimal, currency: str, fx_rate: Decimal | None) -> Decimal:
    if currency.upper() == "EUR" or fx_rate is None or fx_rate == 0:
        return value_eur
    return value_eur * fx_rate


def _convert_to_usd(value_eur: Decimal, fx_rate: Decimal | None) -> Decimal:
    if fx_rate is None or fx_rate == 0:
        return value_eur
    return value_eur * fx_rate


def aggregate(  # noqa: PLR0912, PLR0915
    session: Session,
    *,
    monthly: bool,
    with_closing_value: bool = True,
    today: date | None = None,
    display_currency: str | None = None,
) -> list[PeriodRow]:
    """Return one :class:`PeriodRow` per non-empty period, oldest first.

    If ``with_closing_value`` is true (default) the row's
    ``closing_value_eur`` is the mark-to-market portfolio value at the
    end of that period (capped at ``today``). Set it to ``False`` for
    callers that only need cashflow buckets and want to skip the
    per-period position roll-up.

    When ``display_currency`` is provided and is not ``EUR``, each row
    also carries ``*_display`` fields denominated in that currency using
    per-trade-date FX (cashflows) and per-period-end FX (balances), with
    a Modified Dietz growth % computed in the display currency. The EUR
    fields are unchanged so EUR-display callers see no diff.
    """
    txns = session.scalars(select(Transaction)).all()
    buckets: dict[str, dict[str, Decimal]] = {}
    for t in txns:
        key = _period_key(t.date, monthly=monthly)
        b = buckets.setdefault(key, {"contrib": ZERO, "div": ZERO, "int": ZERO})
        amt = _amount_eur(t)
        if t.kind == "deposit":
            b["contrib"] += amt
        elif t.kind == "withdrawal":
            b["contrib"] -= amt
        elif t.kind == "dividend_cash":
            b["div"] += amt
        elif t.kind == "interest":
            b["int"] += amt

    today = today or date.today()
    closing_by_label: dict[str, Decimal] = {}
    opening_by_label: dict[str, Decimal] = {}
    growth_by_label: dict[str, Decimal | None] = {}
    if with_closing_value and buckets:
        # Local import to avoid a cycle: services -> repositories -> models,
        # while this module is imported by the UI layer which also imports
        # services elsewhere.
        from investment_dashboard.services import snapshots_service  # noqa: PLC0415

        for label, agg in buckets.items():
            period_end = _period_end(label, monthly=monthly, today=today)
            period_open = _period_start(label, monthly=monthly)
            try:
                closing_by_label[label] = snapshots_service.get_or_compute(session, period_end)
                # Opening = previous day's close (capped if start > today).
                if period_open <= today:
                    opening_by_label[label] = snapshots_service.get_or_compute(
                        session, period_open - timedelta(days=1)
                    )
                else:
                    opening_by_label[label] = ZERO
            except Exception:  # pragma: no cover - defensive: keep page renderable
                closing_by_label[label] = ZERO
                opening_by_label[label] = ZERO
            growth_by_label[label] = _modified_dietz(
                opening_by_label[label],
                closing_by_label[label],
                agg["contrib"],
            )

    # ------- FX-aware per-display-currency reaggregation (v2.2) -------
    display_buckets: dict[str, dict[str, Decimal]] = {}
    closing_display: dict[str, Decimal | None] = {}
    opening_display: dict[str, Decimal | None] = {}
    growth_display: dict[str, Decimal | None] = {}
    normalised_display_ccy = ""
    if display_currency and display_currency.upper() != "EUR" and buckets:
        normalised_display_ccy = display_currency.upper()
        # Load the EUR→display series once (small dict; fx_history is
        # a daily cache table per quote, not per row).
        from investment_dashboard.repositories import fx_repo  # noqa: PLC0415

        fx_rates = fx_repo.get_rates(session, base="EUR", quote=normalised_display_ccy)

        # If we have no FX history at all for this quote, skip the
        # display-side conversion entirely — the renderer's spot-rate
        # fallback is more useful than emitting zeros for every row.
        if fx_rates:
            for label in buckets:
                display_buckets[label] = {"contrib": ZERO, "div": ZERO, "int": ZERO}
            for t in txns:
                rate = lookup_rate_with_forward_fill(fx_rates, t.date)
                if rate is None or rate == 0:
                    continue
                key = _period_key(t.date, monthly=monthly)
                b = display_buckets[key]
                amt = _amount_eur(t) * rate
                if t.kind == "deposit":
                    b["contrib"] += amt
                elif t.kind == "withdrawal":
                    b["contrib"] -= amt
                elif t.kind == "dividend_cash":
                    b["div"] += amt
                elif t.kind == "interest":
                    b["int"] += amt

            if with_closing_value:
                from investment_dashboard.services import (  # noqa: PLC0415
                    snapshots_service as _snap_for_ccy,
                )

                for label in buckets:
                    period_end = _period_end(label, monthly=monthly, today=today)
                    period_open = _period_start(label, monthly=monthly)
                    try:
                        closing_display[label] = _snap_for_ccy.get_or_compute_in_currency(
                            session,
                            period_end,
                            normalised_display_ccy,
                        )
                        if period_open <= today:
                            opening_display[label] = _snap_for_ccy.get_or_compute_in_currency(
                                session,
                                period_open - timedelta(days=1),
                                normalised_display_ccy,
                            )
                        else:
                            opening_display[label] = ZERO
                    except Exception:  # pragma: no cover - defensive
                        closing_display[label] = ZERO
                        opening_display[label] = ZERO
                    growth_display[label] = _modified_dietz(
                        opening_display[label] or ZERO,
                        closing_display[label] or ZERO,
                        display_buckets[label]["contrib"],
                    )

    rows = [
        PeriodRow(
            label=k,
            contributions=v["contrib"],
            dividends=v["div"],
            interest=v["int"],
            net_flow=v["contrib"] + v["div"] + v["int"],
            closing_value_eur=closing_by_label.get(k, ZERO),
            opening_value_eur=opening_by_label.get(k, ZERO),
            growth_pct=growth_by_label.get(k),
            contributions_display=(display_buckets[k]["contrib"] if k in display_buckets else None),
            dividends_display=(display_buckets[k]["div"] if k in display_buckets else None),
            interest_display=(display_buckets[k]["int"] if k in display_buckets else None),
            net_flow_display=(
                display_buckets[k]["contrib"]
                + display_buckets[k]["div"]
                + display_buckets[k]["int"]
                if k in display_buckets
                else None
            ),
            closing_value_display=closing_display.get(k),
            opening_value_display=opening_display.get(k),
            growth_pct_display=growth_display.get(k) if k in growth_display else None,
            display_currency=normalised_display_ccy,
        )
        for k, v in sorted(buckets.items())
    ]
    return rows


def to_table_rows(
    rows: list[PeriodRow],
    *,
    currency: str = "EUR",
    fx_rate: Decimal | None = None,
) -> list[dict[str, str]]:
    """Format aggregation rows into the dict shape the AG-Grid wants.

    When a row's ``*_display`` fields are populated (the FX-aware path
    in :func:`aggregate`), the display-currency columns use those —
    they reflect per-trade-date FX. Otherwise the renderer falls back
    to multiplying the EUR series by ``fx_rate`` (today's spot), which
    preserves v1.3 behaviour for EUR/USD callers that don't opt into
    FX-aware aggregation.
    """

    def _display(eur_value: Decimal, display_value: Decimal | None) -> Decimal:
        if display_value is not None:
            return display_value
        return _display_value(eur_value, currency, fx_rate)

    def _growth_pct(r: PeriodRow) -> Decimal | None:
        if r.growth_pct_display is not None:
            return r.growth_pct_display
        return r.growth_pct

    return [
        {
            "label": r.label,
            "contributions": f"{_display(r.contributions, r.contributions_display):,.2f}",
            "contributions_eur": f"{r.contributions:,.2f}",
            "contributions_usd": f"{_convert_to_usd(r.contributions, fx_rate):,.2f}",
            "dividends": f"{_display(r.dividends, r.dividends_display):,.2f}",
            "dividends_eur": f"{r.dividends:,.2f}",
            "dividends_usd": f"{_convert_to_usd(r.dividends, fx_rate):,.2f}",
            "interest": f"{_display(r.interest, r.interest_display):,.2f}",
            "interest_eur": f"{r.interest:,.2f}",
            "interest_usd": f"{_convert_to_usd(r.interest, fx_rate):,.2f}",
            "net_flow": f"{_display(r.net_flow, r.net_flow_display):,.2f}",
            "net_flow_eur": f"{r.net_flow:,.2f}",
            "net_flow_usd": f"{_convert_to_usd(r.net_flow, fx_rate):,.2f}",
            "closing_value": (f"{_display(r.closing_value_eur, r.closing_value_display):,.2f}"),
            "closing_value_eur": f"{r.closing_value_eur:,.2f}",
            "closing_value_usd": f"{_convert_to_usd(r.closing_value_eur, fx_rate):,.2f}",
            "growth_pct": (
                f"{(_growth_pct(r) or 0) * Decimal(100):,.2f} %"
                if _growth_pct(r) is not None
                else "—"
            ),
        }
        for r in rows
    ]
