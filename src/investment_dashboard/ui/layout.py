"""Shared layout: persistent sidebar nav + header used by every page.

Usage from inside a ``@ui.page`` handler::

    from investment_dashboard.ui.layout import page_frame

    @ui.page("/overview")
    def overview() -> None:
        with page_frame("Overview", current="/overview"):
            ui.label("…page content…")

Modern "neo-fintech" chrome (introduced in the v1.5 rebuild, iterated since):

* Sticky frosted header with brand mark, name + version pill, a compact
  currency segmented control, a light/dark toggle, and a "last refresh"
  timestamp with a manual refresh icon button.
* Narrower (240 px) sidebar with rounded active-state pill, hover, and
  footer area with the build version.
* Wider, centered content column.

The public API (``NAV_ITEMS``, ``page_frame``) is unchanged so existing
pages keep working without modification.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import tzinfo
from typing import TYPE_CHECKING

from nicegui import ui

from investment_dashboard import __version__
from investment_dashboard.db import session_scope
from investment_dashboard.services import (
    diagnostics_service,
    display_currency_service,
    theme_service,
    timezone_service,
)
from investment_dashboard.services.onboarding_service import is_onboarded
from investment_dashboard.ui import connectivity
from investment_dashboard.ui import style as ui_style

if TYPE_CHECKING:
    from collections.abc import Iterator


@dataclass(frozen=True)
class NavItem:
    """One entry in the sidebar navigation."""

    label: str
    path: str
    icon: str


#: Ordered nav for the seven app pages (spec §8).
NAV_ITEMS: tuple[NavItem, ...] = (
    NavItem("Overview", "/overview", "dashboard"),
    NavItem("Holdings", "/holdings", "account_balance_wallet"),
    NavItem("Deposits", "/deposits", "savings"),
    NavItem("Transactions", "/transactions", "receipt_long"),
    NavItem("Monthly", "/monthly", "calendar_month"),
    NavItem("Yearly", "/yearly", "calendar_today"),
    NavItem("Projection", "/projection", "trending_up"),
    NavItem("Analytics", "/analytics", "insights"),
    NavItem("Calculator", "/calculator", "calculate"),
    NavItem("Data Health", "/diagnostics", "health_and_safety"),
    NavItem("Settings", "/settings", "settings"),
)


#: Pages where automatic "no accounts → /onboarding" redirect is skipped.
_ONBOARDING_BYPASS_PATHS: frozenset[str] = frozenset({"/onboarding", "/settings", "/help"})


def _on_currency_change(value: str) -> None:  # pragma: no cover - UI callback
    try:
        with session_scope() as session:
            display_currency_service.set_display_currency(session, value)
    except ValueError as exc:
        ui.notify(str(exc), type="negative")
        return
    ui.notify(f"Display currency set to {value}", type="positive")
    ui.navigate.reload()


# Ordered cycle for the header theme button: auto → light → dark → auto …
# ``None`` means "follow the device/browser preference" (see ``ui.dark_mode``).
_THEME_CYCLE: tuple[bool | None, ...] = (None, False, True)


def _theme_icon(value: bool | None) -> str:
    """Return the Material icon name for the given dark-mode value."""
    if value is None:
        return "brightness_auto"
    if value:
        return "light_mode"
    return "dark_mode"


def _theme_tooltip(value: bool | None) -> str:
    """Return the tooltip describing the *current* theme state."""
    if value is None:
        return "Theme: Auto (follow system) — click for Light"
    if value:
        return "Theme: Dark — click for Auto"
    return "Theme: Light — click for Dark"


def _cycle_theme(
    dark: ui.dark_mode,
    button: ui.button,
) -> None:  # pragma: no cover - UI callback
    """Advance dark mode through Auto → Light → Dark and refresh the button."""
    current = dark.value
    try:
        idx = _THEME_CYCLE.index(current)
    except ValueError:
        idx = -1
    nxt = _THEME_CYCLE[(idx + 1) % len(_THEME_CYCLE)]
    dark.value = nxt
    button.props(f'icon="{_theme_icon(nxt)}"')
    button.tooltip(_theme_tooltip(nxt))
    # Persist so the choice survives navigation to another page (each page
    # render re-creates the ``ui.dark_mode`` instance and would otherwise
    # snap back to the initial value).
    try:
        with session_scope() as session:
            theme_service.set_theme(session, nxt)
    except Exception:  # pragma: no cover - defensive
        pass


def _data_health_badge() -> None:
    """Header entry point to the Data Health page, tinted by current severity.

    Surfaces the app's *silent* degradations (missing FX/prices, incomplete
    legs, provider failures) on every page so they can't go unnoticed (audit
    E1). Uses the cheap :func:`diagnostics_service.quick_status` probe so it
    stays light enough for the header; the page itself runs the full sweep.
    """
    severity, count = "ok", 0
    try:
        with session_scope() as session:
            severity, count = diagnostics_service.quick_status(session)
    except Exception:  # pragma: no cover - defensive (read-only / fresh DB)
        severity, count = "ok", 0

    icon = {"ok": "health_and_safety", "warning": "warning", "error": "error"}[severity]
    color = {"ok": "", "warning": "warning", "error": "negative"}[severity]
    tip = (
        "Data Health — all clear"
        if severity == "ok"
        else f"Data Health — {count} item(s) need attention"
    )
    btn = ui.button(icon=icon, on_click=lambda: ui.navigate.to("/diagnostics"))
    btn.props("flat round dense" + (f" color={color}" if color else ""))
    btn.tooltip(tip)


def _quit_clicked() -> None:  # pragma: no cover - UI callback
    """Confirm, then cleanly stop the server (releases the writer lock)."""
    from investment_dashboard import shutdown  # noqa: PLC0415
    from investment_dashboard.ui.components import confirm_dialog  # noqa: PLC0415

    def _confirm() -> None:
        ui.notify("Shutting down… you can close this tab.", type="warning")
        # Let the toast paint before the server stops serving, then release the
        # writer lock and exit. ``request_shutdown`` is safe to call repeatedly.
        ui.timer(0.6, shutdown.request_shutdown, once=True)

    confirm_dialog(
        "Leave and shut down?",
        "This stops the background server and releases the writer lock, fully "
        "closing the app. You'll need to relaunch it to use the dashboard again.",
        on_confirm=_confirm,
        confirm_label="Shut down",
        confirm_icon="power_settings_new",
    )


def _quit_button() -> None:
    """Header control to cleanly leave and shut the whole app down.

    Available on every page's banner so the user always has a one-click,
    no-console way to stop the background server (and free the single-writer
    lock) rather than hunting for it in Settings or killing the process.
    """
    btn = ui.button(icon="power_settings_new", on_click=_quit_clicked)
    btn.props("flat round dense color=negative")
    btn.tooltip("Leave & shut down the app")


def _header(
    title: str,
    *,
    current_currency: str,
    now_label: str,
    dark: ui.dark_mode,
    now_tz: tzinfo | None = None,
) -> None:
    with (
        ui.header(elevated=False).classes("inv-header q-px-md").style("min-height:56px"),
        ui.row().classes("items-center justify-between w-full no-wrap"),
    ):
        # Left: brand + product + version pill
        with ui.row().classes("items-center gap-sm no-wrap"):
            ui.html(f'<span class="inv-brand-mark">{ui_style.BRAND_SVG}</span>')
            ui.html('<span class="inv-brand-name">Investment Dashboard</span>')
            ui.html(f'<span class="inv-version-pill">v{__version__}</span>')
            ui.element("div").style(
                "width:1px;height:20px;background:var(--inv-hairline);margin:0 .5rem"
            )
            ui.html(f'<span style="font-size:.875rem;color:var(--inv-muted)">{title}</span>')

        # Right: currency toggle + dark mode + refresh meta
        with ui.row().classes("items-center gap-sm no-wrap"):
            ui.toggle(
                list(display_currency_service.SUPPORTED_CURRENCIES),
                value=current_currency,
                on_change=lambda e: _on_currency_change(e.value),
            ).props("dense unelevated no-caps")
            theme_btn = ui.button(icon=_theme_icon(dark.value)).props("flat round dense")
            theme_btn.tooltip(_theme_tooltip(dark.value))
            theme_btn.on_click(lambda: _cycle_theme(dark, theme_btn))
            ui.button(
                icon="help_outline",
                on_click=lambda: ui.navigate.to("/help"),
            ).props("flat round dense").tooltip("Help & user guide")
            _data_health_badge()
            # Always-on cue that the app's *automatic* price refresh is alive:
            # it spins/says "Updating…" while a background pull runs and shows
            # the last auto-update time when idle (see refresh_indicator). The
            # chip is clickable to force an immediate refresh — it replaces the
            # old standalone refresh button (which only reloaded the page).
            from investment_dashboard.ui import refresh_indicator  # noqa: PLC0415

            refresh_indicator.install_header_indicator(tz=now_tz)
            # Always-visible live connection indicator (green/amber/red),
            # driven from the websocket by ui.connectivity so a dropped local
            # connection can never go unnoticed.
            ui.html(connectivity.HEADER_DOT_HTML)
            ui.html(
                '<span style="font-size:.75rem;color:var(--inv-muted)">' + now_label + "</span>"
            )
            _quit_button()


def _sidebar(current: str) -> None:
    with ui.left_drawer(value=True, bordered=False).classes("inv-sidebar q-pa-none"):
        ui.html('<div class="inv-nav-section">Navigation</div>')
        with ui.list().props("padding").classes("w-full"):
            for item in NAV_ITEMS:
                active = item.path == current
                cls = "inv-nav-item" + (" inv-nav-active" if active else "")
                row = (
                    ui.item(on_click=lambda p=item.path: ui.navigate.to(p))
                    .props("clickable")
                    .classes(cls)
                )
                with row:
                    with ui.item_section().props("avatar"):
                        ui.icon(item.icon)
                    with ui.item_section():
                        ui.label(item.label)
        ui.element("div").classes("col-grow")
        ui.html(f'<div class="inv-sidebar-footer">Investment Dashboard · v{__version__}</div>')


def _maybe_redirect_to_onboarding(current: str, *, onboarded: bool) -> bool:
    """Redirect to ``/onboarding`` when the DB has no accounts."""
    if current in _ONBOARDING_BYPASS_PATHS:
        return False
    if onboarded:
        return False
    ui.navigate.to("/onboarding")
    return True


@contextmanager
def page_frame(title: str, *, current: str) -> Iterator[None]:
    """Render the header + sidebar and yield a content container.

    ``current`` must match the registered path of the active page so the
    sidebar can highlight it.
    """
    # Dark mode controller — defaults to the persisted user preference
    # (``None`` / ``False`` / ``True`` meaning Auto / Light / Dark). The
    # header button cycles Auto → Light → Dark and writes the new choice
    # back via :mod:`theme_service` so it survives navigation.
    ui_style.apply_per_page()
    # All chrome reads (theme, onboarding gate, currency, clock) share one
    # session so a tab switch opens a single transaction instead of three.
    try:
        with session_scope() as session:
            initial_theme = theme_service.get_theme(session)
            onboarded = is_onboarded(session)
            current_currency = display_currency_service.get_display_currency(session)
            now = timezone_service.now(session)
            # Drop the zone suffix (``%Z``) from the header clock — the user
            # picks the zone in Settings, so repeating it on every page is noise.
            now_label = now.strftime("%Y-%m-%d %H:%M")
            now_tz = now.tzinfo
    except Exception:  # pragma: no cover - defensive
        initial_theme = None
        onboarded = True
        current_currency = display_currency_service.DEFAULT_CURRENCY
        now_label = ""
        now_tz = None
    dark = ui.dark_mode(value=initial_theme)

    if _maybe_redirect_to_onboarding(current, onboarded=onboarded):
        with ui.column().classes("w-full q-pa-md"):
            ui.label("Redirecting to setup…").classes("text-caption opacity-60")
            yield
        return

    _header(
        title,
        current_currency=current_currency,
        now_label=now_label,
        dark=dark,
        now_tz=now_tz,
    )
    _sidebar(current)
    # Surface any *new* background-task failure (live refresh / startup refresh)
    # as a toast while this page is open — the app runs with no console window.
    from investment_dashboard.ui import runtime_errors  # noqa: PLC0415

    runtime_errors.install_client_watch()
    # A page load (e.g. a browser refresh) now also pulls fresh prices, fixing
    # the old "refresh only reloaded the UI" gap. TTL-gated, so navigating
    # between pages is cheap — only symbols past their refresh window hit the
    # network (see services.auto_refresh / prices_service).
    from investment_dashboard.services import auto_refresh  # noqa: PLC0415

    auto_refresh.run_in_background("Page refresh")
    with ui.column().classes("inv-page q-pa-lg gap-md") as col:
        yield
    del col
