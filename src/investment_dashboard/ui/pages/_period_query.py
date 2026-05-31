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
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, joinedload

from investment_dashboard.domain.currency import lookup_rate_with_forward_fill
from investment_dashboard.domain.returns import (
    total_growth_pct_compounded,
    xirr,
    years_between,
)
from investment_dashboard.models import Transaction

ZERO = Decimal(0)

#: AG-Grid ``valueFormatter`` (JS) rendering a numeric money value with
#: thousands separators and two decimals; blanks out ``null``.
_MONEY_FORMATTER = (
    "params.value == null ? '' : params.value.toLocaleString("
    "undefined,{minimumFractionDigits:2,maximumFractionDigits:2})"
)

#: AG-Grid ``valueFormatter`` (JS) rendering a numeric fraction as a signed
#: percentage, e.g. ``0.0455`` -> ``"4.55 %"``; blanks out ``null``.
_PCT_FORMATTER = (
    "params.value == null ? '' : (params.value * 100).toLocaleString("
    "undefined,{minimumFractionDigits:2,maximumFractionDigits:2}) + ' %'"
)


def _sign_rules(signed_field: str) -> dict[str, str]:
    """AG-Grid ``cellClassRules`` colouring a cell by the sign of its value."""
    return {
        "inv-cell-pos": f"data.{signed_field} > 0",
        "inv-cell-neg": f"data.{signed_field} < 0",
    }


def money_column(label: str, field: str, currency: str) -> dict[str, object]:
    """A single money column for the display ``currency`` only (v2.9.1).

    Binds to the ``{field}_{ccy}_num`` numeric row key produced by
    :func:`to_table_rows` so the column sorts by value, and renders it with a
    thousands-separated money ``valueFormatter``. The page shows one currency
    at a time and flips the whole table via the header toggle.
    """
    ccy = currency.upper()
    return {
        "headerName": f"{label} ({ccy})",
        "field": f"{field}_{ccy.lower()}_num",
        "type": "rightAligned",
        "valueFormatter": _MONEY_FORMATTER,
        "minWidth": 120,
    }


def pct_column(label: str, field: str, currency: str) -> dict[str, object]:
    """A single percentage column for the display ``currency``, sign-coloured."""
    ccy = currency.upper()
    signed_field = f"{field}_{ccy.lower()}_signed"
    return {
        "headerName": f"{label} ({ccy})",
        "field": signed_field,
        "type": "rightAligned",
        "valueFormatter": _PCT_FORMATTER,
        "cellClassRules": _sign_rules(signed_field),
        "minWidth": 120,
    }


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
    #: Cumulative Total Growth (compounded XIRR) measured from the
    #: portfolio inception up to the end of this period — the v2.5
    #: headline metric on the monthly / yearly tables. ``None`` when
    #: the period precedes any external cashflow or XIRR cannot be
    #: rooted (degenerate cashflow stream).
    total_growth_compounded_eur: Decimal | None = None
    total_growth_compounded_usd: Decimal | None = None
    #: Closing value translated to USD with the period-end FX rate
    #: (forward-filled). ``None`` when no FX history is on file.
    closing_value_usd: Decimal | None = None


def _amount_eur(
    t: Transaction,
    *,
    eur_to_usd: dict[date, Decimal] | None = None,
) -> Decimal:
    """Return the transaction's EUR amount, computing it on the fly when needed.

    The importer normally writes ``net_eur`` for every transaction, but
    when the FX cache was empty at import time it left ``net_eur=None``.
    The v2.3 fallback was to return ``net_native`` unchanged — which, for
    USD-native accounts, silently treated dollars as euros and made the
    monthly/yearly tables show wildly wrong (and usually inflated) EUR
    totals. v2.4 instead converts ``net_native`` via the EUR→native
    rate that was in force on the trade date (forward-filled when
    necessary), and only falls back to the raw ``net_native`` when even
    that is unavailable *and* the account is EUR-native.
    """
    if t.net_eur is not None:
        return t.net_eur
    if t.net_native is None:
        return ZERO
    native_ccy = (t.account.native_currency if t.account else "EUR").upper()
    if native_ccy == "EUR":
        return t.net_native
    if native_ccy == "USD" and eur_to_usd:
        rate = lookup_rate_with_forward_fill(eur_to_usd, t.date)
        if rate is not None and rate != 0:
            return t.net_native / rate
    # Last resort: leave the figure out rather than mix currencies; the
    # caller's bucket will simply be missing this row instead of being
    # poisoned with a wrong-magnitude number.
    return ZERO


def _amount_in(
    t: Transaction,
    *,
    display_currency: str,
    eur_to_usd: dict[date, Decimal],
) -> Decimal | None:
    """Return the txn's value in ``display_currency`` for trade-date FX.

    Returns ``None`` when we cannot honestly produce a number (e.g. no
    FX rate is on file and the native currency doesn't match the
    display currency). Callers should treat ``None`` as "skip this row
    from the display-currency bucket" — the EUR bucket is still
    populated separately so the page is never blank.
    """
    target = display_currency.upper()
    native_ccy = (t.account.native_currency if t.account else "EUR").upper()
    # Same-currency short-circuit: never round-trip through EUR.
    if native_ccy == target and t.net_native is not None:
        return t.net_native
    # Prefer the frozen legs persisted at write time (v2.9) over re-deriving.
    if target == "EUR":
        return t.net_eur if t.net_eur is not None else _amount_eur(t, eur_to_usd=eur_to_usd)
    if target == "USD":
        if t.net_usd is not None:
            return t.net_usd
        eur_amt = _amount_eur(t, eur_to_usd=eur_to_usd)
        rate = lookup_rate_with_forward_fill(eur_to_usd, t.date)
        if rate is None or rate == 0:
            return None
        return eur_amt * rate
    return None


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


def _month_label_range(first_label: str, last_label: str) -> list[str]:
    """All ``YYYY-MM`` labels from January of ``first_label``'s year up to
    ``last_label`` inclusive.

    Used to pad the monthly table so each calendar year is a complete,
    twelve-row block (the user invested from March 2023, so Jan/Feb 2023
    need empty rows for the per-year pagination to line up).
    """
    first_year = int(first_label.split("-", 1)[0])
    last_year, last_month = (int(p) for p in last_label.split("-"))
    labels: list[str] = []
    year, month = first_year, 1
    while (year, month) <= (last_year, last_month):
        labels.append(f"{year:04d}-{month:02d}")
        month += 1
        if month > 12:
            month = 1
            year += 1
    return labels


def aggregate(  # noqa: PLR0912, PLR0915
    session: Session,
    *,
    monthly: bool,
    with_closing_value: bool = True,
    today: date | None = None,
    display_currency: str | None = None,
    fill_gaps: bool = False,
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

    When ``fill_gaps`` is true (monthly only) every calendar month from
    January of the first active year through the most recent active
    period is emitted, even if it carried no cashflows. This keeps the
    monthly table a contiguous twelve-rows-per-year grid so it can be
    paginated one calendar year at a time.
    """
    txns = session.scalars(select(Transaction).options(joinedload(Transaction.account))).all()

    # Load the EUR→USD series once: it powers both the EUR fallback
    # (when net_eur was never written by the importer because FX was
    # cold at the time) and the display-currency conversion below.
    # Local import to avoid a cycle: services -> repositories -> models,
    # while this module is imported by the UI layer. The service wrapper
    # routes the read to the cache tier so split-DB installs find the FX
    # history (which lives in the separate cache database).
    from investment_dashboard.services import fx_service  # noqa: PLC0415

    eur_to_usd = fx_service.get_rates(session, base="EUR", quote="USD")

    buckets: dict[str, dict[str, Decimal]] = {}
    for t in txns:
        key = _period_key(t.date, monthly=monthly)
        b = buckets.setdefault(key, {"contrib": ZERO, "div": ZERO, "int": ZERO})
        amt = _amount_eur(t, eur_to_usd=eur_to_usd)
        if t.kind == "deposit":
            b["contrib"] += amt
        elif t.kind == "withdrawal":
            b["contrib"] -= amt
        elif t.kind == "dividend_cash":
            b["div"] += amt
        elif t.kind == "interest":
            b["int"] += amt

    # Pad the monthly grid so every calendar month between January of the
    # first active year and the latest active month exists as a (possibly
    # empty) bucket — the user's "add empty Jan/Feb 2023" request, and the
    # prerequisite for one-year-per-page pagination.
    if fill_gaps and monthly and buckets:
        labels_sorted = sorted(buckets)
        for label in _month_label_range(labels_sorted[0], labels_sorted[-1]):
            buckets.setdefault(label, {"contrib": ZERO, "div": ZERO, "int": ZERO})

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
        # We've already loaded the EUR→USD series once above; reuse it.
        fx_rates = eur_to_usd if normalised_display_ccy == "USD" else {}

        # If we have no FX history at all for this quote, skip the
        # display-side conversion entirely — the renderer's spot-rate
        # fallback is more useful than emitting zeros for every row.
        if fx_rates:
            for label in buckets:
                display_buckets[label] = {"contrib": ZERO, "div": ZERO, "int": ZERO}
            for t in txns:
                amt = _amount_in(
                    t,
                    display_currency=normalised_display_ccy,
                    eur_to_usd=eur_to_usd,
                )
                if amt is None:
                    continue
                key = _period_key(t.date, monthly=monthly)
                b = display_buckets[key]
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
                    except (
                        SQLAlchemyError,
                        ArithmeticError,
                        ValueError,
                    ):  # pragma: no cover - defensive
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

    # ------- Cumulative Total Growth (compounded XIRR) per row (v2.5) -------
    # Walk both currency series of cashflows once; at the end of every
    # period emit (1 + xirr_to_date)^years_to_date − 1. This is the
    # canonical headline metric on the Monthly / Yearly tables.
    rows = _attach_cumulative_growth(
        rows,
        txns=list(txns),
        eur_to_usd=eur_to_usd,
        monthly=monthly,
        today=today,
    )
    return rows


def _attach_cumulative_growth(
    rows: list[PeriodRow],
    *,
    txns: list[Transaction],
    eur_to_usd: dict[date, Decimal],
    monthly: bool,
    today: date,
) -> list[PeriodRow]:
    """Populate ``total_growth_compounded_eur/usd`` (+ ``closing_value_usd``)
    on every :class:`PeriodRow` in place-equivalent (returns a new list).

    Cumulative XIRR is recomputed at each period end from the same
    cashflow stream :mod:`metrics_service` uses, terminated with that
    period's closing value (EUR or USD). The corresponding compounded
    Total Growth is ``(1 + xirr) ^ years_invested − 1`` measured from
    the earliest external cashflow up to the period end.
    """
    if not rows:
        return rows
    # Local import to avoid a cycle (services → repositories → models).
    from investment_dashboard.services import metrics_service  # noqa: PLC0415

    def _usd(t: Transaction) -> Decimal:
        return metrics_service._txn_usd_amount(t, eur_to_usd=eur_to_usd)

    flows_eur = metrics_service.build_portfolio_cashflows(txns)
    flows_usd = metrics_service.build_portfolio_cashflows(txns, amount_fn=_usd)

    # First external cashflow date — origin of "years invested".
    first_cf: date | None = None
    for t in sorted(txns, key=lambda r: r.date):
        if t.kind in {"deposit", "withdrawal"}:
            first_cf = t.date
            break

    out: list[PeriodRow] = []
    for r in rows:
        period_end = _period_end(r.label, monthly=monthly, today=today)
        closing_eur = r.closing_value_eur
        # USD closing: prefer the display row when display_currency is
        # already USD; otherwise convert EUR with the period-end FX.
        if r.display_currency == "USD" and r.closing_value_display is not None:
            closing_usd: Decimal | None = r.closing_value_display
        else:
            fx_eod = lookup_rate_with_forward_fill(eur_to_usd, period_end)
            closing_usd = closing_eur * fx_eod if fx_eod is not None and fx_eod != 0 else None

        flows_eur_to_date = [cf for cf in flows_eur if cf.date <= period_end]
        flows_usd_to_date = [cf for cf in flows_usd if cf.date <= period_end]

        years = years_between(first_cf, period_end) if first_cf else Decimal(0)

        xirr_eur = (
            xirr(flows_eur_to_date, as_of=period_end, terminal_value=closing_eur)
            if flows_eur_to_date
            else None
        )
        growth_eur = total_growth_pct_compounded(xirr_eur, years)
        if closing_usd is not None and flows_usd_to_date:
            xirr_usd = xirr(flows_usd_to_date, as_of=period_end, terminal_value=closing_usd)
            growth_usd = total_growth_pct_compounded(xirr_usd, years)
        else:
            growth_usd = None

        out.append(
            PeriodRow(
                label=r.label,
                contributions=r.contributions,
                dividends=r.dividends,
                interest=r.interest,
                net_flow=r.net_flow,
                closing_value_eur=r.closing_value_eur,
                opening_value_eur=r.opening_value_eur,
                growth_pct=r.growth_pct,
                contributions_display=r.contributions_display,
                dividends_display=r.dividends_display,
                interest_display=r.interest_display,
                net_flow_display=r.net_flow_display,
                closing_value_display=r.closing_value_display,
                opening_value_display=r.opening_value_display,
                growth_pct_display=r.growth_pct_display,
                display_currency=r.display_currency,
                total_growth_compounded_eur=growth_eur,
                total_growth_compounded_usd=growth_usd,
                closing_value_usd=closing_usd,
            )
        )
    return out


def to_table_rows(
    rows: list[PeriodRow],
    *,
    currency: str = "EUR",
    fx_rate: Decimal | None = None,
) -> list[dict[str, str | float | None]]:
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

    def _f(value: Decimal | None) -> float | None:
        """Raw float for a sortable AG-Grid numeric column (``None`` stays empty)."""
        return float(value) if value is not None else None

    def _usd_money(eur_value: Decimal, display_value: Decimal | None) -> Decimal:
        """USD value of a cashflow bucket.

        Prefer the per-trade-date display leg when the page already
        aggregated in USD; otherwise fall back to scaling the EUR series
        by today's spot ``fx_rate`` so the (currently hidden) USD column
        is still a sensible number.
        """
        if currency.upper() == "USD" and display_value is not None:
            return display_value
        return _convert_to_usd(eur_value, fx_rate)

    def _closing_usd(r: PeriodRow) -> Decimal:
        """Closing value in USD, preferring per-period-end FX."""
        if r.closing_value_usd is not None:
            return r.closing_value_usd
        if currency.upper() == "USD" and r.closing_value_display is not None:
            return r.closing_value_display
        return _convert_to_usd(r.closing_value_eur, fx_rate)

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
            # v2.5 cumulative Total Growth per currency — the headline
            # column on monthly / yearly tables.
            "total_growth_eur": (
                f"{r.total_growth_compounded_eur * Decimal(100):,.2f} %"
                if r.total_growth_compounded_eur is not None
                else "—"
            ),
            "total_growth_usd": (
                f"{r.total_growth_compounded_usd * Decimal(100):,.2f} %"
                if r.total_growth_compounded_usd is not None
                else "—"
            ),
            # v2.9.1 numeric companions: the monthly / yearly tables render
            # one currency at a time (the header toggle) by binding columns to
            # ``{field}_{ccy}_num`` (money) and ``{field}_{ccy}_signed`` (ratios)
            # so each column sorts by value and the percentage cells can be
            # sign-coloured. Money is carried in both currencies; period growth
            # (Modified Dietz) carries EUR always plus the display currency, and
            # Total Growth carries both per-currency series.
            "contributions_eur_num": _f(r.contributions),
            "contributions_usd_num": _f(_usd_money(r.contributions, r.contributions_display)),
            "dividends_eur_num": _f(r.dividends),
            "dividends_usd_num": _f(_usd_money(r.dividends, r.dividends_display)),
            "interest_eur_num": _f(r.interest),
            "interest_usd_num": _f(_usd_money(r.interest, r.interest_display)),
            "net_flow_eur_num": _f(r.net_flow),
            "net_flow_usd_num": _f(_usd_money(r.net_flow, r.net_flow_display)),
            "closing_value_eur_num": _f(r.closing_value_eur),
            "closing_value_usd_num": _f(_closing_usd(r)),
            "growth_pct_eur_signed": _f(r.growth_pct),
            "growth_pct_usd_signed": _f(
                r.growth_pct_display if currency.upper() == "USD" else None
            ),
            "total_growth_eur_signed": _f(r.total_growth_compounded_eur),
            "total_growth_usd_signed": _f(r.total_growth_compounded_usd),
        }
        for r in rows
    ]
