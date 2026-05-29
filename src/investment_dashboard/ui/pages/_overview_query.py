"""Query helpers for ``/overview`` — KPI quartet + position rows + treemap data."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.domain.returns import Cashflow, xirr
from investment_dashboard.models import TransactionKind
from investment_dashboard.repositories import transactions_repo
from investment_dashboard.services.metrics_service import (
    PortfolioMetrics,
    compute_portfolio_metrics,
)
from investment_dashboard.services.positions_service import (
    Position,
    compute_positions,
)

ZERO = Decimal(0)


@dataclass(frozen=True)
class TreemapDatum:
    """One slice of the allocation treemap."""

    label: str
    value_eur: Decimal


@dataclass(frozen=True)
class InstrumentMetrics:
    """Per-instrument return figures mirroring the spreadsheet's ``Lots`` block.

    All ratios are fractions (``0.12`` = +12 %). ``xirr`` is the
    money-weighted annualised return computed from the instrument's own
    EUR cashflow stream plus its terminal mark; the remaining figures are
    dividend-inclusive simple-growth measures in the instrument's native
    currency. Any field that can't be computed (no cost basis, no
    start-of-year mark) is ``None`` so the renderer shows an em dash.
    """

    instrument_id: int
    xirr: Decimal | None
    total_growth_pct: Decimal | None
    ytd_growth_pct: Decimal | None
    capital_gain_native: Decimal
    expense_ratio: Decimal | None


def get_metrics(session: Session, *, as_of: date | None = None) -> PortfolioMetrics:
    return compute_portfolio_metrics(session, as_of=as_of)


def get_positions(session: Session, *, as_of: date | None = None) -> list[Position]:
    return compute_positions(session, as_of=as_of)


def compute_instrument_metrics(
    session: Session,
    positions: list[Position],
    *,
    as_of: date | None = None,
) -> dict[int, InstrumentMetrics]:
    """Per-instrument XIRR + dividend-inclusive growth, keyed by instrument id.

    Reuses the same domain math as the portfolio-level KPIs but scopes each
    cashflow stream to a single instrument. ``positions`` supplies the
    terminal marks and cost bases so the caller controls the ``as_of`` /
    currency conventions consistently with the rest of the page.
    """
    as_of = as_of or date.today()
    txns = list(transactions_repo.list_transactions(session, end=as_of))

    # EUR cashflows for XIRR + YTD net purchases (native), grouped by instrument.
    year_start = date(as_of.year, 1, 1)
    eur_flows: dict[int, list[Cashflow]] = {}
    ytd_net_invested_native: dict[int, Decimal] = {}
    for t in txns:
        if t.instrument_id is None:
            continue
        if t.kind in {
            TransactionKind.BUY.value,
            TransactionKind.SELL.value,
            TransactionKind.DIVIDEND_CASH.value,
        }:
            net_eur = t.net_eur if t.net_eur is not None else (t.net_native or ZERO)
            # Buy legs are already negative (cash out); sells / cash dividends
            # are positive — exactly the XIRR sign convention, so pass through.
            eur_flows.setdefault(t.instrument_id, []).append(Cashflow(date=t.date, amount=net_eur))
        if t.date >= year_start and t.kind in {
            TransactionKind.BUY.value,
            TransactionKind.SELL.value,
        }:
            net_native = t.net_native or ZERO
            ytd_net_invested_native[t.instrument_id] = (
                ytd_net_invested_native.get(t.instrument_id, ZERO) - net_native
            )

    # Start-of-year native value per instrument (best-effort, for YTD growth).
    start_value_native: dict[int, Decimal] = {
        p.instrument.id: p.current_value_native
        for p in compute_positions(session, as_of=year_start)
    }

    out: dict[int, InstrumentMetrics] = {}
    for p in positions:
        iid = p.instrument.id
        cost = p.cost_basis_native
        div = p.cumulative_dividends_cash_native
        gain = p.current_value_native + div - cost
        growth = (gain / cost) if cost != ZERO else None
        instr_xirr = xirr(
            eur_flows.get(iid, []),
            as_of=as_of,
            terminal_value=p.current_value_eur,
        )
        ytd_growth = _instrument_ytd_growth(
            start_value=start_value_native.get(iid, ZERO),
            current_value=p.current_value_native,
            net_invested=ytd_net_invested_native.get(iid, ZERO),
        )
        ter = p.effective.expense_ratio if p.effective is not None else p.instrument.expense_ratio
        out[iid] = InstrumentMetrics(
            instrument_id=iid,
            xirr=instr_xirr,
            total_growth_pct=growth,
            ytd_growth_pct=ytd_growth,
            capital_gain_native=gain,
            expense_ratio=ter,
        )
    return out


def _instrument_ytd_growth(
    *,
    start_value: Decimal,
    current_value: Decimal,
    net_invested: Decimal,
) -> Decimal | None:
    """Simple YTD growth net of this year's purchases, in native currency.

    ``(V_now - V_jan1 - net_invested_ytd) / V_jan1``. ``None`` when there
    was no start-of-year mark to grow from.
    """
    if start_value <= ZERO:
        return None
    return (current_value - start_value - net_invested) / start_value


@dataclass(frozen=True)
class MarketVerdict:
    """ "Did I beat the market?" comparison for the overview KPI strip.

    Mirrors the spreadsheet's ``Total!Z23`` verdict. ``portfolio_return``
    and ``benchmark_return`` are total (not annualised) growth fractions
    over the same window — the portfolio's since-inception total growth vs
    a buy-and-hold of the benchmark index. ``beating`` is ``None`` when
    either side can't be computed (no benchmark history / no transactions).
    """

    benchmark_symbol: str
    portfolio_return: Decimal | None
    benchmark_return: Decimal | None
    beating: bool | None


def compute_market_verdict(
    session: Session,
    *,
    portfolio_return: Decimal | None,
    as_of: date | None = None,
) -> MarketVerdict:
    """Compare ``portfolio_return`` to a buy-and-hold of the benchmark index.

    The benchmark window starts at the earliest transaction date so the two
    returns cover the same horizon. Forward-fills nothing — it simply uses
    the first and last available benchmark closes inside the window.
    """
    # Local import keeps the (heavier) benchmark/adapters import lazy and
    # avoids any chance of an import cycle at module load.
    from investment_dashboard.services import benchmark_service  # noqa: PLC0415

    as_of = as_of or date.today()
    txns = list(transactions_repo.list_transactions(session, end=as_of))
    symbol = benchmark_service.get_symbol(session)
    if not txns:
        return MarketVerdict(symbol, portfolio_return, None, None)

    start = min(t.date for t in txns)
    series = benchmark_service.get_series(session, start=start, end=as_of)
    benchmark_return: Decimal | None = None
    if len(series.closes) >= 2:
        ordered = sorted(series.closes)
        first_close = series.closes[ordered[0]]
        last_close = series.closes[ordered[-1]]
        if first_close != ZERO:
            benchmark_return = (last_close - first_close) / first_close

    beating: bool | None = None
    if portfolio_return is not None and benchmark_return is not None:
        beating = portfolio_return >= benchmark_return
    return MarketVerdict(symbol, portfolio_return, benchmark_return, beating)


def position_rows(
    positions: list[Position],
    *,
    display_currency: str = "EUR",
    fx_rate: Decimal | None = None,
    metrics: dict[int, InstrumentMetrics] | None = None,
) -> list[dict[str, Any]]:
    """Shape positions for the AG-Grid table on the overview page.

    ``display_currency`` selects the secondary "Value" column the page
    highlights. The native and EUR columns are always present; a USD
    column is added so a single render carries both currencies (spec §1
    "simultaneous USD and EUR views"). ``fx_rate`` is EUR→USD; pass
    ``None`` to leave the USD column blank.

    When ``metrics`` (from :func:`compute_instrument_metrics`) is supplied,
    each row is enriched with the per-instrument expense ratio, XIRR,
    dividend-inclusive total growth, YTD growth, and capital gain — the
    spreadsheet's ``Total``/``Lots`` per-holding return block. The
    ``*_signed`` companions carry the raw float so AG-Grid can colour the
    cell by sign.
    """
    rows: list[dict[str, Any]] = []
    metrics = metrics or {}
    for p in positions:
        if p.current_value_eur is not None and fx_rate is not None and fx_rate != 0:
            value_usd = p.current_value_eur * fx_rate
            value_usd_str = f"{value_usd:,.2f}"
        elif p.account.native_currency == "USD":
            value_usd_str = f"{p.current_value_native:,.2f}"
        else:
            value_usd_str = ""
        eff = p.effective
        im = metrics.get(p.instrument.id)
        growth = im.total_growth_pct if im is not None else _growth_fraction(p)
        rows.append(
            {
                "symbol": p.instrument.symbol,
                "name": (eff.name if eff is not None else p.instrument.name) or "",
                "category": p.category or "",
                "shares": f"{p.shares:,.4f}",
                "avg_price": (f"{(p.cost_basis_native / p.shares):,.4f}" if p.shares else ""),
                "current_price": (
                    f"{p.current_price_native:,.4f}" if p.current_price_native is not None else ""
                ),
                "expense_ratio": _fmt_pct(im.expense_ratio if im is not None else None),
                "cost_basis_native": f"{p.cost_basis_native:,.2f}",
                "current_value_native": f"{p.current_value_native:,.2f}",
                "current_value_usd": value_usd_str,
                "current_value_eur": f"{p.current_value_eur:,.2f}",
                "capital_gain_native": (f"{im.capital_gain_native:,.2f}" if im is not None else ""),
                "total_growth_pct": _fmt_pct(growth),
                "total_growth_signed": _signed(growth),
                "xirr": _fmt_pct(im.xirr if im is not None else None),
                "xirr_signed": _signed(im.xirr if im is not None else None),
                "ytd_growth_pct": _fmt_pct(im.ytd_growth_pct if im is not None else None),
                "ytd_growth_signed": _signed(im.ytd_growth_pct if im is not None else None),
                "display_currency": display_currency,
            }
        )
    return rows


def _growth_fraction(p: Position) -> Decimal | None:
    """Price-only growth fraction — fallback when no enriched metrics exist."""
    if p.cost_basis_native == ZERO:
        return None
    return (p.current_value_native - p.cost_basis_native) / p.cost_basis_native


def _fmt_pct(value: Decimal | None) -> str:
    if value is None:
        return "—"
    return f"{value * Decimal(100):,.2f} %"


def _signed(value: Decimal | None) -> float:
    """Raw float for AG-Grid ``cellClassRules`` sign colouring (0 when None)."""
    return float(value) if value is not None else 0.0


def allocation_treemap(positions: list[Position]) -> list[TreemapDatum]:
    """Aggregate positions by user-tier ``category`` (fallback effective ``asset_class``)."""
    bucket: dict[str, Decimal] = {}
    for p in positions:
        eff = p.effective
        fallback_class = eff.asset_class if eff is not None else p.instrument.asset_class
        key = p.category or fallback_class or "Uncategorized"
        bucket[key] = bucket.get(key, ZERO) + p.current_value_eur
    items = [TreemapDatum(label=k, value_eur=v) for k, v in bucket.items() if v > ZERO]
    items.sort(key=lambda d: d.value_eur, reverse=True)
    return items
