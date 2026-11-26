"""HICP in the cache tier: stored once a day, revised months overwritten (7.4 P10)."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.adapters.ecb_hicp import HicpMonth
from investment_dashboard.services import hicp_service

NOW = datetime(2026, 11, 25, 22, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _fresh() -> Iterator[None]:
    hicp_service.reset_for_tests()
    yield
    hicp_service.reset_for_tests()


class Fake:
    def __init__(self, months: list[HicpMonth] | None = None, *, fail: bool = False) -> None:
        self.months = months or []
        self.fail = fail
        self.calls: list[dict[str, Any]] = []

    def __call__(self, **kwargs: Any) -> list[HicpMonth]:
        self.calls.append(kwargs)
        if self.fail:
            raise RuntimeError("ECB down")
        return self.months


def test_first_fetch_reads_the_whole_history_then_only_recent_months(session: Session) -> None:
    fake = Fake([HicpMonth("2026-09", Decimal("104.32")), HicpMonth("2026-10", Decimal("104.8"))])
    assert hicp_service.refresh(session, fetcher=fake, now=NOW) == 2
    assert fake.calls[-1] == {"start_month": hicp_service.FIRST_MONTH}
    assert hicp_service.get_index(session) == {
        "2026-09": Decimal("104.3200"),
        "2026-10": Decimal("104.8000"),
    }
    # A revision of a month already stored overwrites it.
    fake.months = [HicpMonth("2026-10", Decimal("104.9"))]
    hicp_service.refresh(session, fetcher=fake, now=NOW)
    assert fake.calls[-1] == {"start_month": "2025-10"}
    assert hicp_service.get_index(session)["2026-10"] == Decimal("104.9000")


def test_is_due_once_per_utc_day(session: Session) -> None:
    assert hicp_service.is_due(session, now=NOW)
    hicp_service.refresh(session, fetcher=Fake([HicpMonth("2026-10", Decimal(1))]), now=NOW)
    assert not hicp_service.is_due(session, now=NOW)
    assert hicp_service.is_due(session, now=datetime(2026, 11, 26, 1, 0, tzinfo=UTC))


def test_refresh_if_due_calls_the_ecb_at_most_once_a_day(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    from contextlib import contextmanager

    @contextmanager
    def scope() -> Iterator[Session]:
        yield session

    monkeypatch.setattr("investment_dashboard.db.cache_session_scope", scope)
    fake = Fake(fail=True)
    assert hicp_service.refresh_if_due(fetcher=fake, now=NOW) is False  # a failed step
    assert hicp_service.refresh_if_due(fetcher=fake, now=NOW) is True  # not retried today
    assert len(fake.calls) == 1
    ok = Fake([HicpMonth("2026-10", Decimal("104.8"))])
    later = datetime(2026, 11, 26, 22, 0, tzinfo=UTC)
    assert hicp_service.refresh_if_due(fetcher=ok, now=later) is True
    assert hicp_service.refresh_if_due(fetcher=ok, now=later) is True
    assert len(ok.calls) == 1
    assert hicp_service.get_index(session) == {"2026-10": Decimal("104.8000")}
