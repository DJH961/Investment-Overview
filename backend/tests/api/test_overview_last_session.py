"""Before the open the Overview day move is the last session's, not a flat 0 %.

One USD holding: 10 sh bought Fri 23 Oct 2026 at 100; closes Mon 100, Tue 110,
nothing yet for Wed. FX (USD per EUR) 1.10 up to Tue, 1.20 on Wed (live).
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

from investment_dashboard.db import ledger_session_scope
from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.readmodels.overview import build_overview
from investment_dashboard.repositories import accounts_repo, fx_repo, instruments_repo, prices_repo

D = Decimal
FRI, MON, TUE, WED = date(2026, 10, 23), date(2026, 10, 26), date(2026, 10, 27), date(2026, 10, 28)
ET = ZoneInfo("America/New_York")


def _seed(*, wed_close: Decimal | None = None) -> None:
    with ledger_session_scope() as s:
        acct = accounts_repo.create_account(
            s,
            broker="fidelity",
            account_label="Main",
            native_currency="USD",
            account_type="brokerage",
        )
        inst = instruments_repo.get_or_create(s, symbol="VTI", asset_class="etf")
        closes = {FRI: D("100"), MON: D("100"), TUE: D("110")}
        if wed_close is not None:
            closes[WED] = wed_close
        prices_repo.upsert_closes(s, inst.id, closes)
        fx_repo.upsert_rates(s, {FRI: D("1.10"), MON: D("1.10"), TUE: D("1.10"), WED: D("1.20")})
        legs = {"net_usd": D("-1000"), "net_eur": D("-909.09"), "fx_rate_to_eur": D("1.10")}
        s.add_all(
            [
                Transaction(
                    account_id=acct.id,
                    date=FRI,
                    kind="deposit",
                    source=TransactionSource.MANUAL,
                    net_native=D("1000"),
                    net_usd=D("1000"),
                    net_eur=D("909.09"),
                    fx_rate_to_eur=D("1.10"),
                ),
                Transaction(
                    account_id=acct.id,
                    date=FRI,
                    kind="buy",
                    source=TransactionSource.MANUAL,
                    instrument_id=inst.id,
                    quantity=D("10"),
                    price_native=D("100"),
                    net_native=D("-1000"),
                    **legs,
                ),
            ]
        )


def _at(hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 10, 28, hour, minute, tzinfo=ET).astimezone(UTC)


def test_pre_open_shows_last_session_move(api_db: Path) -> None:
    _seed()
    with ledger_session_scope() as s:
        usd = build_overview(s, ccy="USD", as_of=WED, now=_at(8))
        eur = build_overview(s, ccy="EUR", as_of=WED, now=_at(8))
    assert usd["kpis"]["daily_growth_as_of"] == TUE.isoformat()
    assert D(usd["kpis"]["daily_growth_pct"]) == D("0.1")
    assert D(usd["kpis"]["daily_move"]) == D("100")
    # EUR: the whole change since Monday's close, each mark at its own rate (Monday's
    # 1,000 USD at its 1.10 close, Tuesday's 1,100 USD book at the live 1.20), never the
    # USD return converted: the last session's move plus the overnight currency.
    prev_eur = D("1000") / D("1.10")
    now_eur = D("1100") / D("1.20")
    assert abs(D(eur["kpis"]["daily_move"]) - (now_eur - prev_eur)) < D("0.01")
    assert abs(D(eur["kpis"]["daily_growth_pct"]) - (now_eur / prev_eur - 1)) < D("1e-9")
    # ... split into the session's price move and the currency since its close.
    ds = eur["day_split"]
    assert ds["overnight"] is True
    assert abs(D(ds["price_move"]) - prev_eur * D("0.1")) < D("0.01")
    assert abs(D(ds["currency_move"]) - (now_eur - D("1100") / D("1.10"))) < D("0.01")
    assert abs(D(ds["price_move"]) + D(ds["currency_move"]) - D(eur["kpis"]["daily_move"])) < D(
        "1e-9"
    )
    assert D(usd["day_split"]["currency_move"]) == D("0")
    assert eur["daily_caption"]["title"] != "Today"
    # Overnight currency is its own figure: Tuesday's 1,100 USD book revalued from
    # the 1.10 close rate to the live 1.20, in each currency, never converted.
    ls = eur["last_session"]
    assert ls["session_date"] == TUE.isoformat()
    assert ls["prev_date"] == MON.isoformat()
    assert D(ls["fx_close"]) == D("1.10")
    assert D(ls["fx_now"]) == D("1.20")
    assert abs(D(ls["overnight_currency"]) - (D("1100") / D("1.20") - D("1100") / D("1.10"))) < D(
        "0.01"
    )
    assert abs(
        D(ls["move"]) + D(ls["overnight_currency"]) - (D(ls["value_now"]) - D("1000") / D("1.10"))
    ) < D("0.01")
    assert D(usd["last_session"]["overnight_currency"]) == D("0")


def test_open_session_keeps_todays_move(api_db: Path) -> None:
    _seed(wed_close=D("121"))
    with ledger_session_scope() as s:
        usd = build_overview(s, ccy="USD", as_of=WED, now=_at(11))
    assert usd["kpis"]["daily_growth_as_of"] == WED.isoformat()
    assert D(usd["kpis"]["daily_growth_pct"]) == D("0.1")
    assert D(usd["kpis"]["daily_move"]) == D("110")
    # While the market trades there is no last-session block ...
    assert usd["last_session"] is None
    # ... but the move still splits into price and currency (none in USD for a USD book).
    ds = usd["day_split"]
    assert ds["overnight"] is False
    assert D(ds["currency_move"]) == D("0")
    assert D(ds["price_move"]) == D("110")


def test_open_session_splits_the_eur_move_into_price_and_currency(api_db: Path) -> None:
    """In session, EUR: today's 1,210 USD book at the rate now (1.20) vs Tuesday's
    1,100 USD at its close (1.10), split into price (at 1.10) and currency."""
    _seed(wed_close=D("121"))
    with ledger_session_scope() as s:
        eur = build_overview(s, ccy="EUR", as_of=WED, now=_at(11))
    move = D(eur["kpis"]["daily_move"])
    assert abs(move - (D("1210") / D("1.20") - D("1100") / D("1.10"))) < D("0.01")
    ds = eur["day_split"]
    assert ds["overnight"] is False
    assert abs(D(ds["price_move"]) - D("110") / D("1.10")) < D("0.01")
    assert abs(D(ds["currency_move"]) - (D("1210") / D("1.20") - D("1210") / D("1.10"))) < D("0.01")
    assert abs(D(ds["price_move"]) + D(ds["currency_move"]) - move) < D("1e-9")
    # The USD side of the same split: a USD book has no currency leg in USD.
    assert D(ds["currency_move_secondary"]) == D("0")
