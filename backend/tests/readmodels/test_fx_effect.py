"""The currency-box maths extracted from the NiceGUI overview page.

The expected figures are the formulas the page used inline before the
extraction (``usd / live - usd / anchor`` re-anchored per regime), recomputed
here from first principles, so the extraction provably changed no numbers.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from types import SimpleNamespace

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.readmodels import fx_effect
from investment_dashboard.services import intraday_snapshots_service

D = Decimal
USD = D("10000")
LIVE, PREV, OPEN, CLOSE = D("1.20"), D("1.25"), D("1.22"), D("1.21")

MARKET_OPEN = datetime(2026, 10, 28, 15, 0, tzinfo=UTC)  # Wed 11:00 ET
AFTER_CLOSE = datetime(2026, 10, 28, 22, 0, tzinfo=UTC)  # Wed 18:00 ET
WEEKEND = datetime(2026, 10, 31, 15, 0, tzinfo=UTC)  # Saturday, forex shut
HOLIDAY = datetime(2026, 7, 3, 15, 0, tzinfo=UTC)  # US holiday (observed), forex trades


def _metrics(prev: Decimal | None = PREV, usd: Decimal | None = USD) -> SimpleNamespace:
    return SimpleNamespace(total_value_usd=usd, daily_growth_fx_eur_usd_prev=prev)


@pytest.fixture(autouse=True)
def _anchors(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(intraday_snapshots_service, "session_open_fx", lambda *_a, **_k: OPEN)
    monkeypatch.setattr(intraday_snapshots_service, "session_close_fx", lambda *_a, **_k: CLOSE)


def _eur(anchor: Decimal) -> Decimal:
    return USD / LIVE - USD / anchor


def test_regimes() -> None:
    live = fx_effect.fx_box_regime(MARKET_OPEN)
    assert live.market_open
    assert live.session_view
    assert not live.forex_frozen
    closed = fx_effect.fx_box_regime(AFTER_CLOSE)
    assert not closed.market_open
    assert closed.forex_open
    assert closed.session_view
    frozen = fx_effect.fx_box_regime(WEEKEND)
    assert frozen.forex_frozen
    assert frozen.session_view
    assert not frozen.single_overnight
    holiday = fx_effect.fx_box_regime(HOLIDAY)
    assert holiday.holiday
    assert holiday.single_overnight
    assert not holiday.session_view


def test_eur_effect_market_open(session: Session) -> None:
    effect = fx_effect.compute_eur_fx_effect(
        session,
        _metrics(),
        live_fx=LIVE,
        prev_fx=PREV,
        now=MARKET_OPEN,  # type: ignore[arg-type]
    )
    assert effect is not None
    assert effect.net_eur == _eur(PREV)  # anchored to the settled previous close
    assert effect.market_hours_eur == _eur(OPEN)  # live leg: session open -> now
    assert effect.overnight_eur == effect.net_eur - _eur(OPEN)
    assert effect.market_hours_eur + effect.overnight_eur == effect.net_eur


@pytest.mark.parametrize("now", [AFTER_CLOSE, WEEKEND])
def test_eur_effect_closed_session_view_reanchors_to_open(session: Session, now: datetime) -> None:
    effect = fx_effect.compute_eur_fx_effect(
        session,
        _metrics(),
        live_fx=LIVE,
        prev_fx=PREV,
        now=now,  # type: ignore[arg-type]
    )
    assert effect is not None
    assert effect.net_eur == _eur(OPEN)  # "since last open", agrees with the box headline
    assert effect.overnight_eur == _eur(CLOSE)  # live leg: close -> now
    assert effect.market_hours_eur == effect.net_eur - _eur(CLOSE)


def test_eur_effect_holiday_is_a_single_number(session: Session) -> None:
    effect = fx_effect.compute_eur_fx_effect(
        session,
        _metrics(),
        live_fx=LIVE,
        prev_fx=PREV,
        now=HOLIDAY,  # type: ignore[arg-type]
    )
    assert effect is not None
    assert effect.net_eur == _eur(PREV)
    assert effect.market_hours_eur is None
    assert effect.overnight_eur is None


def test_eur_effect_falls_back_to_session_close_without_previous_close(session: Session) -> None:
    effect = fx_effect.compute_eur_fx_effect(
        session,
        _metrics(prev=None),
        live_fx=LIVE,
        prev_fx=None,
        now=MARKET_OPEN,  # type: ignore[arg-type]
    )
    assert effect is not None
    assert effect.net_eur == _eur(CLOSE)  # prior_fx() fell back to the session close


def test_eur_effect_absent_when_no_swing_or_no_usd_book(session: Session) -> None:
    flat = fx_effect.compute_eur_fx_effect(
        session,
        _metrics(prev=LIVE),
        live_fx=LIVE,
        prev_fx=LIVE,
        now=HOLIDAY,  # type: ignore[arg-type]
    )
    assert flat is None
    no_book = fx_effect.compute_eur_fx_effect(
        session,
        _metrics(usd=None),
        live_fx=LIVE,
        prev_fx=PREV,
        now=MARKET_OPEN,  # type: ignore[arg-type]
    )
    assert no_book is None


def test_investing_power_market_open(session: Session) -> None:
    amount = D("500")
    power = fx_effect.compute_investing_power(
        session,
        _metrics(),
        amount_eur=amount,
        live_fx=LIVE,
        now=MARKET_OPEN,  # type: ignore[arg-type]
    )
    assert power is not None
    assert power.net_usd == amount * (LIVE - PREV)
    assert power.market_hours_usd == amount * (LIVE - OPEN)
    assert power.overnight_usd == power.net_usd - power.market_hours_usd


def test_investing_power_closed_reanchors_to_open(session: Session) -> None:
    amount = D("500")
    power = fx_effect.compute_investing_power(
        session,
        _metrics(),
        amount_eur=amount,
        live_fx=LIVE,
        now=AFTER_CLOSE,  # type: ignore[arg-type]
    )
    assert power is not None
    assert power.net_usd == amount * (LIVE - OPEN)
    assert power.overnight_usd == amount * (LIVE - CLOSE)


def test_investing_power_none_without_anchor_or_swing(session: Session) -> None:
    same = fx_effect.compute_investing_power(
        session,
        _metrics(prev=LIVE),
        amount_eur=D("500"),
        live_fx=LIVE,
        now=HOLIDAY,  # type: ignore[arg-type]
    )
    assert same is None
