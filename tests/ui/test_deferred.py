"""Contract tests for the ``deferred`` spinner-then-build helper.

``deferred`` runs inside a live NiceGUI client/timer context, so its rendering
behaviour is exercised by the app rather than unit-tested here. These lock in
its *public signature* — specifically the off-thread ``compute`` hook that keeps
heavy work off the event loop — so call sites (overview, etc.) keep working.
"""

from __future__ import annotations

import inspect

from investment_dashboard.ui.components import deferred


def test_deferred_exposes_offthread_compute_hook() -> None:
    sig = inspect.signature(deferred)
    params = sig.parameters
    assert "build" in params
    # The resilience hook: optional, keyword-only, defaulting to None so every
    # existing call site (no compute) keeps its simple on-loop behaviour.
    compute = params.get("compute")
    assert compute is not None
    assert compute.kind is inspect.Parameter.KEYWORD_ONLY
    assert compute.default is None


def test_deferred_runs_offthread_via_run_io_bound() -> None:
    # The whole point of the compute hook is to push work to a worker thread
    # (nicegui.run.io_bound) so the loop stays responsive; guard that wiring.
    src = inspect.getsource(deferred)
    assert "run.io_bound(compute)" in src
