"""``confirm_dialog`` — a small "are you sure?" gate for destructive actions.

Usage::

    confirm_dialog(
        "Seed default setup?",
        "This adds the preset accounts and instruments to your ledger.",
        on_confirm=_seed_clicked,
        confirm_label="Seed",
    )

The ``on_confirm`` callback only runs once the user clicks the confirm button;
clicking Cancel (or dismissing the dialog) is a no-op. Keeping the gate in one
place means every irreversible/overwriting action looks and behaves the same.
"""

from __future__ import annotations

from collections.abc import Callable

from nicegui import ui


def confirm_dialog(
    title: str,
    message: str,
    *,
    on_confirm: Callable[[], None],
    confirm_label: str = "Continue",
    confirm_icon: str = "warning",
    confirm_color: str = "negative",
    cancel_label: str = "Cancel",
) -> None:  # pragma: no cover - UI
    """Open a modal asking the user to confirm before running ``on_confirm``."""
    with ui.dialog() as dialog, ui.card().classes("min-w-[26rem] gap-sm"):
        ui.label(title).classes("text-h6")
        ui.label(message).classes("text-body2")

        def _confirm() -> None:
            dialog.close()
            on_confirm()

        with ui.row().classes("justify-end w-full gap-sm q-mt-md"):
            ui.button(cancel_label, on_click=dialog.close).props("flat no-caps")
            ui.button(confirm_label, icon=confirm_icon, on_click=_confirm).props(
                f"unelevated color={confirm_color} no-caps"
            )
    dialog.open()
