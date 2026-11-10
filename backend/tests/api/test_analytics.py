"""``/api/analytics`` route."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _offline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "investment_dashboard.adapters.yfinance_client.fetch_latest_close", lambda _s: None
    )


def test_analytics_empty_db_is_all_null_not_error(api_client: TestClient) -> None:
    res = api_client.get("/api/analytics?lookback_days=7")
    assert res.status_code == 200
    body = res.json()
    assert body["ccy"] == "EUR"
    assert body["cagr"] is None
    assert body["attribution"] == []
    assert body["attribution_currency"] == "EUR"


def test_analytics_usd_attribution_is_in_usd(api_client: TestClient) -> None:
    body = api_client.get("/api/analytics?ccy=USD&lookback_days=7").json()
    assert body["ccy"] == "USD"
    assert body["currency"] == "USD"
    assert body["attribution"] == []
    assert body["attribution_currency"] == "USD"


def test_analytics_validates_params(api_client: TestClient) -> None:
    assert api_client.get("/api/analytics?lookback_days=-1").status_code == 422
    assert api_client.get("/api/analytics?ccy=XXX").status_code == 422


def test_analytics_empty_exposes_zero_attribution_total(api_client: TestClient) -> None:
    body = api_client.get("/api/analytics?lookback_days=7").json()
    assert body["benchmark_diff"] is None
    assert body["benchmark_diff_pct"] is None
    assert body["attribution_total"]["absolute_pnl"] == "0"


def test_summary_fields_benchmark_gap_and_total_match_rows() -> None:
    from datetime import date
    from decimal import Decimal
    from types import SimpleNamespace

    from investment_dashboard.readmodels.analytics import _summary_fields

    def pt(d: int, pv: str, net: str, bench: str | None) -> SimpleNamespace:
        return SimpleNamespace(
            date=date(2026, 1, d),
            portfolio_value=Decimal(pv),
            cumulative_contributions=Decimal(net),
            benchmark_value=Decimal(bench) if bench else None,
        )

    def row(pnl: str) -> SimpleNamespace:
        return SimpleNamespace(
            start_value=Decimal(10),
            end_value=Decimal(10) + Decimal(pnl),
            net_contribution=Decimal(0),
            absolute_pnl=Decimal(pnl),
        )

    bundle = SimpleNamespace(
        curve=[pt(1, "100", "100", "100"), pt(2, "110", "100", "100"), pt(3, "120", "100", None)],
        attribution=[row("3.5"), row("-1")],
    )
    out = _summary_fields(bundle)  # type: ignore[arg-type]
    assert out["benchmark_last_value"] == "100"
    assert out["benchmark_diff"] == "20"
    assert out["benchmark_diff_pct"] == "0.2"
    assert out["portfolio_last_value"] == "120"
    total = out["attribution_total"]
    assert total["absolute_pnl"] == "2.5"
    assert total["start_value"] == "20"


def test_all_time_lookback_starts_at_first_transaction() -> None:
    from datetime import date
    from types import SimpleNamespace
    from unittest.mock import patch

    from investment_dashboard.readmodels import analytics as rm

    as_of = date(2026, 6, 30)
    with patch.object(
        rm.transactions_repo, "earliest_transaction_date", return_value=date(2021, 3, 1)
    ):
        assert (
            rm.resolve_lookback(SimpleNamespace(), rm.ALL_TIME, as_of)
            == (as_of - date(2021, 3, 1)).days
        )
        assert rm.resolve_lookback(SimpleNamespace(), 365, as_of) == 365
    with patch.object(rm.transactions_repo, "earliest_transaction_date", return_value=None):
        assert rm.resolve_lookback(SimpleNamespace(), rm.ALL_TIME, as_of) == 1


def test_all_time_lookback_on_empty_ledger_is_ok(api_client: TestClient) -> None:
    assert api_client.get("/api/analytics/both?lookback_days=0").status_code == 200
