"""Tests for the live connection + navigation feedback layer.

These lock in the contract that other parts of the app (and the browser) rely
on: the injected CSS/markup/script must expose the stable element ids and must
attach to the real ``window.socket`` additively, and ``install`` must use
``shared=True`` so the snippets reach every ``@ui.page`` client (not just the
auto-index page).
"""

from __future__ import annotations

import pytest

from investment_dashboard.ui import connectivity


def test_css_defines_feedback_elements_and_hides_default_popup() -> None:
    css = connectivity._css()
    # The three visible affordances.
    assert "#inv-loadbar" in css
    assert "#inv-connbar" in css
    assert ".inv-conn-dot" in css
    # NiceGUI's delayed bottom-corner popup is suppressed in favour of the
    # immediate top banner.
    assert "#popup { display: none !important; }" in css


def test_body_html_exposes_stable_ids() -> None:
    body = connectivity._body_html()
    assert 'id="inv-loadbar"' in body
    assert 'id="inv-loadhint"' in body
    assert 'id="inv-connbar"' in body
    assert 'id="inv-connbar-text"' in body
    assert 'id="inv-connbar-reload"' in body


def test_stall_hint_is_wired_to_show_and_hide() -> None:
    css = connectivity._css()
    js = connectivity._script()
    assert "#inv-loadhint" in css
    # The 8s stall timer must actually reveal the hint, and a completed load
    # must hide it again (no dead reassurance code).
    assert "showHint(true)" in js
    assert "showHint(false)" in js


def test_script_attaches_to_socket_additively_and_guards_double_install() -> None:
    js = connectivity._script()
    # Real socket.io client + browser connectivity events.
    assert "window.socket" in js
    assert "s.on('disconnect'" in js
    assert "s.on('connect'" in js
    assert "reconnect_attempt" in js
    assert "addEventListener('offline'" in js
    # Navigation feedback must not clobber NiceGUI's window.onbeforeunload.
    assert "addEventListener('beforeunload'" in js
    assert "window.onbeforeunload" not in js
    # Idempotency guard so a second injection is a no-op in the browser.
    assert "__invFeedbackInstalled" in js


def test_header_dot_markup_has_id_and_default_ok_state() -> None:
    assert 'id="inv-conn-dot"' in connectivity.HEADER_DOT_HTML
    assert "is-ok" in connectivity.HEADER_DOT_HTML


def test_install_injects_shared_head_and_body(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str, bool]] = []

    def _fake_head(code: str, *, shared: bool = False) -> None:
        calls.append(("head", code, shared))

    def _fake_body(code: str, *, shared: bool = False) -> None:
        calls.append(("body", code, shared))

    from nicegui import ui

    monkeypatch.setattr(ui, "add_head_html", _fake_head)
    monkeypatch.setattr(ui, "add_body_html", _fake_body)

    connectivity.install()

    kinds = {kind for kind, _code, _shared in calls}
    assert kinds == {"head", "body"}
    # Both snippets must be shared so they reach every page client.
    assert all(shared is True for _kind, _code, shared in calls)
    head = next(code for kind, code, _ in calls if kind == "head")
    body = next(code for kind, code, _ in calls if kind == "body")
    assert "<style>" in head
    assert "#inv-loadbar" in head
    assert "inv-connbar" in body
    assert "<script>" in body
