"""Overview page (spec §8.1) — KPIs, per-holding cards, allocation treemap."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, date, datetime, tzinfo
from decimal import ROUND_HALF_UP, Decimal
from html import escape

from nicegui import ui

from investment_dashboard.db import session_scope
from investment_dashboard.domain.market_hours import is_us_market_open
from investment_dashboard.domain.returns import years_between
from investment_dashboard.services import (
    display_currency_service,
    intraday_snapshots_service,
    prices_service,
    refresh_status,
    timezone_service,
)
from investment_dashboard.services.daily_growth_view import (
    build_daily_growth_caption,
    fx_move_pct,
)
from investment_dashboard.ui import refresh_indicator
from investment_dashboard.ui.components import (
    deferred,
    empty_state,
    kpi_card,
    section,
)
from investment_dashboard.ui.components.kpi_card import dual_kpi_card, dual_pct_kpi_card
from investment_dashboard.ui.layout import page_frame
from investment_dashboard.ui.money_format import (
    currency_symbol,
    fmt_money,
    fmt_pct,
    fmt_shares,
)
from investment_dashboard.ui.pages._overview_query import (
    MULTI_CCY_RANGES,
    VALUE_RANGES,
    HoldingCard,
    MarketVerdict,
    MoverEntry,
    MoversView,
    PortfolioMetrics,
    TreemapDatum,
    ValueSeriesPoint,
    allocation_treemap,
    build_holding_cards,
    build_intraday_value_series,
    build_movers,
    build_value_series,
    build_week_value_series,
    compute_instrument_metrics,
    compute_market_verdict,
    effective_overview_range,
    get_metrics,
    get_positions,
    holding_freshness,
    previous_session_close_value,
    remember_overview_range,
    resolve_range_days,
)
from investment_dashboard.ui.theme import (
    GAIN_COLOR,
    LOSS_COLOR,
    PLOTLY_QUALITATIVE,
    arrow_for_signed,
    color_for_signed,
)

log = logging.getLogger(__name__)

PATH = "/overview"
#: Sibling Holdings page route (defined on :mod:`...ui.pages.holdings`); kept as
#: a literal here to avoid a circular import between the two page modules.
HOLDINGS_PATH = "/holdings"


@dataclass(frozen=True)
class _OverviewData:
    """Everything the overview body needs, gathered off the event loop.

    Produced by the page's ``compute`` step (which does all the heavy DB and
    metrics work on a worker thread) and handed to the render step on the loop,
    so a slow build never blocks the websocket — see
    :func:`investment_dashboard.ui.components.deferred.deferred`.
    """

    range_label: str
    metrics: PortfolioMetrics
    display_ccy: str
    display_tz: tzinfo | None
    value_series: list[ValueSeriesPoint]
    fx_rate: Decimal | None
    display_quote: str
    verdict: MarketVerdict
    cards: list[HoldingCard]
    treemap_data: list[TreemapDatum]
    price_observed_at: datetime | None = None
    price_market_at: datetime | None = None
    #: Previous-session settled value (display currency) — the "1 Day" chart's
    #: reference line. ``None`` outside the Day range or when not computable.
    intraday_prev_close: Decimal | None = None
    #: Companion value series in the *other* currency (USD when the display is
    #: EUR, and vice versa), plotted as a right-axis comparison line on every
    #: range a week or longer. ``None``/empty on the Day range or when the other
    #: currency could not be built.
    value_series_secondary: list[ValueSeriesPoint] | None = None
    #: ISO code of that companion line (e.g. ``"USD"``), for axis + legend labels.
    secondary_ccy: str | None = None


def _pct_card(
    label: str,
    eur_pct: Decimal | None,
    usd_pct: Decimal | None,
    *,
    display_ccy: str,
    tooltip_key: str | None = None,
    sub: str | None = None,
) -> None:
    """Render a return KPI with the display currency large and the other small.

    Picks which of (EUR, USD) is primary from ``display_ccy`` and colours /
    arrows the primary figure by its sign, so e.g. when USD is selected the
    EUR percentage is shown as the smaller secondary line.
    """
    primary = display_ccy.upper()
    if primary == "EUR":
        primary_pct, primary_ccy, secondary_pct, secondary_ccy = eur_pct, "EUR", usd_pct, "USD"
    else:
        primary_pct, primary_ccy, secondary_pct, secondary_ccy = usd_pct, "USD", eur_pct, "EUR"
    dual_pct_kpi_card(
        label,
        fmt_pct(primary_pct),
        fmt_pct(secondary_pct),
        primary_ccy=primary_ccy,
        secondary_ccy=secondary_ccy,
        tooltip_key=tooltip_key,
        color=color_for_signed(float(primary_pct or 0)),
        arrow=arrow_for_signed(float(primary_pct or 0)),
        sub=sub,
    )


def _verdict_card(verdict: MarketVerdict) -> None:
    """KPI card form of the spreadsheet's "Beating / Losing the market" cell."""
    if verdict.beating is None:
        kpi_card(
            "Vs Market",
            "—",
            sub=f"Need {verdict.benchmark_symbol} history to compare",
            tooltip_key="market_verdict",
        )
        return
    headline = "Beating the market" if verdict.beating else "Trailing the market"
    color = GAIN_COLOR if verdict.beating else LOSS_COLOR
    arrow = arrow_for_signed(1.0 if verdict.beating else -1.0)
    kpi_card(
        "Vs Market",
        headline,
        sub=(
            f"You {fmt_pct(verdict.portfolio_return)} · "
            f"{verdict.benchmark_symbol} {fmt_pct(verdict.benchmark_return)}"
        ),
        tooltip_key="market_verdict",
        color=color,
        arrow=arrow,
    )


def _by_ccy(eur: Decimal | None, usd: Decimal | None, ccy: str) -> Decimal | None:
    """Pick the EUR or USD figure for the active display currency."""
    return eur if ccy.upper() == "EUR" else usd


def _fmt_signed_money(amount: Decimal | None, ccy: str) -> str | None:
    """A money figure with an explicit ``+``/``−`` sign (e.g. ``+€123.45``).

    Used where the figure reads as a *change* (today's value difference, a
    holding's daily move) so a gain shows its plus sign rather than looking like
    a plain balance. Returns ``None`` when there's nothing to show, so callers
    can omit the line entirely.
    """
    if amount is None:
        return None
    sign = "+" if amount >= 0 else "\u2212"  # proper minus sign
    return f"{sign}{fmt_money(abs(amount), ccy)}"


def _hero_total_value(
    eur: Decimal | None,
    usd: Decimal | None,
    *,
    display_ccy: str,
    daily_pct: Decimal | None,
) -> None:  # pragma: no cover - UI
    """Render the header's big Total Value hero box.

    Leads the page with the headline money figure (neobroker style): the display
    currency large, the other currency just under it, and a small coloured
    "today" badge with the latest single-day move so the number reads as *live*
    rather than static.
    """
    primary = display_ccy.upper()
    if primary == "EUR":
        first_v, first_c = fmt_money(eur, "EUR"), "EUR"
        second_v, second_c = fmt_money(usd, "USD"), "USD"
    else:
        first_v, first_c = fmt_money(usd, "USD"), "USD"
        second_v, second_c = fmt_money(eur, "EUR"), "EUR"
    ui.html('<div class="inv-hero-label">Total Value</div>')
    ui.html(
        f'<div class="inv-hero-value"><span class="inv-kpi-dual-ccy">{first_c}</span> '
        f"{first_v}</div>"
    )
    ui.html(
        f'<div class="inv-hero-secondary"><span class="inv-kpi-dual-ccy">{second_c}</span> '
        f"{second_v}</div>"
    )
    if daily_pct is not None:
        color = color_for_signed(float(daily_pct))
        arrow = arrow_for_signed(float(daily_pct))
        ui.html(
            f'<div class="inv-hero-change" style="color:{color}">{arrow} '
            f'{fmt_pct(daily_pct)} <span style="opacity:0.7;font-weight:600">today</span></div>'
        )


def _render_kpi_grid(
    metrics: PortfolioMetrics,
    verdict: object,
    *,
    display_ccy: str,
    today_sub: str,
) -> None:  # pragma: no cover - UI
    """Render the 4×2 KPI grid beneath the hero.

    Row 1 — the money story: how much went in, what it made, the annualised
    return, and how that stacks up to the market. Row 2 — the growth story:
    cumulative, then the YTD → MTD → Today period ladder, read as one group.
    """
    with ui.element("div").classes("inv-kpi-grid inv-kpi-grid--hero w-full"):
        dual_kpi_card(
            "Total Invested",
            fmt_money(metrics.total_contributions_eur, "EUR"),
            fmt_money(metrics.total_contributions_usd, "USD"),
            primary=display_ccy,
            tooltip_key="total_invested",
        )
        dual_kpi_card(
            "Capital Gain",
            fmt_money(metrics.capital_gain_eur, "EUR"),
            fmt_money(metrics.capital_gain_usd, "USD"),
            primary=display_ccy,
            tooltip_key="total_gain",
        )
        _pct_card(
            "XIRR",
            metrics.xirr,
            metrics.xirr_usd,
            display_ccy=display_ccy,
            tooltip_key="xirr",
        )
        _verdict_card(verdict)
        _pct_card(
            "Total Growth",
            metrics.total_growth_compounded_eur,
            metrics.total_growth_compounded_usd,
            display_ccy=display_ccy,
            tooltip_key="total_growth_compounded",
        )
        _pct_card(
            "YTD Growth",
            metrics.ytd_growth_pct,
            metrics.ytd_growth_pct_usd,
            display_ccy=display_ccy,
            tooltip_key="ytd_growth",
        )
        _pct_card(
            "MTD Growth",
            metrics.mtd_growth_pct,
            metrics.mtd_growth_pct_usd,
            display_ccy=display_ccy,
            tooltip_key="mtd_growth",
        )
        _pct_card(
            "Today",
            metrics.daily_growth_pct,
            metrics.daily_growth_pct_usd,
            display_ccy=display_ccy,
            tooltip_key="daily_growth",
            sub=today_sub,
        )


def format_price_freshness(card: HoldingCard, *, tz: tzinfo | None = None) -> str:
    """One-line "as of / updated" freshness string for a holding card.

    Mirrors the web companion's per-row transparency:

    * money-market funds price at a fixed $1.00 par with no feed → say so;
    * a priced holding from today reads "LIVE" while the US market is open and
      "TODAY" once it has closed (the same rule as the Daily Growth caption),
      each followed by the saved last-refresh time ("updated …") when known;
    * an older priced holding shows the close's observation date ("as of …") and,
      when known, the saved last-refresh time ("updated …");
    * a held holding with no cached price at all reads "no price".

    ``tz`` renders the saved last-refresh time in the user's configured
    timezone; the stored ``updated_at`` is a naive UTC instant, so it is
    treated as UTC and converted. When ``tz`` is ``None`` the raw stored
    instant is shown unchanged.
    """
    if card.is_money_market:
        return "par $1.00 · fixed"
    if card.price_as_of is None:
        return "no price"
    if card.price_as_of == date.today():
        # A today-dated price reads LIVE while the market is open, TODAY once it
        # has closed — and (re)appends the saved last-refresh time so the user
        # still sees *when* it last updated, exactly like the older-price line.
        state = "LIVE" if card.market_open else "TODAY"
        if card.updated_at is not None:
            return f"{state} · updated {_fmt_updated(card.updated_at, tz=tz)}"
        return state
    parts = [f"as of {_fmt_asof_date(card.price_as_of)}"]
    if card.updated_at is not None:
        parts.append(f"updated {_fmt_updated(card.updated_at, tz=tz)}")
    return " · ".join(parts)


def _fmt_asof_date(value: date) -> str:
    return value.strftime("%d %b %Y")


def _fmt_updated(value: datetime, *, tz: tzinfo | None = None) -> str:
    if tz is not None:
        # Stored as a naive UTC instant — attach UTC, then convert to the
        # user's display timezone so the clock matches the header.
        aware = value if value.tzinfo is not None else value.replace(tzinfo=UTC)
        value = aware.astimezone(tz)
    return value.strftime("%d %b %H:%M")


def _holding_card(
    card: HoldingCard, *, display_ccy: str, tz: tzinfo | None = None, badge: str | None = None
) -> None:  # pragma: no cover - UI
    """Render one redesigned holding box (web-style headline + detail grid).

    The top mirrors the web app — symbol, name, value and today's (daily) move —
    while the detail grid below leans into the desktop's space with the full
    per-holding statistics (total growth, P/L, XIRR, YTD, price, shares, cost
    basis, expense) plus the saved price freshness the user asked to surface.
    """
    ccy = display_ccy.upper()
    value = _by_ccy(card.value_eur, card.value_usd, ccy)
    value_other = _by_ccy(card.value_usd, card.value_eur, ccy)
    other_ccy = "USD" if ccy == "EUR" else "EUR"
    daily = _by_ccy(card.daily_growth_eur, card.daily_growth_usd, ccy)
    growth = _by_ccy(card.total_growth_eur, card.total_growth_usd, ccy)
    gain = _by_ccy(card.capital_gain_eur, card.capital_gain_usd, ccy)
    xirr_v = _by_ccy(card.xirr_eur, card.xirr_usd, ccy)
    ytd = _by_ccy(card.ytd_growth_eur, card.ytd_growth_usd, ccy)
    cost_basis = _by_ccy(card.cost_basis_eur, card.cost_basis_usd, ccy)

    rail = ""
    if growth is not None and growth > 0:
        rail = " inv-holding-gain"
    elif growth is not None and growth < 0:
        rail = " inv-holding-loss"

    with ui.element("div").classes(f"inv-holding-card{rail}"):
        # Top line: symbol (+ status pills) on the left, freshness on the right.
        pills = ""
        if card.is_money_market:
            pills += '<span class="inv-holding-pill">PAR</span>'
        if card.value_warning:
            pills += '<span class="inv-holding-pill inv-holding-pill-warn">stale value</span>'
        if card.price_data_warning:
            pills += '<span class="inv-holding-pill inv-holding-pill-warn">bad history</span>'
        # A movers badge reminds the viewer this holding topped today's leaderboard.
        if badge:
            badge_cls = "inv-holding-badge-loss" if "loser" in badge else "inv-holding-badge-gain"
            pills += f'<span class="inv-holding-badge {badge_cls}">{escape(badge)}</span>'
        ui.html(
            '<div class="inv-holding-topline">'
            f'<span class="inv-holding-sym">{escape(card.symbol)}{pills}</span>'
            f'<span class="inv-holding-asof">{escape(format_price_freshness(card, tz=tz))}</span>'
            "</div>"
        )
        ui.html(
            f'<div class="inv-holding-name" title="{escape(card.name)}">{escape(card.name)}</div>'
        )

        daily_color = color_for_signed(float(daily)) if daily is not None else "var(--inv-muted)"
        daily_txt = (
            f"{arrow_for_signed(float(daily))} {fmt_pct(daily)}" if daily is not None else "—"
        )
        # The same daily move as an absolute money figure in the display
        # currency, shown just under the percentage (to the right) so the card
        # answers "how much did this move today?" not only "by what percent?".
        daily_money = _by_ccy(card.daily_move_eur, card.daily_move_usd, ccy)
        daily_money_txt = _fmt_signed_money(daily_money, ccy)
        # A holding still on an older print than its peers shows last session's
        # move, not today's — grey it (muted colour + softer weight + a hint) so
        # a live glance separates today's numbers from the ones yet to refresh.
        # Before peers diverge nothing is stale, so nothing greys.
        if card.daily_is_stale:
            money_html = (
                f'<span class="inv-holding-change-money inv-holding-change-stale">'
                f"{escape(daily_money_txt)}</span>"
                if daily_money_txt is not None
                else ""
            )
            ui.html(
                '<div class="inv-holding-figures">'
                f'<span class="inv-holding-value">{escape(fmt_money(value, ccy))}</span>'
                '<span class="inv-holding-change-wrap">'
                '<span class="inv-holding-change inv-holding-change-stale" '
                'title="Not updated today — last session&#39;s move">'
                f"{escape(daily_txt)}</span>"
                f"{money_html}"
                "</span>"
                "</div>"
            )
        else:
            money_html = (
                f'<span class="inv-holding-change-money" style="color:{daily_color}">'
                f"{escape(daily_money_txt)}</span>"
                if daily_money_txt is not None
                else ""
            )
            ui.html(
                '<div class="inv-holding-figures">'
                f'<span class="inv-holding-value">{escape(fmt_money(value, ccy))}</span>'
                '<span class="inv-holding-change-wrap">'
                f'<span class="inv-holding-change" style="color:{daily_color}">'
                f"{escape(daily_txt)}</span>"
                f"{money_html}"
                "</span>"
                "</div>"
            )
        if value_other is not None:
            ui.html(
                f'<div class="inv-holding-value-sub">{escape(fmt_money(value_other, other_ccy))}</div>'
            )

        # Detail statistics grid — the "more detailed" desktop-native block.
        with ui.element("div").classes("inv-holding-stats"):
            _stat("Total Growth", fmt_pct(growth), _signed_color(growth))
            _stat(f"P/L ({ccy})", fmt_money(gain, ccy), _signed_color(gain))
            _stat("XIRR", fmt_pct(xirr_v), _signed_color(xirr_v))
            _stat("YTD", fmt_pct(ytd), _signed_color(ytd))
            _stat(
                "Price",
                (
                    f"{currency_symbol(card.native_currency)}{card.current_price_native:,.2f}"
                    if card.current_price_native is not None
                    else "—"
                ),
            )
            _stat("Shares", fmt_shares(card.shares))
            _stat(f"Cost basis ({ccy})", fmt_money(cost_basis, ccy))
            _stat("Expense", fmt_pct(card.expense_ratio) if card.expense_ratio is not None else "—")


def _signed_color(value: Decimal | None) -> str | None:
    """Gain/loss colour for a signed figure, or ``None`` (theme ink) for zero."""
    if value is None or value == 0:
        return None
    return color_for_signed(float(value))


def _stat(label: str, value: str, color: str | None = None) -> None:  # pragma: no cover - UI
    """Render one label/value cell in a holding card's detail grid."""
    style = f' style="color:{color}"' if color else ""
    ui.html(
        '<div class="inv-holding-stat">'
        f'<span class="inv-holding-stat-label">{escape(label)}</span>'
        f'<span class="inv-holding-stat-value"{style}>{escape(value)}</span>'
        "</div>"
    )


def _mover_basis_label(basis_date: date | None, *, today: date | None = None) -> str:
    """A short "today" / "last close · 20 Jun" caption for the movers basis date."""
    if basis_date is None:
        return "—"
    today = today or date.today()
    if basis_date == today:
        return "today"
    return f"last close · {basis_date.strftime('%d %b')}"


def _render_mover_block(
    entry: MoverEntry, side: str, *, display_ccy: str
) -> None:  # pragma: no cover - UI
    """Render one winner/loser block: the stat it ranked on shown large on top."""
    ccy = display_ccy.upper()
    pct = _by_ccy(entry.pct_eur, entry.pct_usd, ccy)
    money = _by_ccy(entry.move_eur, entry.move_usd, ccy)
    color = color_for_signed(float(money)) if money is not None else "var(--inv-muted)"
    pct_txt = f"{arrow_for_signed(float(pct))} {fmt_pct(pct)}" if pct is not None else "—"
    money_txt = fmt_money(money, ccy)
    tag = "biggest move" if entry.reason == "total" else "top %"
    side_label = "Winner" if side == "winner" else "Loser"
    # The figure it earned its slot on leads (large, on top); the other trails.
    primary, secondary = (money_txt, pct_txt) if entry.reason == "total" else (pct_txt, money_txt)
    ui.html(
        f'<div class="inv-mover-block inv-mover-{escape(side)}">'
        '<div class="inv-mover-head">'
        f'<span class="inv-mover-side">{escape(side_label)}</span>'
        f'<span class="inv-mover-tag">{escape(tag)}</span>'
        "</div>"
        '<div class="inv-mover-id">'
        f'<span class="inv-mover-sym" title="{escape(entry.name)}">{escape(entry.symbol)}</span>'
        f'<span class="inv-mover-name">{escape(entry.name)}</span>'
        "</div>"
        '<div class="inv-mover-figures">'
        f'<span class="inv-mover-primary" style="color:{color}">{escape(primary)}</span>'
        f'<span class="inv-mover-secondary">{escape(secondary)}</span>'
        "</div>"
        "</div>"
    )


def _render_movers(movers: MoversView, *, display_ccy: str) -> None:  # pragma: no cover - UI
    """Render the "Today's movers" section — a distinct winners/losers notice band.

    Laid out as up to four blocks across (two winners, two losers), each leading
    with the stat it was ranked on. Measured on the freshest price date across
    the book, so before the open it reflects last session and during the session
    only what has printed today.
    """
    with section("Today's movers", classes="inv-movers-band"):
        ui.html(f'<div class="inv-mover-sub">{escape(_mover_basis_label(movers.basis_date))}</div>')
        with ui.element("div").classes("inv-mover-grid"):
            for entry in movers.winners:
                _render_mover_block(entry, "winner", display_ccy=display_ccy)
            for entry in movers.losers:
                _render_mover_block(entry, "loser", display_ccy=display_ccy)


def _mover_badges(movers: MoversView) -> dict[str, str]:
    """Map each leaderboard holding's symbol to a short badge label.

    Lets the holdings list remind the viewer why a row stood out today, using the
    same currency-aware leaderboard the band shows.
    """
    badges: dict[str, str] = {}
    for entry in movers.winners:
        badges[entry.symbol] = "Top gainer" if entry.reason == "total" else "Top % gainer"
    for entry in movers.losers:
        badges[entry.symbol] = "Top loser" if entry.reason == "total" else "Top % loser"
    return badges


def _zero_value_warning(symbols: list[str]) -> None:  # pragma: no cover - UI
    """Banner warning that held positions value to zero (no price sourced).

    A held holding worth zero understates every downstream figure (total
    value, growth, allocation), so the numbers can't be trusted until the
    ticker prices again — repoint it from Settings → Instruments if the
    symbol is wrong. No-op when ``symbols`` is empty.
    """
    if not symbols:
        return
    listed = ", ".join(symbols)
    with (
        ui.element("div")
        .classes("w-full rounded-borders q-pa-sm q-my-sm")
        .style("background-color: rgba(244,67,54,0.12); border: 1px solid rgba(244,67,54,0.5)"),
        ui.row().classes("items-center gap-sm no-wrap"),
    ):
        ui.icon("warning", color="negative")
        ui.label(
            f"Held but valued at zero — no price found for {listed}. "
            "Totals, growth and allocation are understated until this is "
            "priced. Check the ticker in Settings → Instruments."
        ).classes("text-body2")


def _price_data_warning(symbols: list[str]) -> None:  # pragma: no cover - UI
    """Banner warning that an instrument's price *history* is corrupt.

    A non-positive (zero/negative) close in the cached history is never a real
    price — it forward-fills into every historical valuation that lands on it
    and silently understates past balances and growth. We name the affected
    symbols so the user can re-fetch or repoint them before trusting the
    historic numbers. No-op when ``symbols`` is empty.
    """
    if not symbols:
        return
    listed = ", ".join(symbols)
    with (
        ui.element("div")
        .classes("w-full rounded-borders q-pa-sm q-my-sm")
        .style("background-color: rgba(244,67,54,0.12); border: 1px solid rgba(244,67,54,0.5)"),
        ui.row().classes("items-center gap-sm no-wrap"),
    ):
        ui.icon("error", color="negative")
        ui.label(
            f"Inaccurate price history — a zero (or negative) close was cached for "
            f"{listed}. Historical values and growth for these holdings are "
            "understated and can't be trusted until the feed is repaired. "
            "Re-fetch prices, or check the ticker in Settings → Instruments."
        ).classes("text-body2")


def _treemap_figure(data, *, currency: str, fx_rate: Decimal | None):  # type: ignore[no-untyped-def]
    import plotly.graph_objects as go  # noqa: PLC0415

    if not data:
        return go.Figure().update_layout(
            title=f"Allocation by category ({currency})",
            template="colorblind_modern",
        )

    def _to_display(value_eur: Decimal) -> float:
        raw = (
            value_eur
            if currency == "EUR" or fx_rate is None or fx_rate == 0
            else value_eur * fx_rate
        )
        # Round to the cent so the treemap's value labels read cleanly
        # (the user's "numbers should be rounded to cent" note).
        return float(raw.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))

    fig = go.Figure(
        go.Treemap(
            labels=[d.label for d in data],
            parents=[""] * len(data),
            values=[_to_display(d.value_eur) for d in data],
            textinfo="label+value+percent root",
            marker={"colors": PLOTLY_QUALITATIVE[: len(data)]},
        )
    )
    fig.update_layout(
        title=f"Allocation by category ({currency})",
        template="colorblind_modern",
        margin={"l": 0, "r": 0, "t": 40, "b": 0},
    )
    return fig


def _value_curve_figure(  # type: ignore[no-untyped-def]  # noqa: PLR0915, PLR0912
    points,
    *,
    currency: str,
    intraday: bool = False,
    prev_close=None,
    week: bool = False,
    secondary=None,
    secondary_currency: str | None = None,
):
    """Classic portfolio-value area graph over the selected time range.

    Styled the way mainstream investing apps present value-over-time:
    a soft accent area under a clean line, a money-formatted left axis with
    a currency prefix and visible tick marks, a date axis with adaptive
    tick formatting, a unified hover read-out and a horizontal spike line so
    a value can be read off any date.

    ``intraday`` switches the x-axis + hover to a time-of-day read-out for the
    "1 Day" range, whose points are timestamps within a single session. ``week``
    keeps the multi-day "1 Week" curve's datetime x-axis on a weekday/date grid
    while showing the time of day in the hover (its points are start/midday/close
    instants across several sessions).

    ``secondary`` (with ``secondary_currency``) adds a comparison line for the
    *other* currency on a right-hand axis, scaled so both lines share the same
    starting point: the right axis range is the left range scaled by
    ``secondary[0] / primary[0]``, which pins the two opening values to the same
    pixel **and** the same zero, so any later divergence is purely the difference
    in how the portfolio fared in each currency over the window — read the gap to
    see how much better/worse one currency did than the other.

    ``prev_close`` (intraday only) is the previous session's settled value: when
    given, a neutral dashed reference line marks it and the curve is tinted with
    the colourblind-safe Wong palette — **blue** above the close, **orange**
    below — never red/green. The direction is also encoded redundantly (not by
    colour alone) by the curve's position versus the dashed line and by an
    up/down triangle marker at the latest point, so a profitable day that drifts
    down from the open still reads as a gain over yesterday's close rather than
    looking like a loss.
    """
    import plotly.graph_objects as go  # noqa: PLC0415

    from investment_dashboard.ui.charts import downsample, padded_range  # noqa: PLC0415

    symbol = currency_symbol(currency)
    fig = go.Figure()
    has_secondary = False
    if points:
        points = downsample(points)
        dates = [p.date for p in points]
        values = [float(p.value) for p in points]
        # Adapt the x-axis tick density/format to the span so a one-day range
        # shows the time of day and a multi-year range shows months/years.
        span_days = (dates[-1] - dates[0]).days if len(dates) > 1 else 0
        if intraday:
            tickformat = "%H:%M"
        elif week:
            tickformat = "%a %d"
        elif span_days <= 2:
            tickformat = "%H:%M"
        elif span_days <= 95:
            tickformat = "%d %b"
        elif span_days <= 730:
            tickformat = "%b %Y"
        else:
            tickformat = "%Y"
        if intraday:
            hovertemplate = f"%{{x|%H:%M}}<br><b>{symbol}%{{y:,.2f}}</b><extra></extra>"
        elif week:
            hovertemplate = f"%{{x|%a %d %b %H:%M}}<br><b>{symbol}%{{y:,.2f}}</b><extra></extra>"
        else:
            hovertemplate = f"%{{x|%d %b %Y}}<br><b>{symbol}%{{y:,.2f}}</b><extra></extra>"
        # Tint the intraday curve by its position versus the previous close, so
        # the day's direction *relative to yesterday* is read at a glance. The
        # palette is the colourblind-safe Wong blue (up) / orange (down) — never
        # red/green — and the direction is reinforced below by the dashed
        # reference line and an up/down triangle marker (non-colour cues).
        line_color = GAIN_COLOR
        fill_color = "rgba(0,114,178,0.12)"  # Wong blue #0072B2 @ 12%
        prev_close_f = float(prev_close) if prev_close is not None else None
        up = True
        if intraday and prev_close_f is not None and values:
            up = values[-1] >= prev_close_f
            line_color = GAIN_COLOR if up else LOSS_COLOR
            # Wong orange #E69F00 @ 12% for the loss fill (matches LOSS_COLOR).
            fill_color = "rgba(0,114,178,0.12)" if up else "rgba(230,159,0,0.12)"
        fig.add_trace(
            go.Scatter(
                x=dates,
                y=values,
                mode="lines",
                name=f"In {currency}",
                line={"width": 2.4, "color": line_color},
                fill="tozeroy",
                fillcolor=fill_color,
                hovertemplate=hovertemplate,
            )
        )
        fig.update_xaxes(
            tickformat=tickformat,
            ticks="outside",
            ticklen=5,
            nticks=8,
            showgrid=False,
            automargin=True,
            showspikes=True,
            spikemode="across",
            spikethickness=1,
            spikedash="dot",
            spikecolor="rgba(91,107,124,0.5)",
        )
        # Fit the axis to the data (with headroom) instead of anchoring it to
        # zero, so the real price flow is visible rather than a near-flat line
        # squashed against a huge zero-based scale. The area still fills down
        # to the (off-screen) zero baseline, giving the familiar area look.
        # The previous close is folded into the range so its reference line is
        # always on-screen even when the day stayed entirely above/below it.
        range_values = (
            [*values, prev_close_f] if (intraday and prev_close_f is not None) else values
        )
        yrange = padded_range(range_values)
        fig.update_yaxes(
            tickprefix=symbol,
            tickformat=".3s",
            ticks="outside",
            ticklen=5,
            nticks=6,
            separatethousands=True,
            automargin=True,
            range=list(yrange) if yrange is not None else None,
        )
        # Previous-session close: a neutral dashed reference line + a directional
        # triangle marker at the latest point so "are we up or down on the day?"
        # reads without relying on colour (the line itself is a muted slate, not
        # a gain/loss hue, so it carries no directional meaning of its own).
        if intraday and prev_close_f is not None:
            ref_color = "rgba(91,107,124,0.85)"
            fig.add_hline(
                y=prev_close_f,
                line={"color": ref_color, "width": 1.4, "dash": "dash"},
                annotation_text=f"Prev close {symbol}{prev_close_f:,.2f}",
                annotation_position="top left",
                annotation_font={"size": 11, "color": ref_color},
                opacity=0.9,
            )
            arrow = "▲" if up else "▼"
            fig.add_trace(
                go.Scatter(
                    x=[dates[-1]],
                    y=[values[-1]],
                    mode="markers",
                    marker={
                        "size": 11,
                        "symbol": "triangle-up" if up else "triangle-down",
                        "color": line_color,
                        "line": {"width": 1, "color": "white"},
                    },
                    hovertemplate=(f"now {arrow}<br><b>{symbol}%{{y:,.2f}}</b><extra></extra>"),
                    showlegend=False,
                )
            )
        # Companion line for the *other* currency on a right-hand axis, scaled so
        # both lines share the same starting point (and the same zero): the right
        # range is the left range times secondary[0]/primary[0]. With identical
        # opening pixels, the visible gap between the lines is exactly how much
        # better or worse the portfolio did in one currency versus the other over
        # the window — the whole point of the dual view.
        if secondary and secondary_currency and yrange is not None and values and values[0]:
            sec_points = downsample(secondary)
            if len(sec_points) == len(dates):
                sec_dates = [p.date for p in sec_points]
                sec_values = [float(p.value) for p in sec_points]
                if sec_values and sec_values[0] > 0:
                    scale = sec_values[0] / values[0]
                    sec_symbol = currency_symbol(secondary_currency)
                    sec_color = "#CC79A7"  # Wong reddish-purple (colourblind-safe)
                    fig.add_trace(
                        go.Scatter(
                            x=sec_dates,
                            y=sec_values,
                            mode="lines",
                            name=f"In {secondary_currency}",
                            yaxis="y2",
                            line={"width": 2, "color": sec_color, "dash": "dot"},
                            hovertemplate=(
                                f"<b>{sec_symbol}%{{y:,.2f}}</b> ({secondary_currency})"
                                "<extra></extra>"
                            ),
                        )
                    )
                    fig.update_layout(
                        yaxis2={
                            "overlaying": "y",
                            "side": "right",
                            "tickprefix": sec_symbol,
                            "tickformat": ".3s",
                            "separatethousands": True,
                            "showgrid": False,
                            "automargin": True,
                            "range": [yrange[0] * scale, yrange[1] * scale],
                            "tickfont": {"color": sec_color},
                            "title": {
                                "text": secondary_currency,
                                "font": {"color": sec_color},
                            },
                        }
                    )
                    has_secondary = True
    fig.update_layout(
        title=(
            f"Portfolio value today ({currency})"
            if intraday
            else (
                f"Portfolio value over time — {currency} vs {secondary_currency}"
                if has_secondary
                else f"Portfolio value over time ({currency})"
            )
        ),
        template="colorblind_modern",
        margin={"l": 16, "r": 44 if has_secondary else 16, "t": 40, "b": 36},
        hovermode="x unified",
        showlegend=has_secondary,
        legend=(
            {
                "orientation": "h",
                "yanchor": "bottom",
                "y": 1.02,
                "xanchor": "right",
                "x": 1,
            }
            if has_secondary
            else None
        ),
    )
    return fig


def _on_value_range_change(label: str) -> None:  # pragma: no cover - UI callback
    with session_scope() as session:
        remember_overview_range(session, label)
    ui.navigate.to(f"{PATH}?value_range={label}")


def _value_over_time_section(  # type: ignore[no-untyped-def]
    value_series,
    *,
    range_label,
    display_ccy,
    display_tz=None,
    prev_close=None,
    secondary=None,
    secondary_ccy=None,
):
    """Render the value-over-time line chart + range selector.

    On the "Day" range the chart redraws itself in place whenever a price
    refresh lands, so the intraday curve keeps growing live without a page
    reload. ``prev_close`` is the previous session's settled value used to mark
    the "1 Day" reference line. ``secondary`` / ``secondary_ccy`` add the
    other-currency comparison line (right axis, shared start) on every range a
    week or longer.
    """
    intraday = range_label == "Day"
    week = range_label == "Week"
    with section("Value over time"):
        with ui.row().classes("items-center gap-sm"):
            ui.label("Range:").classes("text-caption opacity-70")
            ui.toggle(
                [name for name, _ in VALUE_RANGES],
                value=range_label,
                on_change=lambda e: _on_value_range_change(str(e.value)),
            ).props("dense unelevated no-caps")
        if not value_series:
            empty_state(
                "show_chart",
                "No value history yet",
                hint="Import transactions or wait for the daily snapshot to populate.",
            )
        else:
            plot = (
                ui.plotly(
                    _value_curve_figure(
                        value_series,
                        currency=display_ccy,
                        intraday=intraday,
                        week=week,
                        prev_close=prev_close,
                        secondary=secondary,
                        secondary_currency=secondary_ccy,
                    )
                )
                .classes("w-full")
                .style("height:360px")
            )
            if intraday:
                _install_intraday_live_update(
                    plot, display_ccy=display_ccy, tz=display_tz, prev_close=prev_close
                )


def _install_intraday_live_update(plot, *, display_ccy, tz, prev_close=None):  # type: ignore[no-untyped-def]  # pragma: no cover - UI timer
    """Redraw the "1 Day" chart in place each time a price refresh lands.

    Polls the shared refresh-activity counter (cheap, in-memory) and only does
    real work when a refresh has *completed* with new data — rebuilding the
    intraday series and swapping the Plotly figure so the curve tracks the live
    price without a disruptive full-page reload.
    """
    state = {"last": refresh_status.snapshot().last_update_at}

    def _poll() -> None:
        snap = refresh_status.snapshot()
        if snap.active or snap.last_update_at == state["last"]:
            return
        state["last"] = snap.last_update_at
        try:
            with session_scope() as session:
                series = build_intraday_value_series(session, currency=display_ccy, tz=tz)
            if series:
                plot.update_figure(
                    _value_curve_figure(
                        series, currency=display_ccy, intraday=True, prev_close=prev_close
                    )
                )
        except Exception:  # pragma: no cover - best-effort live redraw
            log.warning("intraday chart live update failed", exc_info=True)

    ui.timer(refresh_indicator.POLL_INTERVAL_SECONDS, _poll)


def register() -> None:  # noqa: PLR0915
    @ui.page(PATH)
    def _overview(value_range: str | None = None) -> None:  # noqa: PLR0915  # pragma: no cover - rendered by NiceGUI
        with page_frame("Overview", current=PATH):
            # Header: page title on the left, a big Total Value "hero" box on the
            # right. The value isn't known until the deferred compute lands, so
            # the hero slot is created here (next to the title) and filled in
            # ``_render`` once the metrics are in.
            with ui.element("div").classes("inv-overview-header w-full q-mb-md"):
                with ui.element("div").classes("inv-page-header"):
                    ui.html("<h1>Overview</h1>")
                    ui.html('<div class="inv-page-subtitle">Portfolio at a glance</div>')
                hero_slot = ui.element("div").classes("inv-hero-total")

            def _gather() -> _OverviewData:
                with session_scope() as session:
                    # No explicit query param ⇒ fall back to the market-aware
                    # selection: the live "Day" curve while the market is open
                    # (reset to Day each session, but remembering a mid-session
                    # switch), and the user's sticky standard range once closed.
                    effective_range = value_range
                    if effective_range is None:
                        effective_range = effective_overview_range(session)
                    range_label, _ = resolve_range_days(effective_range)
                    metrics = get_metrics(session)
                    positions = get_positions(session)
                    instrument_metrics = compute_instrument_metrics(session, positions)
                    price_anomaly_ids = prices_service.instruments_with_price_anomalies(
                        session, [p.instrument.id for p in positions]
                    )
                    freshness = holding_freshness(session, positions)
                    verdict = compute_market_verdict(
                        session,
                        portfolio_xirr=metrics.xirr,
                        years=(
                            years_between(metrics.first_cashflow_date, metrics.as_of)
                            if metrics.first_cashflow_date
                            else None
                        ),
                        as_of=metrics.as_of,
                    )
                    display_ccy = display_currency_service.get_display_currency(session)
                    display_tz = timezone_service.resolve_tzinfo(
                        timezone_service.get_timezone(session)
                    )
                    # The "other" currency for the comparison line on every range
                    # a week or longer (USD when the display is EUR, else EUR).
                    secondary_ccy = "USD" if display_ccy.upper() == "EUR" else "EUR"
                    value_series_secondary: list[ValueSeriesPoint] | None = None
                    if range_label == "Day":
                        # Backfill the last trading session (~30-min bars) once
                        # per day so opening the app late, after the close, or
                        # over a weekend still shows a full intraday "1 Day"
                        # curve. No-op after the first fetch of the session.
                        intraday_snapshots_service.reconstruct_last_session(session)
                        value_series = build_intraday_value_series(
                            session, currency=display_ccy, tz=display_tz, positions=positions
                        )
                        # The reference line marking yesterday's settled close.
                        intraday_prev_close = previous_session_close_value(
                            session, currency=display_ccy
                        )
                    elif range_label == "Week":
                        # Multi-day intraday curve (start/midday/close per session),
                        # inspired by the "1 Day" curve. Built in both currencies so
                        # the right-axis comparison line shares the same start.
                        value_series = build_week_value_series(
                            session, currency=display_ccy, tz=display_tz, positions=positions
                        )
                        value_series_secondary = build_week_value_series(
                            session, currency=secondary_ccy, tz=display_tz, positions=positions
                        )
                        # Fall back to the daily snapshot series if the feed served
                        # no intraday bars (offline / quiet week), so the range is
                        # never blank.
                        if not value_series:
                            value_series = build_value_series(
                                session, currency=display_ccy, range_label=range_label
                            )
                            value_series_secondary = build_value_series(
                                session, currency=secondary_ccy, range_label=range_label
                            )
                        intraday_prev_close = None
                    else:
                        value_series = build_value_series(
                            session, currency=display_ccy, range_label=range_label
                        )
                        value_series_secondary = build_value_series(
                            session, currency=secondary_ccy, range_label=range_label
                        )
                        intraday_prev_close = None
                    # Only keep the companion line for the multi-currency ranges
                    # and when it actually lines up point-for-point with the
                    # primary (so the shared-start scaling is meaningful).
                    if (
                        range_label not in MULTI_CCY_RANGES
                        or not value_series_secondary
                        or (value_series and len(value_series_secondary) != len(value_series))
                    ):
                        value_series_secondary = None
                        secondary_ccy = None
                    # Display-currency FX (EUR→display) used to convert the
                    # portfolio-level expense cost and the allocation treemap.
                    display_quote = display_ccy if display_ccy != "EUR" else "USD"
                    fx_rate = display_currency_service.current_rate(session, quote=display_quote)
                # Hide fully-sold instruments from the holdings view — anything
                # with a residual share count below 1e-7 (a tenth of a millionth
                # of a share) is effectively zero and just clutters the overview.
                _min_shares = Decimal("0.0000001")
                held_positions = [p for p in positions if p.shares >= _min_shares]
                cards = build_holding_cards(
                    held_positions,
                    metrics=instrument_metrics,
                    freshness=freshness,
                    price_anomaly_ids=price_anomaly_ids,
                )
                treemap_data = allocation_treemap(positions)
                # "When the price is from": the most recent moment we pulled a
                # fresh price from the provider, used as a fallback to stamp the
                # settled-today Daily Growth caption.
                _refresh_times = [
                    f.updated_at for f in freshness.values() if f.updated_at is not None
                ]
                price_observed_at = max(_refresh_times) if _refresh_times else None
                # The most recent *market* time across holdings — when the served
                # prices were last struck on the exchange (the provider's
                # ``regularMarketTime``). This is the stamp the settled-today
                # caption prefers, so it reads "as of <market time>" (e.g. the
                # moment the day's NAV published) rather than our pull instant.
                _market_times = [
                    f.price_market_time
                    for f in freshness.values()
                    if f.price_market_time is not None
                ]
                price_market_at = max(_market_times) if _market_times else None
                return _OverviewData(
                    range_label=range_label,
                    metrics=metrics,
                    display_ccy=display_ccy,
                    display_tz=display_tz,
                    value_series=value_series,
                    fx_rate=fx_rate,
                    display_quote=display_quote,
                    verdict=verdict,
                    cards=cards,
                    treemap_data=treemap_data,
                    price_observed_at=price_observed_at,
                    price_market_at=price_market_at,
                    intraday_prev_close=intraday_prev_close,
                    value_series_secondary=value_series_secondary,
                    secondary_ccy=secondary_ccy,
                )

            def _render(data: _OverviewData) -> None:
                range_label = data.range_label
                metrics = data.metrics
                display_ccy = data.display_ccy
                display_tz = data.display_tz
                value_series = data.value_series
                fx_rate = data.fx_rate
                display_quote = data.display_quote
                verdict = data.verdict
                cards = data.cards
                treemap_data = data.treemap_data

                # Total Value is the headline money figure — it now leads the
                # page from the hero box in the header.
                total_value_eur = metrics.total_value_eur
                total_value_usd = metrics.total_value_usd

                # Daily-growth caption (shared by the hero "today" badge and the
                # Today card): while the NYSE session is open the figure is
                # flagged "· live" and the clock is omitted (it just tracks now);
                # once closed the caption stamps when the price is from — the
                # provider's market time — with our pull instant trailing as
                # "· updated …". A compact, display-relative FX rate trails it.
                _now = datetime.now(UTC)
                # The headline daily move as money in the display currency, shown
                # in the "Today" square in place of the FX detail (which now sits
                # by the KPIs below).
                _today_money = _by_ccy(
                    metrics.daily_growth_money_eur, metrics.daily_growth_money_usd, display_ccy
                )
                _caption = build_daily_growth_caption(
                    last_date=metrics.daily_growth_as_of,
                    fx_eur_usd=metrics.daily_growth_fx_eur_usd,
                    fx_eur_usd_prev=metrics.daily_growth_fx_eur_usd_prev,
                    display_ccy=display_ccy,
                    today=date.today(),
                    tz=display_tz,
                    market_open=is_us_market_open(_now),
                    price_observed_at=data.price_observed_at,
                    price_market_at=data.price_market_at,
                    now=_now,
                    money_text=_fmt_signed_money(_today_money, display_ccy),
                )

                # Fill the header's Total Value hero box (created in register()).
                hero_slot.clear()
                with hero_slot:
                    _hero_total_value(
                        total_value_eur,
                        total_value_usd,
                        display_ccy=display_ccy,
                        daily_pct=_by_ccy(
                            metrics.daily_growth_pct, metrics.daily_growth_pct_usd, display_ccy
                        ),
                    )

                _render_kpi_grid(
                    metrics,
                    verdict,
                    display_ccy=display_ccy,
                    today_sub=_caption.combined(),
                )
                # Expense ratio moved out of the KPI grid (kept the grid a clean
                # 4×2) and surfaced as text alongside the FX line below.
                expense_text = (
                    f"Weighted expense ratio: {fmt_pct(metrics.weighted_expense_ratio)}  "
                    f"(≈ {fmt_money(_convert(metrics.annual_expense_cost_eur, display_ccy, fx_rate), display_ccy)} / yr)"
                )
                # Two complementary dividend figures: the lifetime cumulative
                # dividend *return* (all cash dividends ÷ current value), then a
                # per-year dividend *yield* (trailing-12-month dividends ÷ value)
                # shown with the last-12-months cash dividends in the display
                # currency. A rolling year, not calendar YTD, so the yield is a
                # real annual rate even in early January.
                div_ttm = _by_ccy(metrics.dividends_ttm_eur, metrics.dividends_ttm_usd, display_ccy)
                div_yield_text = (
                    f"Dividend total return: {fmt_pct(metrics.dividend_yield_pct)}  ·  "
                    f"Dividend yield: {fmt_pct(metrics.dividend_yield_ttm_pct)} "
                    f"(last 12 mo {fmt_money(div_ttm, display_ccy)})"
                )
                if fx_rate is not None:
                    # The FX line now carries the day's FX move (%) — the detail
                    # that used to sit in the "Today" square — next to the spot.
                    fx_pct = (
                        fx_move_pct(
                            metrics.daily_growth_fx_eur_usd,
                            metrics.daily_growth_fx_eur_usd_prev,
                            display_ccy,
                        )
                        if metrics.daily_growth_fx_eur_usd is not None
                        else None
                    )
                    fx_text = f"FX EUR→{display_quote} {fx_rate:,.4f}"
                    if fx_pct is not None:
                        sign = "+" if fx_pct >= 0 else "\u2212"  # proper minus sign
                        fx_text += f" ({sign}{abs(fx_pct):.2f}%)"
                    ui.label(
                        f"{fx_text}  ·  {expense_text}  ·  {div_yield_text}",
                    ).classes("text-caption opacity-70")
                else:
                    ui.label(f"{expense_text}  ·  {div_yield_text}").classes(
                        "text-caption opacity-70"
                    )

                # Movers are rendered under the value chart (below), not here, so
                # the day's leaderboard sits as a distinct band just above the
                # holdings detail. Build it now so the holding cards can badge
                # the winners/losers, ranked in the active display currency.
                movers = build_movers(cards, currency=display_ccy)
                badges = _mover_badges(movers)

                _value_over_time_section(
                    value_series,
                    range_label=range_label,
                    display_ccy=display_ccy,
                    display_tz=display_tz,
                    prev_close=data.intraday_prev_close,
                    secondary=data.value_series_secondary,
                    secondary_ccy=data.secondary_ccy,
                )

                # Today's winners/losers — a distinct band under the graph and
                # right above the holdings list.
                if movers.winners or movers.losers:
                    _render_movers(movers, display_ccy=display_ccy)

                if not cards:
                    empty_state(
                        "insights",
                        "No positions yet",
                        hint="Go to Transactions → Import CSV to load broker data, "
                        "or seed defaults from Settings.",
                    )
                else:
                    _zero_value_warning([c.symbol for c in cards if c.value_warning])
                    _price_data_warning([c.symbol for c in cards if c.price_data_warning])
                    with section("Holdings"):
                        with ui.row().classes("items-center justify-between w-full no-wrap"):
                            ui.label(
                                f"{len(cards)} "
                                f"{'position' if len(cards) == 1 else 'positions'} "
                                "· largest first"
                            ).classes("text-caption opacity-70")
                            ui.button(
                                "Full table & detail",
                                icon="table_rows",
                                on_click=lambda: ui.navigate.to(HOLDINGS_PATH),
                            ).props("flat dense no-caps color=primary")
                        with ui.element("div").classes("inv-holding-grid w-full q-mt-sm"):
                            for card in cards:
                                _holding_card(
                                    card,
                                    display_ccy=display_ccy,
                                    tz=display_tz,
                                    badge=badges.get(card.symbol),
                                )
                    with section("Allocation"):
                        ui.plotly(
                            _treemap_figure(treemap_data, currency=display_ccy, fx_rate=fx_rate),
                        ).classes("w-full h-[40vh]")

            deferred(_render, compute=_gather)


def _convert(amount_eur: Decimal | None, target: str, fx_rate: Decimal | None) -> Decimal | None:
    """Lightweight EUR→target conversion using a pre-fetched FX rate.

    Avoids re-opening a session per KPI card. Returns ``None`` when the
    input is ``None`` so the formatter renders an em dash.
    """
    if amount_eur is None:
        return None
    if target.upper() == "EUR":
        return amount_eur
    if fx_rate is None or fx_rate == 0:
        return amount_eur
    return amount_eur * fx_rate
