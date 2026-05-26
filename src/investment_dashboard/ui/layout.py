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


def _header(title: str) -> None:
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


@contextmanager
def page_frame(title: str, *, current: str) -> Iterator[None]:
    """Render the header + sidebar and yield a content container.

    ``current`` must match the registered path of the active page so the
    sidebar can highlight it.
    """
    _header(title)
    _sidebar(current)
    with ui.column().classes("w-full q-pa-md gap-md") as col:
        yield
    # ``col`` is unused beyond the ``with`` block but keeping the name lets
    # us extend later (e.g. error boundary) without changing call-sites.
    del col
