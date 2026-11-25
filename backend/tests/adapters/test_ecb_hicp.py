"""The ECB HICP adapter, with mocked HTTP (plus one live check behind --run-network)."""

from __future__ import annotations

import functools
from decimal import Decimal

import httpx
import pytest
import respx

from investment_dashboard.adapters import ecb_hicp
from investment_dashboard.adapters.ecb_hicp import HicpError, fetch_index, parse_csv

URL = f"{ecb_hicp.BASE_URL}/HICP/M.U2.N.000000.4D0.INX"

CSV = (
    "KEY,FREQ,REF_AREA,TIME_PERIOD,OBS_VALUE,OBS_STATUS\n"
    "HICP.M.U2.N.000000.4D0.INX,M,U2,1990-01,,A\n"
    "HICP.M.U2.N.000000.4D0.INX,M,U2,2026-09,104.32,A\n"
    "HICP.M.U2.N.000000.4D0.INX,M,U2,2026-08,103.69,A\n"
    "HICP.M.U2.N.000000.4D0.INX,M,U2,2026-10,104.8,A\n"
)


@respx.mock
def test_fetch_parses_months_oldest_first_and_skips_blanks() -> None:
    route = respx.get(URL).mock(return_value=httpx.Response(200, text=CSV))
    months = fetch_index(start_month="2026-08")
    assert route.called
    params = route.calls.last.request.url.params
    assert params["startPeriod"] == "2026-08"
    assert params["format"] == "csvdata"
    assert [(m.month, m.value) for m in months] == [
        ("2026-08", Decimal("103.69")),
        ("2026-09", Decimal("104.32")),
        ("2026-10", Decimal("104.8")),
    ]


@respx.mock
def test_no_series_is_an_empty_list() -> None:
    respx.get(URL).mock(return_value=httpx.Response(404, json={"detail": "No Series"}))
    assert fetch_index(start_month="2030-01") == []


@respx.mock
def test_empty_body_is_an_empty_list() -> None:
    respx.get(URL).mock(return_value=httpx.Response(200, text=""))
    assert fetch_index() == []


@respx.mock
def test_server_error_raises_after_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    real = ecb_hicp.retry_call
    monkeypatch.setattr(ecb_hicp, "retry_call", functools.partial(real, sleep=lambda _s: None))
    route = respx.get(URL).mock(return_value=httpx.Response(503, text="down"))
    with pytest.raises(HicpError):
        fetch_index()
    assert route.call_count == ecb_hicp.DEFAULT_ATTEMPTS


@respx.mock
def test_client_error_raises() -> None:
    respx.get(URL).mock(return_value=httpx.Response(400, text="bad"))
    with pytest.raises(HicpError):
        fetch_index()


def test_bad_rows_raise() -> None:
    with pytest.raises(HicpError):
        parse_csv("A,B\n1,2\n")
    with pytest.raises(HicpError):
        parse_csv("TIME_PERIOD,OBS_VALUE\n2026-13,100\n")
    with pytest.raises(HicpError):
        parse_csv("TIME_PERIOD,OBS_VALUE\n2026-01,abc\n")
    with pytest.raises(HicpError):
        parse_csv("TIME_PERIOD,OBS_VALUE\n2026-01,-1\n")


def test_bad_start_month_is_rejected() -> None:
    with pytest.raises(ValueError, match="YYYY-MM"):
        fetch_index(start_month="2026-1")


@pytest.mark.network
def test_live_series_key_answers() -> None:
    months = fetch_index(start_month="2026-01")
    assert months, "the ECB HICP series returned nothing"
    assert months[0].month == "2026-01"
    # Base 2025 = 100: the 2026 values sit near 100.
    assert all(Decimal(90) < m.value < Decimal(130) for m in months)
