"""The historic re-download must report stage progress so the UI can paint a
determinate "downloading history…" bar — after a cache reset and on a long-idle
re-open alike. These tests pin the progress wiring without hitting the network.
"""

from __future__ import annotations

import pytest

from investment_dashboard import boot
from investment_dashboard.services import refresh_status

#: The stage helpers the deferred refresh runs, in order. Patched to no-ops (that
#: record the live progress snapshot) so the sequence runs offline.
_STAGE_ATTRS = (
    "_refresh_fx",
    "_backfill_transaction_legs",
    "_refresh_prices",
    "_refresh_live_fx",
    "_refresh_splits",
    "_refresh_benchmark",
    "_refresh_intraday_day",
    "_refresh_intraday_week",
    "_warm_snapshots",
)


@pytest.fixture(autouse=True)
def _reset_refresh_status() -> None:
    refresh_status.reset()
    yield
    refresh_status.reset()


def test_deferred_refresh_reports_progress_through_every_stage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[tuple[int, int, str | None, bool]] = []

    def _spy(_: str):
        def _run() -> None:
            snap = refresh_status.snapshot()
            seen.append(
                (snap.progress_done, snap.progress_total, snap.progress_label, snap.historical)
            )

        return _run

    for attr in _STAGE_ATTRS:
        monkeypatch.setattr(boot, attr, _spy(attr))

    boot.run_deferred_network_refresh()

    total = len(_STAGE_ATTRS)
    # Every stage saw the bar flagged historical, with its own label and the
    # not-yet-completed count for that stage (0,1,…,total-1).
    assert [done for done, _total, _label, _hist in seen] == list(range(total))
    assert all(t == total for _done, t, _label, _hist in seen)
    assert all(hist for *_rest, hist in seen)
    assert [label for _done, _total, label, _hist in seen] == [
        "Exchange rates",
        "Transaction history",
        "Prices",
        "Live FX",
        "Stock splits",
        "Benchmark",
        "Intraday (1 Day)",
        "Intraday (1 Week)",
        "Daily snapshots",
    ]


def test_full_history_refresh_wraps_activity_and_clears_progress(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(boot, "_history_is_stale", lambda: True)
    for attr in _STAGE_ATTRS:
        monkeypatch.setattr(boot, attr, lambda: None)

    assert boot.run_full_history_refresh("Cache reset re-download") is True

    snap = refresh_status.snapshot()
    # The wrapper finished: no longer active, progress cleared, and a fresh
    # "last update" stamped so the header chip reassures the user data landed.
    assert snap.active is False
    assert snap.historical is False
    assert snap.progress_total == 0
    assert snap.last_update_at is not None


def test_full_history_refresh_swallows_stage_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(boot, "_history_is_stale", lambda: True)

    def _boom() -> None:
        raise RuntimeError("network down")

    monkeypatch.setattr(boot, "_refresh_fx", _boom)
    for attr in _STAGE_ATTRS[1:]:
        monkeypatch.setattr(boot, attr, lambda: None)

    # A stage failure is recorded, not raised, and the activity state is cleared.
    assert boot.run_full_history_refresh("Cache reset re-download") is False
    snap = refresh_status.snapshot()
    assert snap.active is False
    assert snap.historical is False


def _historical_probe() -> tuple[list[bool], object]:
    """A ``(seen, probe)`` pair: ``probe`` is a no-op stage that records whether
    the determinate "downloading history…" bar was active when it ran."""
    seen: list[bool] = []

    def _probe() -> None:
        seen.append(refresh_status.snapshot().historical)

    return seen, _probe


def test_deferred_refresh_skips_bar_when_progress_not_shown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A routine catch-up runs every stage but never paints the determinate bar.
    seen: list[tuple[int, bool]] = []

    def _spy() -> None:
        snap = refresh_status.snapshot()
        seen.append((snap.progress_total, snap.historical))

    for attr in _STAGE_ATTRS:
        monkeypatch.setattr(boot, attr, _spy)

    boot.run_deferred_network_refresh(show_progress=False)

    assert len(seen) == len(_STAGE_ATTRS)
    assert all(total == 0 and not hist for total, hist in seen)


def test_full_history_refresh_skips_bar_for_a_fresh_cache(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Logging on after a trivial delay: the cache is fresh, so no bar pops up.
    monkeypatch.setattr(boot, "_history_is_stale", lambda: False)
    seen, _probe = _historical_probe()
    monkeypatch.setattr(boot, "_refresh_fx", _probe)
    for attr in _STAGE_ATTRS[1:]:
        monkeypatch.setattr(boot, attr, lambda: None)

    assert boot.run_full_history_refresh("Startup data refresh") is True
    assert seen == [False]


def test_full_history_refresh_shows_bar_when_history_is_stale(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A long absence (stale cache) is a large pull and gets the determinate bar.
    monkeypatch.setattr(boot, "_history_is_stale", lambda: True)
    seen, _probe = _historical_probe()
    monkeypatch.setattr(boot, "_refresh_fx", _probe)
    for attr in _STAGE_ATTRS[1:]:
        monkeypatch.setattr(boot, attr, lambda: None)

    assert boot.run_full_history_refresh("Startup data refresh") is True
    assert seen == [True]


def test_full_history_refresh_force_progress_overrides_fresh_cache(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A cache reset forces the bar even though the (wiped) cache would read fresh.
    monkeypatch.setattr(boot, "_history_is_stale", lambda: False)
    seen, _probe = _historical_probe()
    monkeypatch.setattr(boot, "_refresh_fx", _probe)
    for attr in _STAGE_ATTRS[1:]:
        monkeypatch.setattr(boot, attr, lambda: None)

    assert boot.run_full_history_refresh("Cache reset re-download", force_progress=True) is True
    assert seen == [True]


# --- the "large pull" gate shared by the expensive force-rebuild steps -------


def test_is_large_pull_prefers_override_then_probes(monkeypatch: pytest.MonkeyPatch) -> None:
    # During a deferred run the shared override wins; outside one it falls back to
    # the staleness probe.
    monkeypatch.setattr(boot, "_history_is_stale", lambda: False)
    boot._large_pull_state["override"] = True
    try:
        assert boot._is_large_pull() is True
    finally:
        boot._large_pull_state["override"] = None
    assert boot._is_large_pull() is False


def test_deferred_refresh_shares_large_pull_override(monkeypatch: pytest.MonkeyPatch) -> None:
    # The "large pull" decision (== show_progress) is exposed to every stage via
    # the shared override and cleared afterwards, so the gated steps force a full
    # rebuild only for a large pull.
    seen: list[bool | None] = []
    for attr in _STAGE_ATTRS:
        monkeypatch.setattr(boot, attr, lambda: seen.append(boot._large_pull_state["override"]))

    boot.run_deferred_network_refresh(show_progress=False)
    assert seen == [False] * len(_STAGE_ATTRS)
    assert boot._large_pull_state["override"] is None  # reset after the run

    seen.clear()
    boot.run_deferred_network_refresh(show_progress=True)
    assert seen == [True] * len(_STAGE_ATTRS)
    assert boot._large_pull_state["override"] is None


def test_warm_snapshots_routine_reopen_only_forces_recent_tail(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import contextlib
    from datetime import date, timedelta

    @contextlib.contextmanager
    def _fake_scope():  # type: ignore[no-untyped-def]
        yield object()

    monkeypatch.setattr("investment_dashboard.db.ledger_session_scope", _fake_scope)
    # A fixed, populated floor so the window is deterministic.
    floor = date.today() - timedelta(days=40)
    monkeypatch.setattr(boot, "_earliest_needed_date", lambda: floor)

    calls: list[tuple[date, date, bool]] = []
    monkeypatch.setattr(
        "investment_dashboard.services.snapshots_service.warm_range",
        lambda _s, a, b, *, force: calls.append((a, b, force)) or 0,
    )

    # Routine reopen: fill missing older days unforced, force only the recent tail.
    monkeypatch.setattr(boot, "_is_large_pull", lambda: False)
    boot._warm_snapshots()
    today = date.today()
    recent_floor = today - timedelta(days=boot._WARM_FORCE_RECENT_DAYS)
    assert calls == [
        (floor, recent_floor - timedelta(days=1), False),
        (recent_floor, today, True),
    ]

    # Large pull: a single force-recompute over the whole lifetime.
    calls.clear()
    monkeypatch.setattr(boot, "_is_large_pull", lambda: True)
    boot._warm_snapshots()
    assert calls == [(floor, today, True)]
