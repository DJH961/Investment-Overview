"""``chip`` — small pill used for metadata tags (status, currency, etc.)."""

from __future__ import annotations

from typing import Literal

from nicegui import ui

ChipKind = Literal["neutral", "gain", "loss", "accent"]

_VARIANT_CLASS: dict[ChipKind, str] = {
    "neutral": "",
    "gain": "inv-chip-gain",
    "loss": "inv-chip-loss",
    "accent": "inv-chip-accent",
}


def chip(text: str, *, kind: ChipKind = "neutral") -> None:
    """Render an inline pill with a small text label."""
    ui.html(f'<span class="inv-chip {_VARIANT_CLASS[kind]}">{text}</span>')
