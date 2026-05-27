"""Shared layout: persistent sidebar nav + header used by every page.

Usage from inside a ``@ui.page`` handler::

    from investment_dashboard.ui.layout import page_frame

    @ui.page("/overview")
    def overview() -> None:
        with page_frame("Overview", current="/overview"):
            ui.label("…page content…")
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
    NavItem("Calculator", "/calculator", "calculate"),
    NavItem("Settings", "/settings", "settings"),
)


#: Pages where automatic "no accounts → /onboarding" redirect is skipped.
#: Onboarding itself, settings (where the user might be hand-adding the
#: first account), and the welcome page must remain reachable on an
#: empty DB or the wizard becomes unreachable.
_ONBOARDING_BYPASS_PATHS: frozenset[str] = frozenset({"/onboarding", "/settings"})


def _on_currency_change(value: str) -> None:  # pragma: no cover - UI callback
    try:
        with session_scope() as session:
            display_currency_service.set_display_currency(session, value)
    except ValueError as exc:
        ui.notify(str(exc), type="negative")
        return
    ui.notify(f"Display currency set to {value}", type="positive")
    # Reload the current page so every value re-renders in the new
    # currency without forcing the user to navigate manually.
    ui.navigate.reload()


def _header(title: str, *, current_currency: str) -> None:
    with ui.header(elevated=True).classes(
        "items-center justify-between bg-primary text-white q-px-md"
    ):
        with ui.row().classes("items-center gap-md"):
            ui.icon("trending_up").classes("text-h5")
            ui.label("Investment Dashboard").classes("text-h6")
            ui.label(f"v{__version__}").classes("text-caption opacity-70")
        with ui.row().classes("items-center gap-md"):
            ui.label(title).classes("text-subtitle1")
            ui.separator().props("vertical inset")
            ui.label("Display").classes("text-caption opacity-80")
            ui.toggle(
                list(display_currency_service.SUPPORTED_CURRENCIES),
                value=current_currency,
                on_change=lambda e: _on_currency_change(e.value),
            ).props("dense color=white text-color=primary toggle-color=white")
            ui.separator().props("vertical inset")
            ui.label(
                "Last refresh: " + datetime.now(tz=UTC).strftime("%Y-%m-%d %H:%M UTC")
            ).classes("text-caption")


def _sidebar(current: str) -> None:
    with ui.left_drawer(value=True, bordered=True).classes("bg-grey-2"):
        ui.label("Navigation").classes("text-overline q-pa-sm")
        with ui.list().props("padding").classes("w-full"):
            for item in NAV_ITEMS:
                active = item.path == current
                row = ui.item(on_click=lambda p=item.path: ui.navigate.to(p)).props(
                    f"clickable {'active' if active else ''}"
                )
                with row:
                    with ui.item_section().props("avatar"):
                        ui.icon(item.icon)
                    with ui.item_section():
                        ui.label(item.label)


def _maybe_redirect_to_onboarding(current: str) -> bool:
    """Redirect to ``/onboarding`` when the DB has no accounts.

    Returns ``True`` if a redirect was triggered so callers can short-
    circuit further rendering. The onboarding and settings pages are
    bypass-listed so the user can actually reach the wizard / add forms
    on an empty DB.
    """
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
    if _maybe_redirect_to_onboarding(current):
        # Still render an empty frame so NiceGUI has a body while the
        # client-side navigation kicks in. Returning early would raise.
        with ui.column().classes("w-full q-pa-md"):
            ui.label("Redirecting to setup…").classes("text-caption opacity-60")
            yield
        return

    try:
        with session_scope() as session:
            current_currency = display_currency_service.get_display_currency(session)
    except Exception:  # pragma: no cover - defensive
        current_currency = display_currency_service.DEFAULT_CURRENCY

    _header(title, current_currency=current_currency)
    _sidebar(current)
    with ui.column().classes("w-full q-pa-md gap-md") as col:
        yield
    # ``col`` is unused beyond the ``with`` block but keeping the name lets
    # us extend later (e.g. error boundary) without changing call-sites.
    del col
