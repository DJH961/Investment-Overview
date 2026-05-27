"""``section`` — a hairline-bordered card with a title used to group content.

Usage::

    with section("Performance"):
        ui.plotly(fig).classes("w-full h-[35vh]")
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from nicegui import ui


@contextmanager
def section(title: str | None = None, *, classes: str = "") -> Iterator[None]:
    """Yield a styled section container."""
    with ui.element("div").classes(f"inv-section w-full {classes}".strip()):
        if title:
            ui.html(f'<div class="inv-section-title">{title}</div>')
        yield
