"""The short-lived API read cache: hits, invalidation, auth still enforced."""

from __future__ import annotations

from investment_dashboard.services import live_bus, read_cache


def test_cached_read_hits_until_invalidated() -> None:
    calls: list[str] = []

    @read_cache.cached_read
    def endpoint(session: object, ccy: str = "EUR") -> str:
        calls.append(ccy)
        return f"value-{ccy}-{len(calls)}"

    assert endpoint(session=object(), ccy="EUR") == "value-EUR-1"
    assert endpoint(session=object(), ccy="EUR") == "value-EUR-1"  # session ignored in the key
    assert endpoint(session=object(), ccy="USD") == "value-USD-2"
    read_cache.invalidate()
    assert endpoint(session=object(), ccy="EUR") == "value-EUR-3"


def test_live_event_drops_the_cache() -> None:
    @read_cache.cached_read
    def endpoint(ccy: str = "EUR") -> int:
        return read_cache.size()

    endpoint(ccy="EUR")
    assert read_cache.size() == 1
    live_bus.bus.publish({"type": "tick"})
    assert read_cache.size() == 0


def test_answer_computed_across_an_invalidation_is_not_stored() -> None:
    @read_cache.cached_read
    def endpoint(ccy: str = "EUR") -> str:
        read_cache.invalidate()  # data changed while we were computing
        return ccy

    endpoint(ccy="EUR")
    assert read_cache.size() == 0
