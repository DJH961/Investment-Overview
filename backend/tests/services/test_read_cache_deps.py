"""Per-dependency invalidation of the read cache and the live-bus mapping."""

from __future__ import annotations

import pytest

from investment_dashboard.services import read_cache
from investment_dashboard.services.live_bus import LiveBus


def _counted(deps: tuple[str, ...] = read_cache.ALL_DEPS):  # type: ignore[no-untyped-def]
    calls = {"n": 0}

    @read_cache.cached_read(deps=deps)
    def read(x: int = 0) -> int:
        calls["n"] += 1
        return calls["n"]

    return read, calls


def test_ledger_only_entry_survives_a_tick() -> None:
    read, calls = _counted((read_cache.LEDGER,))
    read()
    LiveBus().publish({"type": "tick"})
    read()
    assert calls["n"] == 1
    read_cache.invalidate(read_cache.LEDGER)
    read()
    assert calls["n"] == 2


def test_default_entry_reads_everything() -> None:
    read, calls = _counted()
    read()
    LiveBus().publish({"type": "fx"})
    read()
    assert calls["n"] == 2


@pytest.mark.parametrize(
    ("event_type", "bumped"),
    [
        ("tick", {"prices", "fx"}),
        ("fx", {"fx"}),
        ("graphs", {"prices"}),
        ("refresh", {"ledger", "prices", "fx"}),
        ("settings", {"ledger", "prices", "fx"}),
        ("refresh_started", {"ledger", "prices", "fx"}),
    ],
)
def test_event_bumps_only_what_changed(event_type: str, bumped: set[str]) -> None:
    before = dict(read_cache._gens)
    LiveBus().publish({"type": event_type})
    changed = {d for d in read_cache.ALL_DEPS if read_cache._gens[d] != before[d]}
    assert changed == bumped


def test_bare_invalidate_bumps_all() -> None:
    read, calls = _counted((read_cache.FX,))
    read()
    read_cache.invalidate()
    read()
    assert calls["n"] == 2
