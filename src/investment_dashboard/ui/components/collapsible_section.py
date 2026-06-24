"""``collapsible_section`` — a section card that can fold away.

Visually it matches :func:`investment_dashboard.ui.components.section.section`
(same hairline-bordered surface) but the body is a Quasar expansion, so a group
of advanced or rarely-touched controls can stay collapsed until the user wants
it. Used to tidy the Settings page from one long flat list into a handful of
labelled, foldable groups.

Usage::

    with collapsible_section("Developer tools", icon="developer_mode"):
        ...  # content, hidden until the header is tapped
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from nicegui import ui


@contextmanager
def collapsible_section(
    title: str,
    *,
    icon: str | None = None,
    open: bool = False,
    caption: str | None = None,
    classes: str = "",
) -> Iterator[None]:
    """Yield the body of a foldable, section-styled container.

    Args:
        title: header text shown on the always-visible row.
        icon: optional leading Material icon name.
        open: whether the section starts expanded (default: collapsed).
        caption: optional one-line description rendered just inside the body.
        classes: extra CSS classes for the outer element.
    """
    expansion = ui.expansion(title, icon=icon, value=open).classes(
        f"inv-collapse w-full {classes}".strip()
    )
    with expansion:
        if caption:
            ui.label(caption).classes("text-caption opacity-70 q-mb-sm")
        yield
