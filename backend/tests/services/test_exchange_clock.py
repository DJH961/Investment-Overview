"""Server code keys "today" off the New-York exchange day, not the host clock."""

from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.services import fx_service


def test_exchange_day_lags_utc_after_midnight() -> None:
    assert exchange_today(datetime(2026, 11, 1, 1, 0, tzinfo=UTC)) == date(2026, 10, 31)


def test_live_overlay_uses_exchange_day(session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    et_day = date(2026, 10, 31)
    monkeypatch.setattr(fx_service, "exchange_today", lambda *a, **k: et_day)
    fx_service.set_live_spot("USD", Decimal("1.2345"), observed_on=et_day)
    rates = fx_service.get_rates(session)
    assert rates[et_day] == Decimal("1.2345")
