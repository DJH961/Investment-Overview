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
        "Daily snapshots",
    ]


def test_full_history_refresh_wraps_activity_and_clears_progress(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
