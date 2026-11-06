"""Twin visibility: the estimated total, the holdings' twin rows and the last-session split.

USD brokerage: 10 sh of an index fund (FUNDX, NAV 200 on Fri 31 May 2024) and 10 sh
of a flat ETF (ACME, 100). FUNDX has the ETF twin TWN, which closed Friday at 100 and
runs 100 -> 102 (13:00 ET) -> 105 (16:00 ET close) on Mon 3 Jun. EUR/USD 1.10
through Monday, 1.20 on Tuesday.

Three states of the same fund (the late-NAV plan):
* market open (13:30 ET Mon): pending, estimate 204 from the twin's 102;
* after the close, NAV not posted (08:00 ET Tue): pending, estimate 210, and the
  hero's last-session split is on the estimated book;
* NAV posted (209): no estimate, the row keeps how far the twin was off.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path

from investment_dashboard.db import cache_write_session, ledger_session_scope
from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.readmodels import holdings
from investment_dashboard.readmodels.overview import build_overview
from investment_dashboard.repositories import (
    accounts_repo,
    fx_repo,
    instrument_overrides_repo,
    instruments_repo,
    prices_repo,
    twin_prices_repo,
)

D = Decimal
FRI, MON, TUE = date(2024, 5, 31), date(2024, 6, 3), date(2024, 6, 4)
DURING = datetime(2024, 6, 3, 17, 30, tzinfo=UTC)  # 13:30 ET Monday, market open
AFTER_CLOSE = datetime(2024, 6, 4, 12, 0, tzinfo=UTC)  # 08:00 ET Tuesday, shut
FX_NOW = D("1.20")
FX_FLAT = D("1.10")
TWIN_ROWS = {
    datetime(2024, 5, 31, 20, 0): D("100"),  # Friday close (naive UTC)
    datetime(2024, 6, 3, 13, 30): D("100"),
    datetime(2024, 6, 3, 17, 0): D("102"),
    datetime(2024, 6, 3, 20, 0): D("105"),  # Monday close
}


THU = date(2024, 5, 30)


def _seed(
    *,
    official_nav: Decimal | None,
    dividend: bool = False,
    mon_fx: Decimal = FX_FLAT,
    thu_nav: Decimal | None = None,
) -> None:
    with ledger_session_scope() as s:
        acct = accounts_repo.create_account(
            s,
            broker="fidelity",
            account_label="Main",
            native_currency="USD",
            account_type="brokerage",
        )
        fund = instruments_repo.get_or_create(
            s, symbol="FUNDX", asset_class="mutual_fund", native_currency="USD"
        )
        etf = instruments_repo.get_or_create(
            s, symbol="ACME", asset_class="etf", native_currency="USD"
        )
        fund_closes = {FRI: D("200")}
        if thu_nav is not None:
            fund_closes[THU] = thu_nav
        if official_nav is not None:
            fund_closes[MON] = official_nav
        prices_repo.upsert_closes(s, fund.id, fund_closes)
        prices_repo.upsert_closes(s, etf.id, {FRI: D("100"), MON: D("100")})
        fx_repo.upsert_rates(s, {THU: D("1.10"), FRI: D("1.10"), MON: mon_fx, TUE: FX_NOW})
        instrument_overrides_repo.upsert(s, fund.id, intraday_twin="TWN")
        legs = {"fx_rate_to_eur": D("1.10")}
        rows = [
            Transaction(
                account_id=acct.id,
                date=FRI,
                kind="deposit",
                source=TransactionSource.MANUAL,
                net_native=D("3000"),
                net_usd=D("3000"),
                net_eur=D("2727.27"),
                **legs,
            ),
            Transaction(
                account_id=acct.id,
                date=FRI,
                kind="buy",
                source=TransactionSource.MANUAL,
                instrument_id=fund.id,
                quantity=D("10"),
                price_native=D("200"),
                net_native=D("-2000"),
                net_usd=D("-2000"),
                net_eur=D("-1818.18"),
                **legs,
            ),
            Transaction(
                account_id=acct.id,
                date=FRI,
                kind="buy",
                source=TransactionSource.MANUAL,
                instrument_id=etf.id,
                quantity=D("10"),
                price_native=D("100"),
                net_native=D("-1000"),
                net_usd=D("-1000"),
                net_eur=D("-909.09"),
                **legs,
            ),
        ]
        if dividend:
            rows.append(
                Transaction(
                    account_id=acct.id,
                    date=MON,
                    kind="dividend_cash",
                    source=TransactionSource.MANUAL,
                    instrument_id=fund.id,
                    net_native=D("5"),
                    net_usd=D("5"),
                    net_eur=D("4.55"),
                    **legs,
                )
            )
        s.add_all(rows)
        s.flush()
        with cache_write_session(s) as cache:
            twin_prices_repo.upsert_prices(cache, "TWN", TWIN_ROWS)


def _fund_row(page: dict) -> dict:
    return next(r for r in page["holdings"] if r["symbol"] == "FUNDX")


def test_market_open_the_fund_is_pending_on_the_twin_estimate(api_db: Path) -> None:
    _seed(official_nav=None)
    with ledger_session_scope() as s:
        usd = build_overview(s, ccy="USD", as_of=MON, now=DURING)
        eur = build_overview(s, ccy="EUR", as_of=MON, now=DURING)
        page = holdings.build(s, ccy="USD", group_by="asset_class", as_of=MON, now=DURING)
        page_eur = holdings.build(s, ccy="EUR", as_of=MON, now=DURING)
    # Twin at 102 -> NAV estimate 204; 10 sh x (204 - 200) = +40 USD, +40/1.10 EUR.
    est = usd["kpis"]["estimate"]
    assert est is not None
    assert D(est["adjustment"]) == D("40")
    assert D(est["total_value"]) == D(usd["kpis"]["total_value"]) + D("40")
    assert est["funds"] == [{"symbol": "FUNDX", "twin": "TWN"}]
    # Official numbers stay official; the other currency gets its own leg.
    assert D(usd["kpis"]["total_value"]) == D("3000")
    est_eur = eur["kpis"]["estimate"]
    assert abs(D(est_eur["adjustment"]) - D("40") / D("1.10")) < D("1e-9")
    assert D(est_eur["total_value"]) == D(eur["kpis"]["total_value"]) + D(est_eur["adjustment"])
    assert D(usd["kpis_secondary"]["estimate"]["adjustment"]) == D(est_eur["adjustment"])
    # Market open: the live move is one figure, estimate = official move + adjustment.
    assert usd["last_session"] is None
    assert D(est["daily_move"]) == D(usd["kpis"]["daily_move"]) + D("40")

    row = _fund_row(page)
    twin = row["twin"]
    assert twin["pending"] is True
    assert (twin["symbol"], twin["tier"]) == ("TWN", "manual")
    assert D(twin["est_price"]) == D("204")
    assert D(twin["est_value"]) == D(row["value"]) + D("40")
    assert D(twin["est_today_move"]) == D(row["today_move"]) + D("40")
    assert twin["at"].startswith("2024-06-03T17:00:00")
    assert twin["divergence"] is None  # one price pair only: nothing to compare yet
    assert _fund_row(page_eur)["twin"]["est_price"] == twin["est_price"]  # native price
    # The ETF has no twin; the group carries the estimate, one with no fund does not.
    assert next(r for r in page["holdings"] if r["symbol"] == "ACME")["twin"] is None
    groups = {g["key"]: g for g in page["groups"]}
    fund_group = groups[row["asset_class"]]
    assert D(fund_group["est_value"]) == D(fund_group["value"]) + D("40")
    assert D(fund_group["est_today_move"]) == D(fund_group["today_move"]) + D("40")
    other = groups[next(r for r in page["holdings"] if r["symbol"] == "ACME")["asset_class"]]
    assert other["est_value"] is None
    assert other["est_today_move"] is None


def test_after_close_before_nav_the_split_runs_on_the_estimated_book(api_db: Path) -> None:
    _seed(official_nav=None)
    with ledger_session_scope() as s:
        eur = build_overview(s, ccy="EUR", as_of=TUE, now=AFTER_CLOSE)
        usd = build_overview(s, ccy="USD", as_of=TUE, now=AFTER_CLOSE)
        page = holdings.build(s, ccy="USD", as_of=TUE, now=AFTER_CLOSE)
    twin = _fund_row(page)["twin"]
    assert twin["pending"] is True
    assert D(twin["est_price"]) == D("210")  # the twin closed +5 %
    assert twin["at"].startswith("2024-06-03T20:00:00")
    for body, ccy in ((usd, "USD"), (eur, "EUR")):
        ls = body["last_session"]
        assert ls["estimated_funds"] == ["FUNDX"]
        # Official: the pending fund sits at its previous NAV, so only FX moves.
        assert D(ls["move"]) == D("0")
        prev = (D("3000") / D("1.10")) if ccy == "EUR" else D("3000")
        # Estimated book: the fund +10 per share x 10 sh = +100 USD at the 1.10 close rate.
        want_move = D("100") / D("1.10") if ccy == "EUR" else D("100")
        assert abs(D(ls["move_est"]) - want_move) < D("1e-9")
        assert abs(D(ls["move_pct_est"]) - want_move / prev) < D("1e-9")
        # move_est + overnight identity on the estimated book.
        assert abs(
            D(ls["move_est"]) + D(ls["overnight_currency_est"]) - (D(ls["value_now_est"]) - prev)
        ) < D("1e-9")
        # Shut market: the hero's estimated day figure is the TOTAL change since the
        # previous close, overnight currency included.
        est = body["kpis"]["estimate"]
        total_change = D(ls["move_est"]) + D(ls["overnight_currency_est"])
        assert abs(D(est["daily_move"]) - total_change) < D("1e-9")
        assert abs(D(est["daily_move"]) - (D(ls["value_now_est"]) - prev)) < D("1e-9")
        assert abs(D(est["daily_growth_pct"]) - total_change / prev) < D("1e-9")
        # issue #9: ``total_value`` comes from ``metrics.total_value`` (computed by
        # ``compute_portfolio_metrics``), but ``daily_move``/``daily_growth_pct`` come
        # from the independently-computed last-session split (``metrics_service._book_holdings``,
        # valued ``as_of=session_date``). Nothing asserts the two books agree; this pins
        # the relationship every consumer assumes: subtracting the move off the total
        # must land back on the SAME previous-close value ``daily_growth_pct`` divides by.
        assert abs(D(est["total_value"]) - D(est["daily_move"]) - prev) < D("1e-9")
        # The official total change (overnight currency included) mirrors the estimate:
        # their difference is exactly the twin adjustment, also when the rate moved.
        assert abs(D(ls["day_move"]) - (D(ls["move"]) + D(ls["overnight_currency"]))) < D("1e-9")
        assert abs(D(est["daily_move"]) - D(ls["day_move"]) - D(est["adjustment"])) < D("1e-9")
        assert abs(D(ls["day_move"]) - (D(ls["value_now"]) - prev)) < D("1e-9")
        assert abs(D(ls["day_move_pct"]) - D(ls["day_move"]) / prev) < D("1e-9")
        # Assumption: the official shut-market ``kpis.daily_move`` is the last session's
        # move WITHOUT the overnight currency, so the two lines differ by the twin
        # adjustment plus that overnight currency move (exactly the adjustment when the
        # rate has not moved since the close).
        assert abs(
            (D(est["daily_move"]) - D(body["kpis"]["daily_move"]))
            - (D(est["adjustment"]) + D(ls["overnight_currency"]))
        ) < D("1e-9")
    # EUR book now: (1,000 + 2,100 USD) at 1.20; overnight is only the currency.
    ls = eur["last_session"]
    assert abs(D(ls["value_now_est"]) - D("3100") / D("1.20")) < D("1e-9")
    assert abs(
        D(ls["overnight_currency_est"]) - (D("3100") / D("1.20") - D("3100") / D("1.10"))
    ) < D("1e-9")
    assert D(usd["last_session"]["overnight_currency_est"]) == D("0")
    # Golden, rate moved 1.10 -> 1.20 since the close: the unposted fund is flat at its
    # previous NAV, so the official EUR day change is the currency alone.
    gold = D("3000") / D("1.20") - D("3000") / D("1.10")
    assert abs(D(eur["last_session"]["day_move"]) - gold) < D("1e-9")
    assert abs(D(eur["last_session"]["day_move_pct"]) - gold / (D("3000") / D("1.10"))) < D("1e-9")
    assert D(usd["last_session"]["day_move"]) == D("0")
    # The estimate adds exactly the twin adjustment (100 USD at the rate now).
    assert abs(
        D(eur["kpis"]["estimate"]["daily_move"])
        - D(eur["last_session"]["day_move"])
        - D("100") / D("1.20")
    ) < D("1e-9")


def test_nav_posted_the_estimate_is_gone_and_the_row_reports_the_miss(api_db: Path) -> None:
    _seed(official_nav=D("209"))
    with ledger_session_scope() as s:
        usd = build_overview(s, ccy="USD", as_of=MON, now=datetime(2024, 6, 3, 22, 0, tzinfo=UTC))
        page = holdings.build(s, ccy="USD", as_of=MON, now=datetime(2024, 6, 3, 22, 0, tzinfo=UTC))
        eur = holdings.build(s, ccy="EUR", as_of=MON, now=datetime(2024, 6, 3, 22, 0, tzinfo=UTC))
    # Adjustment is exactly 0: no estimate block at all, official total unchanged.
    assert usd["kpis"]["estimate"] is None
    assert usd["last_session"]["estimated_funds"] == []
    assert usd["last_session"]["move_est"] is None
    assert D(usd["kpis"]["total_value"]) == D("3090")  # 10 x 209 + 10 x 100
    twin = _fund_row(page)["twin"]
    assert twin["pending"] is False
    assert twin["est_price"] is None
    assert twin["est_value"] is None
    div = twin["divergence"]
    # Twin +5 %, fund 209/200 - 1 = +4.5 %: the twin ran 0.5 pp high, worth 10 USD.
    assert D(div["last_pp"]) == D("0.5")
    assert D(div["last_money"]) == D("10")
    assert D(div["median_abs_pp"]) == D("0.5")
    assert D(div["bias_pp"]) == D("0.5")
    assert (div["sessions"], div["window"], div["last_date"]) == (1, 20, MON.isoformat())
    # In EUR the same miss is valued at the one rate now (no converted return).
    assert abs(D(_fund_row(eur)["twin"]["divergence"]["last_money"]) - D("10") / D("1.10")) < D(
        "1e-9"
    )


def test_a_dividend_session_is_left_out_of_the_divergence(api_db: Path) -> None:
    _seed(official_nav=D("209"), dividend=True)
    with ledger_session_scope() as s:
        page = holdings.build(s, ccy="USD", as_of=MON, now=datetime(2024, 6, 3, 22, 0, tzinfo=UTC))
    # The only session in the data ends on the fund's distribution day: nothing to show.
    assert _fund_row(page)["twin"] is None


# -- one definition of the estimated day move -----------------------------------------------


def _check_consistent(ccy: str, *, fx_now: Decimal, fx_prev: Decimal) -> None:
    from investment_dashboard.services import scheduler

    with ledger_session_scope() as s:
        page = holdings.build(s, ccy=ccy, as_of=MON, now=DURING)
        hero = build_overview(s, ccy=ccy, as_of=MON, now=DURING)
        tick = scheduler._tick_estimates(s, D("0"), fx_now, now=DURING)
    row = _fund_row(page)
    twin = row["twin"]
    # Fund: 10 sh, NAV 200 -> estimate 204. Today's value at the rate now, minus
    # yesterday's value at yesterday's rate: the same convention as a stock's move.
    if ccy == "USD":
        want_move, want_prev = D("40"), D("2000")
    else:
        want_move = D("2040") / fx_now - D("2000") / fx_prev
        want_prev = D("2000") / fx_prev
    assert abs(D(twin["est_today_move"]) - want_move) < D("1e-9")
    assert abs(D(twin["est_today_pct"]) - want_move / want_prev) < D("1e-12")
    # The tick's per-currency pct is the same number as the row's.
    (tick_row,) = tick["estimates"].values()
    assert abs(D(tick_row["pct"][ccy]) - D(twin["est_today_pct"])) < D("1e-12")
    # Value: official value + delta at the rate now (unchanged).
    assert abs(D(twin["est_value"]) - D("2040") / (fx_now if ccy == "EUR" else D(1))) < D("1e-9")
    # Hero estimated move == the pending fund's estimated move + every other holding's
    # official move (the stale Thursday->Friday move of the fund counts for nothing).
    others = sum(
        (D(r["today_move"]) for r in page["holdings"] if r["symbol"] != "FUNDX"), start=D(0)
    )
    assert abs(
        D(hero["kpis"]["estimate"]["daily_move"]) - (others + D(twin["est_today_move"]))
    ) < D("0.02")


def test_row_tick_and_hero_agree_when_the_rate_moved_since_the_previous_close(
    api_db: Path,
) -> None:
    # Thursday NAV 190: the card's own move for the unposted fund is a stale +100 USD.
    _seed(official_nav=None, mon_fx=D("1.25"), thu_nav=D("190"))
    with ledger_session_scope() as s:
        stale = _fund_row(holdings.build(s, ccy="USD", as_of=MON, now=DURING))
    assert D(stale["today_move"]) == D("100")  # last session's move, not today's
    _check_consistent("USD", fx_now=D("1.25"), fx_prev=D("1.10"))
    _check_consistent("EUR", fx_now=D("1.25"), fx_prev=D("1.10"))
    # The group's estimated move follows the same figure.
    with ledger_session_scope() as s:
        page = holdings.build(s, ccy="USD", group_by="asset_class", as_of=MON, now=DURING)
    fund_group = next(g for g in page["groups"] if g["est_today_move"] is not None)
    assert D(fund_group["est_today_move"]) == D("40")
    assert D(fund_group["today_move"]) == D("100")


def test_estimated_day_move_ignores_the_stale_last_session_move(api_db: Path) -> None:
    from dataclasses import replace

    from hypothesis import HealthCheck, given, settings
    from hypothesis import strategies as st

    from investment_dashboard.readmodels._context import build_context
    from investment_dashboard.readmodels.queries.overview_query import (
        build_holding_cards,
        compute_instrument_metrics,
        holding_freshness,
    )
    from investment_dashboard.services import intraday_snapshots_service as iss
    from investment_dashboard.services.positions_service import compute_positions

    _seed(official_nav=None, mon_fx=D("1.25"), thu_nav=D("190"))
    with ledger_session_scope() as s:
        ctx = build_context(s, as_of=MON)
        positions = holdings.merge_positions_by_instrument(compute_positions(s, as_of=MON))
        cards = build_holding_cards(
            positions,
            metrics=compute_instrument_metrics(s, positions, as_of=MON),
            freshness=holding_freshness(s, positions),
            price_anomaly_ids=set(),
        )
        card = next(c for c in cards if c.symbol == "FUNDX")
        position = next(p for p in positions if p.instrument.id == card.instrument_id)
        estimates = iss.twin_estimates(s, DURING)
        fx_prev = iss.previous_close_fx(s, MON)

        def view(c, ccy):  # type: ignore[no-untyped-def]
            return holdings._twin_view(
                s,
                card=c,
                position=position,
                estimates=estimates,
                session_date=MON,
                now=DURING,
                fx=ctx.fx_rate_eur_usd,
                fx_prev=fx_prev,
                ccy=ccy,
            )

        baseline = {ccy: view(card, ccy) for ccy in ("EUR", "USD")}
        money = st.decimals(min_value="-100000", max_value="100000", places=2)

        @settings(suppress_health_check=list(HealthCheck), max_examples=40, deadline=None)
        @given(
            eur=money,
            usd=money,
            pct_eur=st.decimals(min_value="-1", max_value="1", places=4),
            pct_usd=st.decimals(min_value="-1", max_value="1", places=4),
        )
        def check(eur: Decimal, usd: Decimal, pct_eur: Decimal, pct_usd: Decimal) -> None:
            moved = replace(
                card,
                daily_move_eur=eur,
                daily_move_usd=usd,
                daily_growth_eur=pct_eur,
                daily_growth_usd=pct_usd,
            )
            for ccy in ("EUR", "USD"):
                got = view(moved, ccy)
                want = baseline[ccy]
                assert got[0]["est_today_move"] == want[0]["est_today_move"]
                assert got[0]["est_today_pct"] == want[0]["est_today_pct"]
                assert got[2] == want[2]

        check()


# -- the divergence's money is a PAST session's gap: it must use THAT session's rate ----


def test_divergence_money_uses_the_last_sessions_own_rate_not_now(api_db: Path) -> None:
    """``stats.last_date`` can be weeks old: the gap money must be struck at THAT
    session's close rate, never "now"'s (the currency rule — a past valuation is
    never re-struck at a later rate). Regression for issue #1: this used to value
    the gap at ``ctx.fx_rate_eur_usd`` (today's rate).

    Thu->Fri: fund NAV 190->200 (+5.263 %), twin 100->105 (+5 %): the twin ran
    0.2632 pp behind, worth -0.5 native per share (190 x (105/100 - 200/190)).
    Friday's close rate is 1.10; "now" (Monday) is 1.30 -- a world apart, so the
    bug and the fix give very different numbers.
    """
    thu, fri = date(2024, 5, 30), date(2024, 5, 31)
    with ledger_session_scope() as s:
        acct = accounts_repo.create_account(
            s,
            broker="fidelity",
            account_label="Main",
            native_currency="USD",
            account_type="brokerage",
        )
        fund = instruments_repo.get_or_create(
            s, symbol="FUNDX", asset_class="mutual_fund", native_currency="USD"
        )
        prices_repo.upsert_closes(s, fund.id, {thu: D("190"), fri: D("200")})  # MON: pending
        fx_repo.upsert_rates(s, {thu: D("1.05"), fri: D("1.10"), MON: D("1.30")})
        instrument_overrides_repo.upsert(s, fund.id, intraday_twin="TWN")
        legs = {"fx_rate_to_eur": D("1.10")}
        s.add_all(
            [
                Transaction(
                    account_id=acct.id,
                    date=fri,
                    kind="deposit",
                    source=TransactionSource.MANUAL,
                    net_native=D("2000"),
                    net_usd=D("2000"),
                    net_eur=D("1818.18"),
                    **legs,
                ),
                Transaction(
                    account_id=acct.id,
                    date=fri,
                    kind="buy",
                    source=TransactionSource.MANUAL,
                    instrument_id=fund.id,
                    quantity=D("10"),
                    price_native=D("200"),
                    net_native=D("-2000"),
                    net_usd=D("-2000"),
                    net_eur=D("-1818.18"),
                    **legs,
                ),
            ]
        )
        s.flush()
        with cache_write_session(s) as cache:
            twin_prices_repo.upsert_prices(
                cache,
                "TWN",
                {
                    datetime(2024, 5, 30, 20, 0): D("100"),  # Thursday close
                    datetime(2024, 5, 31, 20, 0): D("105"),  # Friday close
                    datetime(2024, 6, 3, 13, 30): D("105"),  # Monday: no move yet
                    datetime(2024, 6, 3, 17, 0): D("107"),  # Monday, during the session
                },
            )
    with ledger_session_scope() as s:
        page = holdings.build(s, ccy="EUR", as_of=MON, now=DURING)
    twin = _fund_row(page)["twin"]
    assert twin["pending"] is True
    div = twin["divergence"]
    assert div is not None
    assert div["last_date"] == fri.isoformat()
    # -0.5 native per share x 10 sh = -5 USD, valued at FRIDAY's close rate (1.10).
    assert abs(D(div["last_money"]) - (D("-5") / D("1.10"))) < D("1e-9")
    # Not the buggy value (valued at "now"'s Monday rate, 1.30).
    assert abs(D(div["last_money"]) - (D("-5") / D("1.30"))) > D("1e-3")


def test_divergence_money_sums_every_account_not_just_the_merged_one(api_db: Path) -> None:
    """A fund held in both a USD and a EUR account must book its posted-NAV
    divergence money across BOTH legs, not all of it in whichever account the
    (shares-summing) merge happened to keep (issue #2).

    Fund NAV posts Monday at 209 (prev 200, +4.5 %); twin closed at 105 (+5 %):
    the twin ran 0.5 pp high. 10 USD-booked shares + 5 EUR-booked shares each see
    the same native price step (+1 per share): 10 USD native, 5 EUR native.
    """
    with ledger_session_scope() as s:
        acct_usd = accounts_repo.create_account(
            s,
            broker="fidelity",
            account_label="USD",
            native_currency="USD",
            account_type="brokerage",
        )
        acct_eur = accounts_repo.create_account(
            s,
            broker="vanguard",
            account_label="EUR",
            native_currency="EUR",
            account_type="brokerage",
        )
        fund = instruments_repo.get_or_create(
            s, symbol="FUNDX", asset_class="mutual_fund", native_currency="USD"
        )
        prices_repo.upsert_closes(s, fund.id, {FRI: D("200"), MON: D("209")})
        fx_repo.upsert_rates(s, {FRI: D("1.10"), MON: D("1.10")})
        instrument_overrides_repo.upsert(s, fund.id, intraday_twin="TWN")
        legs = {"fx_rate_to_eur": D("1.10")}
        s.add_all(
            [
                Transaction(
                    account_id=acct_usd.id,
                    date=FRI,
                    kind="deposit",
                    source=TransactionSource.MANUAL,
                    net_native=D("2000"),
                    net_usd=D("2000"),
                    net_eur=D("1818.18"),
                    **legs,
                ),
                Transaction(
                    account_id=acct_usd.id,
                    date=FRI,
                    kind="buy",
                    source=TransactionSource.MANUAL,
                    instrument_id=fund.id,
                    quantity=D("10"),
                    price_native=D("200"),
                    net_native=D("-2000"),
                    net_usd=D("-2000"),
                    net_eur=D("-1818.18"),
                    **legs,
                ),
                Transaction(
                    account_id=acct_eur.id,
                    date=FRI,
                    kind="deposit",
                    source=TransactionSource.MANUAL,
                    net_native=D("1000"),
                    net_usd=D("1100"),
                    net_eur=D("1000"),
                    **{"fx_rate_to_eur": D("1")},
                ),
                Transaction(
                    account_id=acct_eur.id,
                    date=FRI,
                    kind="buy",
                    source=TransactionSource.MANUAL,
                    instrument_id=fund.id,
                    quantity=D("5"),
                    price_native=D("200"),
                    net_native=D("-1000"),
                    net_usd=D("-1100"),
                    net_eur=D("-1000"),
                    **{"fx_rate_to_eur": D("1")},
                ),
            ]
        )
        s.flush()
        with cache_write_session(s) as cache:
            twin_prices_repo.upsert_prices(
                cache,
                "TWN",
                {
                    datetime(2024, 5, 31, 20, 0): D("100"),  # Friday close
                    datetime(2024, 6, 3, 20, 0): D("105"),  # Monday close: +5 %
                },
            )
    with ledger_session_scope() as s:
        usd_page = holdings.build(
            s, ccy="USD", as_of=MON, now=datetime(2024, 6, 3, 22, 0, tzinfo=UTC)
        )
        eur_page = holdings.build(
            s, ccy="EUR", as_of=MON, now=datetime(2024, 6, 3, 22, 0, tzinfo=UTC)
        )
    usd_div = _fund_row(usd_page)["twin"]["divergence"]
    eur_div = _fund_row(eur_page)["twin"]["divergence"]
    assert D(usd_div["last_pp"]) == D("0.5")
    # 10 USD (FX-free) + 5 EUR converted at 1.10 = 10 + 5.5 = 15.5 USD, never just
    # 10 or 15 (which is what summing shares under one arbitrary currency gives).
    assert D(usd_div["last_money"]) == D("15.5")
    assert abs(D(eur_div["last_money"]) - (D("10") / D("1.10") + D("5"))) < D("1e-9")
