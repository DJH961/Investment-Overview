"""Shared layout: persistent sidebar nav + header used by every page.

Usage from inside a ``@ui.page`` handler::

    from investment_dashboard.ui.layout import page_frame

    @ui.page("/overview")
    def overview() -> None:
        with page_frame("Overview", current="/overview"):
            ui.label("…page content…")

v1.5 rebuild — modern "neo-fintech" chrome:

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
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from nicegui import ui

from investment_dashboard import __version__
from investment_dashboard.db import session_scope
from investment_dashboard.services import display_currency_service
from investment_dashboard.services.onboarding_service import is_onboarded
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
    NavItem("Deposits", "/deposits", "savings"),
    NavItem("Transactions", "/transactions", "receipt_long"),
    NavItem("Monthly", "/monthly", "calendar_month"),
    NavItem("Yearly", "/yearly", "calendar_today"),
    NavItem("Analytics", "/analytics", "insights"),
    NavItem("Calculator", "/calculator", "calculate"),
    NavItem("Settings", "/settings", "settings"),
)


#: Pages where automatic "no accounts → /onboarding" redirect is skipped.
_ONBOARDING_BYPASS_PATHS: frozenset[str] = frozenset({"/onboarding", "/settings"})


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


def _header(title: str, *, current_currency: str, dark: ui.dark_mode) -> None:
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
                icon="refresh",
                on_click=ui.navigate.reload,
            ).props("flat round dense").tooltip("Refresh page")
            ui.html(
                '<span style="font-size:.75rem;color:var(--inv-muted)">'
                + datetime.now(tz=UTC).strftime("%Y-%m-%d %H:%M UTC")
                + "</span>"
            )


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


def _maybe_redirect_to_onboarding(current: str) -> bool:
    """Redirect to ``/onboarding`` when the DB has no accounts."""
    if current in _ONBOARDING_BYPASS_PATHS:
        return False
    try:
        with session_scope() as session:
            already = is_onboarded(session)
    except Exception:  # pragma: no cover - defensive
        return False
    if already:
        return False
    ui.navigate.to("/onboarding")
    return True


@contextmanager
def page_frame(title: str, *, current: str) -> Iterator[None]:
    """Render the header + sidebar and yield a content container.

    ``current`` must match the registered path of the active page so the
    sidebar can highlight it.
    """
    # Dark mode controller — defaults to ``None`` (auto), so the first load
    # follows the device/browser preference (``prefers-color-scheme``). The
    # header button cycles Auto → Light → Dark. ``ui.dark_mode`` is persistent
    # within the NiceGUI tab session.
    ui_style.apply_per_page()
    dark = ui.dark_mode(value=None)

    if _maybe_redirect_to_onboarding(current):
        with ui.column().classes("w-full q-pa-md"):
            ui.label("Redirecting to setup…").classes("text-caption opacity-60")
            yield
        return

    try:
        with session_scope() as session:
            current_currency = display_currency_service.get_display_currency(session)
    except Exception:  # pragma: no cover - defensive
        current_currency = display_currency_service.DEFAULT_CURRENCY

    _header(title, current_currency=current_currency, dark=dark)
    _sidebar(current)
    with ui.column().classes("inv-page q-pa-lg gap-md") as col:
        yield
    del col
