"""FX-history provider fallback (parity plan item 3).

Per-day week-base FX history is sourced from Frankfurter/ECB, the sole source of
record. When that fixing errors or returns nothing, a single budget-gated Tiingo
reading gap-fills today's tip (mirroring the *live*-spot pattern), with the
cached/stale rate as the final floor. The gap-fill row is provider-tagged so the
boot purge reclaims the date once ECB recovers.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

from sqlalchemy import select
from sqlalchemy.orm import Session

from investment_dashboard.adapters.frankfurter_client import FrankfurterError
from investment_dashboard.models import FxHistory
from investment_dashboard.repositories import fx_repo
from investment_dashboard.services import fx_service


def _source(session: Session, on: date) -> str | None:
    stmt = select(FxHistory.source).where(
        FxHistory.date == on, FxHistory.base == "EUR", FxHistory.quote == "USD"
    )
    return session.scalars(stmt).one_or_none()


class TestTiingoTodayFallback:
    def test_fills_today_from_tiingo(self, session: Session) -> None:
        written = fx_service._refresh_single_quote_fallback(
            session,
            today=date(2024, 6, 5),
            base="EUR",
            quote="USD",
            tiingo_fetcher=lambda: SimpleNamespace(
                rate=Decimal("1.115"), value_date=date(2024, 6, 5)
            ),
            tiingo_token="tok",
            charge_budget=lambda: True,
        )
        session.flush()
        assert fx_repo.get_rates(session)[date(2024, 6, 5)] == Decimal("1.115")
        assert _source(session, date(2024, 6, 5)) == "tiingo"
        assert written == 1

    def test_skips_tiingo_when_budget_exhausted(self, session: Session) -> None:
        calls = {"n": 0}

        def fetcher():  # type: ignore[no-untyped-def]
            calls["n"] += 1
            return SimpleNamespace(rate=Decimal("1.11"), value_date=date(2024, 6, 5))

        written = fx_service._refresh_single_quote_fallback(
            session,
            today=date(2024, 6, 5),
            base="EUR",
            quote="USD",
            tiingo_fetcher=fetcher,
            tiingo_token="tok",
            charge_budget=lambda: False,
        )
        session.flush()
        assert calls["n"] == 0  # the budget gate blocked the call
        assert fx_repo.get_rates(session) == {}
        assert written == 0

    def test_skips_tiingo_without_a_token(self, session: Session) -> None:
        written = fx_service._refresh_single_quote_fallback(
            session,
            today=date(2024, 6, 5),
            base="EUR",
            quote="USD",
            tiingo_fetcher=lambda: SimpleNamespace(
                rate=Decimal("1.11"), value_date=date(2024, 6, 5)
            ),
            tiingo_token="",  # vanilla install — no Tiingo backup
            charge_budget=lambda: True,
        )
        session.flush()
        assert fx_repo.get_rates(session) == {}
        assert written == 0

    def test_rejects_a_stale_tiingo_reading(self, session: Session) -> None:
        written = fx_service._refresh_single_quote_fallback(
            session,
            today=date(2024, 6, 5),
            base="EUR",
            quote="USD",
            tiingo_fetcher=lambda: SimpleNamespace(
                rate=Decimal("1.11"),
                value_date=date(2024, 6, 4),  # yesterday — stale
            ),
            tiingo_token="tok",
            charge_budget=lambda: True,
        )
        session.flush()
        assert fx_repo.get_rates(session) == {}
        assert written == 0


class TestRefreshIntegration:
    def test_frankfurter_error_engages_tiingo_via_refresh(self, session: Session) -> None:
        with (
            patch.object(fx_service, "fetch_rates", side_effect=FrankfurterError("ECB down")),
            patch.object(
                fx_service,
                "_fallback_today_via_tiingo",
                return_value=Decimal("1.12"),
            ),
        ):
            written = fx_service.refresh_fx_history(
                session, earliest_needed=date(2024, 6, 5), today=date(2024, 6, 5), quote="USD"
            )
        session.flush()
        assert fx_repo.get_rates(session)[date(2024, 6, 5)] == Decimal("1.12")
        assert _source(session, date(2024, 6, 5)) == "tiingo"
        assert written == 1

    def test_frankfurter_success_does_not_touch_fallback(self, session: Session) -> None:
        records = [SimpleNamespace(date=date(2024, 6, 5), rate=Decimal("1.09"))]
        with (
            patch.object(fx_service, "fetch_rates", return_value=records),
            patch.object(
                fx_service,
                "_fallback_today_via_tiingo",
                side_effect=AssertionError("fallback must not be consulted on success"),
            ),
        ):
            fx_service.refresh_fx_history(
                session, earliest_needed=date(2024, 6, 5), today=date(2024, 6, 5), quote="USD"
            )
        session.flush()
        assert _source(session, date(2024, 6, 5)) == "frankfurter"
