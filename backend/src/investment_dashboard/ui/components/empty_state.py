"""``empty_state`` — shared zero-data placeholder.

Used wherever a page would otherwise render a bare "no data" sentence
(Overview, Deposits, Transactions, Settings list sections, ...).
"""

from __future__ import annotations

from collections.abc import Callable

from nicegui import ui


def empty_state(
    icon: str,
    title: str,
    *,
    hint: str | None = None,
    cta_label: str | None = None,
    on_cta: Callable[[], None] | None = None,
) -> None:
    """Render a centered icon + title + optional hint + optional CTA button."""
    with ui.element("div").classes("inv-empty w-full"):
        ui.icon(icon)
        ui.html(f'<div class="inv-empty-title">{title}</div>')
        if hint:
            ui.html(f'<div class="inv-empty-hint">{hint}</div>')
        if cta_label and on_cta is not None:
            ui.button(cta_label, on_click=on_cta).props("unelevated color=primary").classes(
                "q-mt-md"
            )
