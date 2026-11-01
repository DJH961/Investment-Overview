"""Preserve the user's scroll position across full-page reloads.

The dashboard reloads the whole page in a few places — the header *Update* chip
after a manual price refresh, and the chart range/lookback toggles that navigate
with a new query param. A naive ``ui.navigate.reload()`` jumps the user back to
the top, which is jarring when they were halfway down inspecting a holding.

This module injects a tiny inline script that:

* continuously records ``window.scrollY`` into ``sessionStorage`` (keyed by the
  page path), and
* on the next load of that path, scrolls back to the saved offset — retrying for
  a short window because NiceGUI paints its body asynchronously over the
  websocket, so the page is not tall enough to scroll to immediately on ``load``.

It is keyed per path so each page restores independently, and uses
``sessionStorage`` so the memory is per-tab and clears when the tab closes.
"""

from __future__ import annotations

import json

#: How aggressively to retry the restore while NiceGUI streams the body in.
#: ~75 ms × 40 ≈ 3 s, comfortably longer than a deferred page's spinner.
_RESTORE_INTERVAL_MS = 75
_RESTORE_MAX_TRIES = 40


def build_scroll_restoration_js(path: str) -> str:
    """Return the inline ``<script>`` that restores scroll for ``path``.

    Pure (no NiceGUI context) so it can be unit-tested. ``path`` is JSON-encoded
    into the storage key so it is safe regardless of its characters.
    """
    key_literal = json.dumps(f"inv-scroll:{path}")
    return (
        "<script>(function(){"
        f"var key={key_literal};"
        "var target=parseFloat(sessionStorage.getItem(key)||'0');"
        "var restoring=target>0;"
        "window.addEventListener('scroll',function(){"
        "if(!restoring){sessionStorage.setItem(key,String(Math.round(window.scrollY)));}"
        "},{passive:true});"
        "if(restoring){var tries=0;var id=setInterval(function(){"
        "tries++;window.scrollTo(0,target);"
        "if(Math.abs(window.scrollY-target)<2){restoring=false;clearInterval(id);}"
        f"else if(tries>{_RESTORE_MAX_TRIES}){{restoring=false;clearInterval(id);}}"
        f"}},{_RESTORE_INTERVAL_MS});}}"
        "})();</script>"
    )


def install_scroll_restoration(path: str) -> None:  # pragma: no cover - needs UI context
    """Inject the scroll-restoration script into the current NiceGUI page."""
    from nicegui import ui  # noqa: PLC0415 - needs a NiceGUI page context

    ui.add_body_html(build_scroll_restoration_js(path))
