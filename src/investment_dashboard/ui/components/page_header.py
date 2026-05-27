"""``page_header`` — consistent page title row with optional subtitle.

Usage::

    from investment_dashboard.ui.components import page_header

    page_header("Overview", subtitle="Portfolio at a glance")
"""

from __future__ import annotations

from nicegui import ui


def page_header(title: str, *, subtitle: str | None = None) -> None:
    """Render the standard page-title row."""
    with ui.element("div").classes("inv-page-header w-full q-mb-md"):
        ui.html(f"<h1>{title}</h1>")
        if subtitle:
            ui.html(f'<div class="inv-page-subtitle">{subtitle}</div>')
