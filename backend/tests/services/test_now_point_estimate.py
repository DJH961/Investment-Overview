"""7.3.1: the graphs' Now dot sits on the twin-estimated book while a NAV is pending."""

from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace
from typing import Any

from investment_dashboard.services import metrics_service

D = Decimal


def _split(**kw: Any) -> Any:
    base: dict[str, Any] = {
        "estimated_funds": (),
        "value_now_eur": D(1000),
        "value_now_usd": D(1170),
        "overnight_eur": D(-10),
        "overnight_usd": D(0),
        "overnight_pct_eur": D("-0.01"),
        "overnight_pct_usd": None,
        "move_est_eur": None,
        "move_est_usd": None,
        "overnight_est_eur": None,
        "overnight_est_usd": None,
        "value_now_est_eur": None,
        "value_now_est_usd": None,
        "lead_eur": D(0),
        "lead_usd": D(0),
    }
    return SimpleNamespace(**(base | kw))


def test_official_book_without_an_estimate() -> None:
    v, night, pct, est = metrics_service.now_point_values(_split(), "EUR")
    assert (v, night, pct, est) == (D(1000), D(-10), D("-0.01"), False)


def test_estimated_book_matches_the_hero_and_its_own_base() -> None:
    # Hero (estimated): EUR 1,030 now; the session moved +20 and the rate -10 since
    # the close, so the previous-close base is 1,030 - 20 + 10 = 1,020.
    split = _split(
        estimated_funds=("FUNDX",),
        value_now_est_eur=D(1030),
        move_est_eur=D(20),
        overnight_est_eur=D(-10),
    )
    v, night, pct, est = metrics_service.now_point_values(split, "EUR")
    assert est is True
    assert v == D(1030)
    assert night == D(-10)
    assert pct == D(-10) / D(1020)
    # The growth's "close value" (v - night) is the estimated close at the close rate.
    assert v - night == D(1040)
