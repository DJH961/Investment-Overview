"""``deferred`` — paint a spinner first, then build heavy content after the
first browser frame.

NiceGUI builds a page synchronously before sending it to the client, so a page
that crunches metrics/positions/projection up-front leaves the user staring at a
blank tab until everything is ready. ``deferred`` renders a lightweight spinner
immediately and schedules the expensive ``build`` callback on a one-shot timer,
so the shell paints first and the spinner is swapped for the real content the
moment it is ready.

Usage::

    deferred(lambda: _render_overview_body(value_range))
"""

from __future__ import annotations

from collections.abc import Callable

from nicegui import ui


def deferred(
    build: Callable[[], None],
    *,
    label: str = "Loading…",
    delay: float = 0.05,
) -> None:  # pragma: no cover - UI timing
    """Show a spinner, then run ``build`` once the page has painted.

    ``build`` is responsible for rendering the page body; it runs inside the
    same container the spinner occupied, so the spinner disappears as soon as
    the content is in place.
    """
    container = ui.column().classes("w-full")
    with container, ui.row().classes("w-full items-center justify-center q-pa-xl gap-sm"):
        ui.spinner(size="lg")
        if label:
            ui.label(label).classes("text-caption opacity-70")

    def _run() -> None:
        container.clear()
        with container:
            build()

    ui.timer(delay, _run, once=True)
