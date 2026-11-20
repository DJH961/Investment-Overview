"""Consistency guard: one currency figure, one anchor, whichever view or page shows it.

The EUR currency effect, the USD investing power (Overview card) and the Currency page's
"buys" block describe the same rate move. They must use the same anchors (previous
close, session open, session close) in every regime, and a missing session sample must
not drop the market-hours / overnight split that the hero still shows (the hero's open
rate falls back to the ECB fixing dated on the session day).
"""

from __future__ import annotations

from dataclasses import asdict
from datetime import UTC, datetime
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.readmodels import currency as currency_rm
from investment_dashboard.readmodels import fx_effect
from investment_dashboard.services import (
    fx_service,
    intraday_snapshots_service,
    metrics_service,
)

D = Decimal
USD_BOOK = D("10000")
AMOUNT = D("500")
LIVE, PREV, OPEN, CLOSE = D("1.20"), D("1.25"), D("1.22"), D("1.21")

MARKET_OPEN = datetime(2026, 10, 28, 15, 0, tzinfo=UTC)  # Wed 11:00 ET
AFTER_CLOSE = datetime(2026, 10, 28, 22, 0, tzinfo=UTC)  # Wed 18:00 ET
WEEKEND = datetime(2026, 10, 31, 15, 0, tzinfo=UTC)  # Saturday, forex shut
SPLIT_REGIMES = [MARKET_OPEN, AFTER_CLOSE, WEEKEND]


def _metrics() -> SimpleNamespace:
    return SimpleNamespace(total_value_usd=USD_BOOK, daily_growth_fx_eur_usd_prev=PREV)


@pytest.fixture(autouse=True)
def _book(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(intraday_snapshots_service, "session_open_fx", lambda *_a, **_k: OPEN)
    monkeypatch.setattr(intraday_snapshots_service, "session_close_fx", lambda *_a, **_k: CLOSE)

    def _reval(_s: object, _on: object, *, fx_from: Decimal, fx_to: Decimal, book: object = None):
        return USD_BOOK / fx_to - USD_BOOK / fx_from, D(0)

    monkeypatch.setattr(metrics_service, "fx_revaluation", _reval)


def _anchor_of_eur_leg(leg: Decimal) -> Decimal:
    """The rate a EUR leg of the USD book was measured from."""
    return 1 / (1 / LIVE - leg / USD_BOOK)


def _anchor_of_usd_leg(leg: Decimal) -> Decimal:
    """The rate an investing-power leg was measured from."""
    return LIVE - leg / AMOUNT


@pytest.mark.parametrize("now", SPLIT_REGIMES)
def test_effect_and_investing_power_share_every_anchor(session: Session, now: datetime) -> None:
    eur = fx_effect.compute_eur_fx_effect(
        session,
        _metrics(),  # type: ignore[arg-type]
        live_fx=LIVE,
        prev_fx=PREV,
        now=now,
    )
    power = fx_effect.compute_investing_power(
        session,
        _metrics(),  # type: ignore[arg-type]
        amount_eur=AMOUNT,
        live_fx=LIVE,
        now=now,
    )
    assert eur is not None
    assert power is not None
    assert _anchor_of_eur_leg(eur.net_eur) == PREV
    assert _anchor_of_usd_leg(power.net_usd) == PREV  # same net anchor in both views
    assert eur.market_hours_eur is not None
    assert eur.overnight_eur is not None
    assert power.market_hours_usd is not None
    assert power.overnight_usd is not None
    # Both legs of both views split at the same instant.
    eur_split = _anchor_of_eur_leg(
        eur.market_hours_eur if now == MARKET_OPEN else eur.overnight_eur
    )
    usd_split = _anchor_of_usd_leg(
        power.market_hours_usd if now == MARKET_OPEN else power.overnight_usd
    )
    assert eur_split == usd_split
    assert eur.market_hours_eur + eur.overnight_eur == eur.net_eur
    assert power.market_hours_usd + power.overnight_usd == power.net_usd


@pytest.mark.parametrize("now", SPLIT_REGIMES)
def test_currency_page_buys_copy_the_overview_card(session: Session, now: datetime) -> None:
    power = fx_effect.compute_investing_power(
        session,
        _metrics(),  # type: ignore[arg-type]
        amount_eur=AMOUNT,
        live_fx=LIVE,
        now=now,
    )
    assert power is not None
    today: dict[str, Any] = {
        "spot": str(LIVE),
        "prev": str(PREV),
        "regime": asdict(fx_effect.fx_box_regime(now)),
        "investing_power_usd": {
            "amount_eur": str(AMOUNT),
            "amount_usd": str(AMOUNT * LIVE),
            "net": str(power.net_usd),
            "market_hours": str(power.market_hours_usd),
            "overnight": str(power.overnight_usd),
        },
    }
    buys = currency_rm._buys(session, today, now=now)
    assert buys is not None
    card = today["investing_power_usd"]
    assert D(buys["change_usd"]) == D(card["net"])
    assert D(buys["market_hours_usd"]) == D(card["market_hours"])
    assert D(buys["overnight_usd"]) == D(card["overnight"])


@pytest.mark.parametrize("now", [MARKET_OPEN, AFTER_CLOSE])
def test_missing_session_sample_keeps_the_split_like_the_hero(
    session: Session, monkeypatch: pytest.MonkeyPatch, now: datetime
) -> None:
    """No stored sample: the hero still splits (ECB fixing of the session day); so does the box."""
    monkeypatch.setattr(intraday_snapshots_service, "session_open_fx", lambda *_a, **_k: None)
    monkeypatch.setattr(intraday_snapshots_service, "session_close_fx", lambda *_a, **_k: CLOSE)
    monkeypatch.setattr(fx_service, "get_settled_rate_on", lambda *_a, **_k: OPEN)
    assert intraday_snapshots_service.day_open_rate(session, now=now) == OPEN  # the hero's anchor
    eur = fx_effect.compute_eur_fx_effect(
        session,
        _metrics(),  # type: ignore[arg-type]
        live_fx=LIVE,
        prev_fx=PREV,
        now=now,
    )
    power = fx_effect.compute_investing_power(
        session,
        _metrics(),  # type: ignore[arg-type]
        amount_eur=AMOUNT,
        live_fx=LIVE,
        now=now,
    )
    assert eur is not None
    assert power is not None
    if now == MARKET_OPEN:
        # Market hours = open -> now, and last night's leg survives (it is not folded in).
        assert eur.market_hours_eur == USD_BOOK / LIVE - USD_BOOK / OPEN
        assert eur.overnight_eur is not None
        assert power.market_hours_usd == AMOUNT * (LIVE - OPEN)
        assert power.overnight_usd is not None
