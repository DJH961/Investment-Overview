"""``GET /api/overview`` currency box rate stats vs the NiceGUI currency box (parity).

The golden values are the figures the Python page's ``_currency_box_html`` prints
for the same metrics, anchors and clock, so the v6 payload provably shows the
same regime-aware numbers and labels.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from decimal import Decimal
from types import SimpleNamespace

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.readmodels import fx_effect
from investment_dashboard.readmodels import overview as overview_rm
from investment_dashboard.services import fx_service, intraday_snapshots_service

D = Decimal
LIVE, PREV, OPEN, CLOSE = D("1.20"), D("1.25"), D("1.22"), D("1.21")

MARKET_OPEN = datetime(2026, 10, 28, 15, 0, tzinfo=UTC)  # Wed 11:00 ET
AFTER_CLOSE = datetime(2026, 10, 28, 22, 0, tzinfo=UTC)  # Wed 18:00 ET
SATURDAY = datetime(2026, 10, 31, 15, 0, tzinfo=UTC)  # forex frozen, Fri was yesterday
SUNDAY_FROZEN = datetime(2026, 11, 1, 15, 0, tzinfo=UTC)  # forex frozen, Fri two days ago
SUNDAY_SPILL = datetime(2026, 11, 1, 23, 30, tzinfo=UTC)  # forex reopened, US shut
HOLIDAY = datetime(2026, 7, 3, 15, 0, tzinfo=UTC)  # US holiday (observed), forex trades

ALL = [MARKET_OPEN, AFTER_CLOSE, SATURDAY, SUNDAY_FROZEN, SUNDAY_SPILL, HOLIDAY]


def _metrics() -> SimpleNamespace:
    return SimpleNamespace(
        daily_growth_fx_eur_usd=LIVE,
        daily_growth_fx_eur_usd_prev=PREV,
        total_value_usd=D("10000"),
    )


@pytest.fixture(autouse=True)
def _anchors(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(intraday_snapshots_service, "session_open_fx", lambda *_a, **_k: OPEN)
    monkeypatch.setattr(intraday_snapshots_service, "session_close_fx", lambda *_a, **_k: CLOSE)
    monkeypatch.setattr(fx_service, "eur_quote_as_of", lambda *_a, **_k: None)


def _view(session: Session, now: datetime, ccy: str) -> dict[str, object]:
    return overview_rm._today_fx_view(
        session,
        _metrics(),  # type: ignore[arg-type]
        ccy=ccy,
        regime=fx_effect.fx_box_regime(now),
        now=now,
        tz=UTC,
    )


_STAT = re.compile(
    r'inv-fx-box-stat-label">([^<]+)</span>'
    r'<span class="inv-fx-box-stat-value[^"]*">([^<]+)</span>'
    r'(?:<span class="inv-fx-box-stat-sub">([^<]+)</span>)?'
)


def _python_box(session: Session, now: datetime, ccy: str) -> list[tuple[str, str, str]]:
    from investment_dashboard.ui.pages import overview as page

    html = page._currency_box_html(session, _metrics(), display_ccy=ccy, now=now, tz=UTC)
    assert html is not None
    return [(m[0], m[1], m[2] or "") for m in _STAT.findall(html)]


def _fmt(pct: object) -> str:
    """The page's ``_fx_box_pct_value`` text for an API fraction."""
    value = D(str(pct)) * 100
    sign = "+" if value >= 0 else chr(0x2212)  # the page's minus sign
    return f"{sign}{abs(value):.2f}%"


_LABEL = {"today": "Today", "yesterday": "Yesterday"}
_SUB = {
    "prev_close": "since last close",
    "overnight": "overnight",
    "session_open": "since last open",
}


@pytest.mark.parametrize("ccy", ["EUR", "USD"])
@pytest.mark.parametrize("now", ALL)
def test_parity_with_python_currency_box(session: Session, now: datetime, ccy: str) -> None:
    view = _view(session, now, ccy)
    stats = _python_box(session, now, ccy)

    pair_label, pair_value, _ = stats[0]
    assert pair_label == view["pair"]
    assert pair_value == f"{D(str(view['spot_display'])):,.4f}"

    move = view["move"]
    assert isinstance(move, dict)
    label, value, sub = stats[1]
    expected_label = _LABEL.get(move["label_kind"]) or datetime.fromisoformat(
        move["session_date"]
    ).strftime("%A")
    assert label == expected_label
    assert value == _fmt(move["pct"])
    assert sub == _SUB[move["anchor_kind"]]

    since = view["since"]
    if since is None:
        assert len(stats) == 2  # single overnight: no second stat
    else:
        assert isinstance(since, dict)
        since_label, since_value, _ = stats[2]
        assert since_label == ("Since open" if since["kind"] == "open" else "Since close")
        assert since_value == _fmt(since["pct"])


def test_eur_and_usd_moves_have_opposite_signs(session: Session) -> None:
    eur, usd = _view(session, MARKET_OPEN, "EUR"), _view(session, MARKET_OPEN, "USD")
    eur_pct = D(str(eur["move"]["pct"]))  # type: ignore[index]
    usd_pct = D(str(usd["move"]["pct"]))  # type: ignore[index]
    # EUR weakened 1.25 -> 1.20: the euro is down in USD display, the dollar up in EUR.
    assert usd_pct == (LIVE - PREV) / PREV
    assert eur_pct == -usd_pct
    assert usd["pair"] == "EUR/USD"
    assert eur["pair"] == "USD/EUR"
    assert D(str(eur["spot_display"])) == 1 / LIVE


@pytest.mark.parametrize(
    ("now", "anchor", "label", "since", "phrase"),
    [
        (MARKET_OPEN, "prev_close", "today", "open", "since_yesterday"),
        (AFTER_CLOSE, "session_open", "today", "close", "since_yesterday"),
        (SATURDAY, "session_open", "yesterday", "close", "yesterday"),
        (SUNDAY_FROZEN, "session_open", "weekday", "close", "on_day"),
        (SUNDAY_SPILL, "session_open", "today", "close", "since_day"),
        (HOLIDAY, "overnight", "today", None, "since_yesterday"),
    ],
)
def test_regime_kinds(
    session: Session,
    now: datetime,
    anchor: str,
    label: str,
    since: str | None,
    phrase: str,
) -> None:
    view = _view(session, now, "EUR")
    move = view["move"]
    assert isinstance(move, dict)
    assert move["anchor_kind"] == anchor
    assert move["label_kind"] == label
    assert (view["since"] or {}).get("kind") == since  # type: ignore[attr-defined]
    phrase_view = view["since_phrase"]
    assert isinstance(phrase_view, dict)
    assert phrase_view["kind"] == phrase
    assert view["anchor_missing"] is False


def test_anchor_missing_when_session_open_not_captured(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(intraday_snapshots_service, "session_open_fx", lambda *_a, **_k: None)
    view = _view(session, AFTER_CLOSE, "EUR")
    assert view["anchor_missing"] is True
    assert view["move"]["pct"] is None  # type: ignore[index]


def test_no_spot_means_no_rate_stats(session: Session) -> None:
    metrics = SimpleNamespace(
        daily_growth_fx_eur_usd=None, daily_growth_fx_eur_usd_prev=None, total_value_usd=None
    )
    view = overview_rm._today_fx_view(
        session,
        metrics,  # type: ignore[arg-type]
        ccy="EUR",
        regime=fx_effect.fx_box_regime(MARKET_OPEN),
        now=MARKET_OPEN,
        tz=UTC,
    )
    assert view["move"] is None
    assert view["pair"] is None
    assert view["since_phrase"] is not None
