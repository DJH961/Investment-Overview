"""``/both`` routes: EUR + USD in one response, plus conditional GET (weak ETag)."""

from __future__ import annotations

import time
from collections.abc import Iterator
from decimal import Decimal, InvalidOperation

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.db import ledger_session_scope
from investment_dashboard.services import read_cache

from ._seed import seed_ledger

#: (both path, single path) - the single route takes ``ccy`` as an extra query param.
ROUTES = [
    ("/api/overview/both", "/api/overview"),
    ("/api/holdings/both", "/api/holdings"),
    ("/api/holdings/both?group_by=none", "/api/holdings?group_by=none"),
    ("/api/graphs/1y/both", "/api/graphs/1y"),
    ("/api/graphs/1y/both?compare=false", "/api/graphs/1y?compare=false"),
    ("/api/periods/monthly/both", "/api/periods/monthly"),
    ("/api/periods/monthly/both?fill_gaps=true", "/api/periods/monthly?fill_gaps=true"),
    ("/api/periods/yearly/both", "/api/periods/yearly"),
    ("/api/allocations/both", "/api/allocations"),
    ("/api/analytics/both?lookback_days=90", "/api/analytics?lookback_days=90"),
    ("/api/calculator/both", "/api/calculator"),
    ("/api/deposits/both", "/api/deposits"),
    ("/api/deposits/both?kind=deposit", "/api/deposits?kind=deposit"),
    ("/api/deposits/dividends/both", "/api/deposits/dividends"),
]


@pytest.fixture
def seeded(api_db: object) -> Iterator[None]:
    with ledger_session_scope() as session:
        seed_ledger(session)
    return


def _strip(value: object) -> object:
    """Drop build timestamps and normalise decimal strings (``0`` == ``0.000000``)."""
    if isinstance(value, dict):
        return {k: _strip(v) for k, v in value.items() if k != "generated_at"}
    if isinstance(value, list):
        return [_strip(v) for v in value]
    if isinstance(value, str):
        try:  # "0" and "0.000000" are the same amount
            return Decimal(value).normalize()
        except InvalidOperation:
            return value
    return value


def _with_ccy(path: str, ccy: str) -> str:
    return f"{path}{'&' if '?' in path else '?'}ccy={ccy}"


@pytest.mark.parametrize(("both", "single"), ROUTES)
def test_both_sides_equal_single_routes(
    api_client: TestClient, seeded: None, both: str, single: str
) -> None:
    resp = api_client.get(both)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    for ccy in ("EUR", "USD"):
        single_resp = api_client.get(_with_ccy(single, ccy))
        assert single_resp.status_code == 200, single_resp.text
        assert _strip(body[ccy]) == _strip(single_resp.json())


def test_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.get("/api/overview/both").status_code == 401


@pytest.mark.parametrize(("both", "_single"), ROUTES)
def test_etag_gives_304_without_computing(
    api_client: TestClient, seeded: None, both: str, _single: str
) -> None:
    first = api_client.get(both)
    etag = first.headers["etag"]
    assert etag.startswith('W/"')
    again = api_client.get(both, headers={"If-None-Match": etag})
    assert again.status_code == 304
    assert again.headers["etag"] == etag
    assert again.content == b""


def test_304_skips_the_build(
    api_client: TestClient, seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    from investment_dashboard.readmodels import overview as overview_rm

    etag = api_client.get("/api/overview/both").headers["etag"]

    def boom(*args: object, **kwargs: object) -> None:
        raise AssertionError("build must not run on a 304")

    monkeypatch.setattr(overview_rm, "build_overview", boom)
    assert api_client.get("/api/overview/both", headers={"If-None-Match": etag}).status_code == 304


def test_etag_changes_with_params(api_client: TestClient, seeded: None) -> None:
    a = api_client.get("/api/holdings/both").headers["etag"]
    b = api_client.get("/api/holdings/both?group_by=category").headers["etag"]
    assert a != b


def test_etag_changes_on_tick_and_ledger_write(api_client: TestClient, seeded: None) -> None:
    etag = api_client.get("/api/overview/both").headers["etag"]
    read_cache.invalidate_for_event("tick")
    after_tick = api_client.get("/api/overview/both", headers={"If-None-Match": etag})
    assert after_tick.status_code == 200
    etag2 = after_tick.headers["etag"]
    assert etag2 != etag

    # A route that reads everything also changes on a ledger write.
    assert api_client.post("/api/diagnostics/problems/dismiss-all").status_code < 400
    after_write = api_client.get("/api/overview/both", headers={"If-None-Match": etag2})
    assert after_write.status_code == 200
    assert after_write.headers["etag"] not in {etag, etag2}


def test_both_costs_less_than_two_builds(api_client: TestClient, seeded: None) -> None:
    def timed(path: str) -> float:
        read_cache.invalidate()
        start = time.perf_counter()
        assert api_client.get(path).status_code == 200
        return time.perf_counter() - start

    timed("/api/overview?ccy=EUR")  # warm imports / lazy state
    single = min(timed("/api/overview?ccy=EUR") for _ in range(3))
    both = min(timed("/api/overview/both") for _ in range(3))
    assert both < 1.6 * single + 0.05  # loose: second build reuses the session's loads
