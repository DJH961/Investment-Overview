"""Graph reload resolution, 1W reload coverage and the import-time intraday wipe."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.repositories import app_config_repo, intraday_repo
from investment_dashboard.services import intraday_snapshots_service as iss
from investment_dashboard.services import settings_registry as reg

TODAY = date(2024, 6, 5)  # a Wednesday


def test_setting_is_registered_in_data_refresh() -> None:
    d = reg.BY_KEY[iss.RELOAD_INTERVAL_KEY]
    assert d.section == "data_refresh"
    assert d.default == iss.RELOAD_INTERVAL_AUTO
    assert set(d.choices or ()) == {"auto", "1m", "2m", "5m"}


def test_auto_follows_the_live_cadence(session: Session) -> None:
    assert iss.desired_reload_interval(session) == "1m"  # default 60 s
    app_config_repo.set_value(session, "live_refresh_interval_seconds", "120")
    assert iss.desired_reload_interval(session) == "2m"
    app_config_repo.set_value(session, "live_refresh_interval_seconds", "600")
    assert iss.desired_reload_interval(session) == "5m"
    app_config_repo.set_value(session, iss.RELOAD_INTERVAL_KEY, "2m")
    assert iss.desired_reload_interval(session) == "2m"


def test_effective_interval_respects_yfinance_age_limits() -> None:
    assert iss.effective_interval("1m", TODAY - timedelta(days=3), TODAY) == "1m"
    assert iss.effective_interval("1m", TODAY - timedelta(days=10), TODAY) == "2m"
    assert iss.effective_interval("1m", TODAY - timedelta(days=90), TODAY) == "5m"
    assert iss.effective_interval("5m", TODAY - timedelta(days=1), TODAY) == "5m"
    assert iss.effective_interval("15m", TODAY - timedelta(days=1), TODAY) == "15m"


def test_interval_runs_split_one_minute_spans_and_ages() -> None:
    days = [date(2024, 5, 20), date(2024, 5, 31), date(2024, 6, 3), date(2024, 6, 5)]
    runs = iss._interval_runs(days, "1m", TODAY)
    assert runs == [
        ("2m", [date(2024, 5, 20)]),
        ("1m", [date(2024, 5, 31), date(2024, 6, 3), date(2024, 6, 5)]),
    ]
    # A 1m request never needs splitting: 1m days are all within a week of today.
    near = iss._interval_runs([date(2024, 5, 30), date(2024, 6, 5)], "1m", TODAY)
    assert [r[0] for r in near] == ["1m"]


def test_reload_coverage_demands_the_afternoon_and_small_gaps() -> None:
    day = date(2024, 6, 3)
    anchor = date(2024, 6, 5)
    now = datetime(2024, 6, 5, 20, tzinfo=UTC)
    open_utc = iss._session_open_utc(day)
    # One-minute points from the open until 13:30 ET (~ 62 % of the session).
    morning = [open_utc + timedelta(minutes=m) for m in range(0, 241)]
    assert iss._week_day_is_covered(day, anchor, now, morning)  # normal pass: span ok
    assert not iss._week_day_is_covered(
        day, anchor, now, morning, max_gap_seconds=180, check_tail=True
    )
    full = [open_utc + timedelta(minutes=m) for m in range(0, 391)]
    assert iss._week_day_is_covered(day, anchor, now, full, max_gap_seconds=180, check_tail=True)


def test_clear_week_samples_from_date_keeps_earlier_sessions(session: Session) -> None:
    mon = datetime(2024, 6, 3, 15, 0)
    tue = datetime(2024, 6, 4, 15, 0)
    wed = datetime(2024, 6, 5, 15, 0)
    for t in (mon, tue, wed):
        intraday_repo.insert_sample(session, t, Decimal("1000"))
    deleted = iss.clear_week_samples(session, from_date=date(2024, 6, 4))
    assert deleted == 2
    left = [r.captured_at for r in intraday_repo.list_in_range(session, mon, wed)]
    assert left == [mon]


def test_import_wipes_only_from_earliest_inserted_trade(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    from investment_dashboard.services import transaction_edit_service as edit

    seen: list[Any] = []
    monkeypatch.setattr(edit.snapshots_service, "invalidate_for_trade_dates", lambda *a, **k: 0)
    monkeypatch.setattr(
        edit.intraday_snapshots_service,
        "clear_week_samples",
        lambda s, **kw: seen.append(kw.get("from_date")) or 0,
    )
    edit._after_write(session, {date(2024, 6, 5), date(2024, 6, 4)})
    assert seen == [date(2024, 6, 4)]


class TestReloadFetch:
    @staticmethod
    def _run(
        session: Session,
        monkeypatch: pytest.MonkeyPatch,
        stored: list[datetime],
        interval: str,
    ) -> tuple[list[tuple[datetime, Decimal, Decimal | None]], list[tuple[str, date, date]]]:
        calls: list[tuple[str, date, date]] = []
        day = date(2024, 6, 3)
        bar_times = [datetime(2024, 6, 3, 14, 0) + timedelta(minutes=m) for m in range(0, 6)]
        for t in stored:
            intraday_repo.insert_sample(session, t, Decimal("1000"))

        class _Pos:
            class instrument:  # noqa: N801
                symbol = "VT"

        monkeypatch.setattr(iss, "exchange_today", lambda now=None: TODAY)
        monkeypatch.setattr(iss, "_priced_intraday_positions", lambda s, d: [_Pos()])
        monkeypatch.setattr(iss, "_is_usd_native", lambda p: False)
        monkeypatch.setattr(iss, "_usd_by_instant", lambda priced, bars, samples: {})
        monkeypatch.setattr(
            iss,
            "_build_week_day_samples",
            lambda s, d, priced, bars, fx: [(t, Decimal("1"), None) for t in bar_times],
        )
        from investment_dashboard.services import prices_service

        monkeypatch.setattr(prices_service, "via_provider_symbols", lambda s, f: f)

        def fetcher(symbols: list[str], a: date, b: date, *, interval: str) -> dict[str, Any]:
            calls.append((interval, a, b))
            return {"VT": {t: Decimal("1") for t in bar_times}}

        out = iss._fetch_and_persist_week_days(
            session,
            [day],
            TODAY,
            iss._session_start_utc(day),
            fetcher=fetcher,
            fx_fetcher=None,
            interval=interval,
        )
        return out, calls

    def test_reload_pulls_one_minute_bars_for_recent_days(
        self, session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        out, calls = self._run(session, monkeypatch, [], "1m")
        assert calls == [("1m", date(2024, 6, 3), date(2024, 6, 3))]
        assert len(out) == 6

    def test_stored_finer_points_are_not_replaced(
        self, session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Live points every minute 14:00-14:02 (30 s half-window at 1m): their own
        # slots are skipped and only the missing minutes are filled.
        stored = [datetime(2024, 6, 3, 14, m, 20) for m in range(0, 3)]
        out, _ = self._run(session, monkeypatch, stored, "1m")
        assert [t.minute for t, _, _ in out] == [3, 4, 5]
