"""Tests for the services layer (positions, metrics)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.repositories import (
    accounts_repo,
    fx_repo,
    instruments_repo,
    prices_repo,
)
from investment_dashboard.services import metrics_service, positions_service


def _seed_eur_account(session: Session, label: str = "Savings") -> int:
    a = accounts_repo.create_account(
        session,
        broker="savings_bank",
        account_label=label,
        native_currency="EUR",
        account_type="savings",
    )
    return a.id


def _seed_usd_brokerage(session: Session) -> int:
    a = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Fidelity Brokerage",
        native_currency="USD",
        account_type="brokerage",
    )
    return a.id


class TestPositions:
    def test_empty_portfolio_has_no_positions(self, session: Session) -> None:
        assert positions_service.compute_positions(session) == []
        assert positions_service.total_portfolio_value(session) == Decimal(0)

    def test_buy_then_value(self, session: Session) -> None:
        acct_id = _seed_usd_brokerage(session)
        instr = instruments_repo.get_or_create(session, symbol="VTI", native_currency="USD")
        session.add(
            Transaction(
                account_id=acct_id,
                instrument_id=instr.id,
                date=date(2024, 1, 5),
                kind="buy",
                quantity=Decimal("10"),
                price_native=Decimal("220.00"),
                net_native=Decimal("-2200.00"),
                net_eur=Decimal("-2000.00"),
                source="manual",
            )
        )
        prices_repo.upsert_closes(session, instr.id, {date(2024, 2, 1): Decimal("250.00")})
        fx_repo.upsert_rates(session, {date(2024, 2, 1): Decimal("1.10")})
        session.flush()

        positions = positions_service.compute_positions(session, as_of=date(2024, 2, 1))
        assert len(positions) == 1
        p = positions[0]
        assert p.shares == Decimal("10")
        assert p.current_price_native == Decimal("250.000000")
        assert p.current_value_native == Decimal("2500.000000")
        # 2500 USD at 1.10 EUR/USD ⇒ 2272.727… EUR
        assert abs(p.current_value_eur - Decimal("2272.72")) < Decimal("0.5")

    def test_missing_fx_values_non_eur_holding_blank_not_par(self, session: Session) -> None:
        """A2: a non-EUR holding with no EUR↔native rate values to blank in EUR
        (ZERO + ``value_warning``), never the native amount relabelled as EUR at
        par (1:1). The total excludes it rather than overstating with a par
        figure."""
        acct_id = _seed_usd_brokerage(session)
        instr = instruments_repo.get_or_create(session, symbol="VTI", native_currency="USD")
        session.add(
            Transaction(
                account_id=acct_id,
                instrument_id=instr.id,
                date=date(2024, 1, 5),
                kind="buy",
                quantity=Decimal("10"),
                price_native=Decimal("220.00"),
                net_native=Decimal("-2200.00"),
                source="manual",
            )
        )
        prices_repo.upsert_closes(session, instr.id, {date(2024, 2, 1): Decimal("220.00")})
        # Deliberately NO FX row.
        session.flush()

        p = next(
            pos
            for pos in positions_service.compute_positions(session, as_of=date(2024, 2, 1))
            if pos.instrument.symbol == "VTI"
        )
        assert p.current_value_native == Decimal("2200.000000")
        # Blank in EUR — not the native 2200 relabelled as EUR at par.
        assert p.current_value_eur == Decimal("0")
        assert p.value_warning is True
        # The total omits the unconvertible holding instead of adding par 2200.
        assert positions_service.total_portfolio_value(session, as_of=date(2024, 2, 1)) == Decimal(
            "0"
        )

    def test_missing_fx_excludes_non_eur_cash_from_total(self, session: Session) -> None:
        """A2: a non-EUR cash balance with no rate is omitted from the EUR total
        rather than added at par (1:1)."""
        acct = accounts_repo.create_account(
            session,
            broker="fidelity",
            account_label="USD Cash",
            native_currency="USD",
            account_type="savings",
        )
        session.add(
            Transaction(
                account_id=acct.id,
                date=date(2024, 1, 2),
                kind="deposit",
                net_native=Decimal("1000.00"),
                source="manual",
            )
        )
        session.flush()
        # No FX ⇒ the 1000 USD can't be expressed in EUR, so it is excluded
        # (would have been a bogus 1000 EUR under the old par fallback).
        assert positions_service.total_portfolio_value(session) == Decimal("0")

    def test_savings_cash_balance(self, session: Session) -> None:
        acct_id = _seed_eur_account(session)
        for kind, amt in [("deposit", "1000"), ("interest", "5"), ("withdrawal", "-100")]:
            session.add(
                Transaction(
                    account_id=acct_id,
                    date=date(2024, 1, 1),
                    kind=kind,
                    net_native=Decimal(amt),
                    net_eur=Decimal(amt),
                    source="manual",
                )
            )
        session.flush()
        # 1000 + 5 - 100 = 905
        assert positions_service.compute_cash_balance(session, acct_id) == Decimal("905")
        # Aggregated into total portfolio EUR.
        assert positions_service.total_portfolio_value(session) == Decimal("905")


class TestMetrics:
    def test_metrics_on_empty_portfolio(self, session: Session) -> None:
        m = metrics_service.compute_portfolio_metrics(session)
        assert m.total_value_eur == Decimal(0)
        assert m.xirr is None  # no cashflows
        assert m.total_growth_pct is None

    def test_metrics_with_deposit_and_growth(self, session: Session) -> None:
        # Simple EUR account: deposit 1000 a year ago, current value 1100.
        acct_id = _seed_eur_account(session, "Direct Savings")
        session.add(
            Transaction(
                account_id=acct_id,
                date=date(2023, 1, 1),
                kind="deposit",
                net_native=Decimal("1000"),
                net_eur=Decimal("1000"),
                source="manual",
            )
        )
        # Use an interest credit to simulate the growth so positions reflect 1100.
        session.add(
            Transaction(
                account_id=acct_id,
                date=date(2023, 12, 31),
                kind="interest",
                net_native=Decimal("100"),
                net_eur=Decimal("100"),
                source="manual",
            )
        )
        session.flush()
        m = metrics_service.compute_portfolio_metrics(session, as_of=date(2024, 1, 1))
        assert m.total_value_eur == Decimal("1100")
        # Net contributions = 1000 (deposit). XIRR ≈ 10%.
        assert m.xirr is not None
        assert abs(m.xirr - Decimal("0.10")) < Decimal("0.001")

    def test_daily_growth_usd_is_none_when_fx_missing(self, session: Session) -> None:
        """A1: with no EUR→USD rate on file, the daily-growth USD *display* leg
        degrades to ``None`` instead of relabelling the EUR figure as USD.

        The holding is EUR-denominated, so its EUR base value needs no FX and
        stays meaningful; only the USD conversion is unavailable. (Under A2 a
        *non-EUR* holding with no rate values to blank itself, so an EUR holding
        is used here to isolate the USD-display leg.)
        """
        acct_id = accounts_repo.create_account(
            session,
            broker="fidelity",
            account_label="EUR Brokerage",
            native_currency="EUR",
            account_type="brokerage",
        ).id
        eunl = instruments_repo.get_or_create(session, symbol="EUNL", native_currency="EUR")
        session.add(
            Transaction(
                account_id=acct_id,
                instrument_id=eunl.id,
                date=date(2024, 1, 5),
                kind="buy",
                quantity=Decimal("10"),
                price_native=Decimal("200.00"),
                net_native=Decimal("-2000.00"),
                net_eur=Decimal("-2000.00"),
                source="manual",
            )
        )
        # Two priced dates so daily growth is computable, but NO FX rows at all.
        prices_repo.upsert_closes(
            session,
            eunl.id,
            {date(2024, 1, 31): Decimal("210.00"), date(2024, 2, 1): Decimal("220.00")},
        )
        session.flush()

        m = metrics_service.compute_portfolio_metrics(session, as_of=date(2024, 2, 1))
        # EUR leg is computed natively (no FX needed) and stays meaningful.
        assert m.daily_growth_pct is not None
        # USD leg must be blank, not an EUR value relabelled as USD.
        assert m.daily_growth_pct_usd is None
        assert m.total_value_usd is None

    def test_daily_growth_eur_keeps_genuine_one_day_fx_move(self, session: Session) -> None:
        """With an FX rate on file for *both* daily-growth dates, the EUR leg
        legitimately carries the real one-day currency move, so it differs from
        the FX-neutral USD leg by a small, believable amount.
        """
        acct_id = _seed_usd_brokerage(session)
        vti = instruments_repo.get_or_create(session, symbol="VTI", native_currency="USD")
        session.add(
            Transaction(
                account_id=acct_id,
                instrument_id=vti.id,
                date=date(2024, 1, 15),
                kind="buy",
                quantity=Decimal("20"),
                price_native=Decimal("230.00"),
                net_native=Decimal("-4600.00"),
                net_eur=Decimal("-4230.00"),
                net_usd=Decimal("-4600.00"),
                source="manual",
            )
        )
        prices_repo.upsert_closes(
            session,
            vti.id,
            {date(2024, 6, 27): Decimal("264.00"), date(2024, 6, 28): Decimal("265.00")},
        )
        # FX present on both daily dates: a genuine ~0.2% one-day move.
        fx_repo.upsert_rates(
            session,
            {
                date(2024, 1, 15): Decimal("1.0875"),
                date(2024, 6, 27): Decimal("1.0720"),
                date(2024, 6, 28): Decimal("1.0700"),
            },
        )
        session.flush()

        m = metrics_service.compute_portfolio_metrics(session, as_of=date(2024, 6, 30))
        assert m.daily_growth_pct is not None
        assert m.daily_growth_pct_usd is not None
        # EUR includes the FX move, USD does not — they differ, but only slightly.
        assert m.daily_growth_pct != m.daily_growth_pct_usd
        assert abs(m.daily_growth_pct - m.daily_growth_pct_usd) < Decimal("0.01")

    def test_daily_growth_eur_ignores_stale_forward_filled_fx_gap(self, session: Session) -> None:
        """A gap in FX history must not fabricate a giant one-day currency swing.

        Both daily-growth price dates are a single day apart, but the only FX
        mark before the comparison day is months old, so forward-fill would
        otherwise value the two days at rates 5 months apart and inflate the EUR
        daily growth. The guard falls back to the FX-neutral (USD) move instead.
        """
        acct_id = _seed_usd_brokerage(session)
        vti = instruments_repo.get_or_create(session, symbol="VTI", native_currency="USD")
        session.add(
            Transaction(
                account_id=acct_id,
                instrument_id=vti.id,
                date=date(2024, 1, 15),
                kind="buy",
                quantity=Decimal("20"),
                price_native=Decimal("230.00"),
                net_native=Decimal("-4600.00"),
                net_eur=Decimal("-4230.00"),
                net_usd=Decimal("-4600.00"),
                source="manual",
            )
        )
        prices_repo.upsert_closes(
            session,
            vti.id,
            {date(2024, 6, 27): Decimal("264.00"), date(2024, 6, 28): Decimal("265.00")},
        )
        # FX only on the buy date and the latest day — nothing near 2024-06-27,
        # so its rate forward-fills the stale January mark.
        fx_repo.upsert_rates(
            session,
            {
                date(2024, 1, 15): Decimal("1.0875"),
                date(2024, 6, 28): Decimal("1.0700"),
            },
        )
        session.flush()

        m = metrics_service.compute_portfolio_metrics(session, as_of=date(2024, 6, 30))
        assert m.daily_growth_pct is not None
        assert m.daily_growth_pct_usd is not None
        # The stale FX swing is neutralised: EUR collapses onto the USD move.
        assert m.daily_growth_pct == m.daily_growth_pct_usd

    def test_dividend_income_counts_reinvested_capital_gain_uses_realized(
        self, session: Session
    ) -> None:
        """Overview dividends = income (reinvested + cash); capital gain only
        adds back realized (un-reinvested) cash, never the reinvested value
        that is already embedded in the portfolio's current mark.
        """
        acct_id = _seed_usd_brokerage(session)
        from investment_dashboard.repositories import fx_repo, instruments_repo

        vti = instruments_repo.get_or_create(session, symbol="VTI", name="VTI")
        vmfxx = instruments_repo.get_or_create(session, symbol="VMFXX", name="VMFXX")
        session.add_all(
            [
                # Reinvested dividend: paired cash (skipped) + reinvest (counted).
                Transaction(
                    account_id=acct_id,
                    instrument_id=vti.id,
                    date=date(2024, 3, 10),
                    kind="dividend_cash",
                    net_native=Decimal("20"),
                    net_eur=Decimal("20"),
                    net_usd=Decimal("20"),
                    source="manual",
                ),
                Transaction(
                    account_id=acct_id,
                    instrument_id=vti.id,
                    date=date(2024, 3, 10),
                    kind="dividend_reinvest",
                    quantity=Decimal("0.1"),
                    price_native=Decimal("200"),
                    net_native=Decimal("-20"),
                    net_eur=Decimal("-20"),
                    net_usd=Decimal("-20"),
                    source="manual",
                ),
                # VMFXX interest reinvested with a zero cash leg.
                Transaction(
                    account_id=acct_id,
                    instrument_id=vmfxx.id,
                    date=date(2024, 3, 31),
                    kind="dividend_reinvest",
                    quantity=Decimal("5"),
                    price_native=Decimal("1"),
                    net_native=Decimal("0"),
                    net_eur=Decimal("0"),
                    net_usd=Decimal("0"),
                    source="manual",
                ),
                # Un-reinvested cash dividend.
                Transaction(
                    account_id=acct_id,
                    instrument_id=vti.id,
                    date=date(2024, 4, 5),
                    kind="dividend_cash",
                    net_native=Decimal("7"),
                    net_eur=Decimal("7"),
                    net_usd=Decimal("7"),
                    source="manual",
                ),
            ]
        )
        fx_repo.upsert_rates(
            session,
            {
                date(2024, 3, 10): Decimal("1"),
                date(2024, 3, 31): Decimal("1"),
                date(2024, 4, 5): Decimal("1"),
            },
            base="EUR",
            quote="USD",
        )
        session.flush()
        m = metrics_service.compute_portfolio_metrics(session, as_of=date(2024, 5, 1))
        # Income = 20 (VTI reinvest) + 5 (VMFXX) + 7 (cash) = 32.
        assert m.total_dividends_cash_usd == Decimal("32")
        # Capital gain = current value + realized cash − net contributions.
        # The reinvested VMFXX shares are in the value ($5 @ $1 NAV); the
        # reinvested VTI value is NOT added back as a dividend (its unpriced
        # shares mark to 0 here). Realized cash adds back only the $7. So
        # 5 + 7 − 0 = 12 — the reinvested distributions are counted once.
        assert m.capital_gain_usd == Decimal("12")

        acct_id = _seed_usd_brokerage(session)
        txns = [
            Transaction(
                account_id=acct_id,
                date=date(2024, 1, 1),
                kind="deposit",
                net_native=Decimal("1000"),
                net_eur=Decimal("900"),
                source="manual",
            ),
            Transaction(
                account_id=acct_id,
                date=date(2024, 2, 1),
                kind="dividend_cash",
                net_native=Decimal("50"),
                net_eur=Decimal("45"),
                source="manual",
            ),
            Transaction(
                account_id=acct_id,
                date=date(2024, 3, 1),
                kind="interest",
                net_native=Decimal("5"),
                net_eur=Decimal("4.50"),
                source="manual",
            ),
        ]
        session.add_all(txns)
        session.flush()

        cashflows = metrics_service.build_portfolio_cashflows(txns)

        assert [(cf.date, cf.amount) for cf in cashflows] == [
            (date(2024, 1, 1), Decimal("-900")),
            (date(2024, 2, 1), Decimal("45")),
            (date(2024, 3, 1), Decimal("4.50")),
        ]

    def test_transfer_kinds_count_as_external_flows(self, session: Session) -> None:
        """``transfer_in`` behaves like a deposit and ``transfer_out`` like a
        withdrawal in the portfolio cashflow series (audit §3.2.11)."""
        acct_id = _seed_usd_brokerage(session)
        txns = [
            Transaction(
                account_id=acct_id,
                date=date(2024, 1, 1),
                kind="transfer_in",
                net_native=Decimal("1000"),
                net_eur=Decimal("900"),
                source="manual",
            ),
            Transaction(
                account_id=acct_id,
                date=date(2024, 6, 1),
                kind="transfer_out",
                net_native=Decimal("-200"),
                net_eur=Decimal("-180"),
                source="manual",
            ),
        ]
        session.add_all(txns)
        session.flush()

        cashflows = metrics_service.build_portfolio_cashflows(txns)

        # transfer_in (amount 900) ⇒ negative flow; transfer_out (amount -180)
        # ⇒ positive flow — exactly the deposit/withdrawal sign convention.
        assert [(cf.date, cf.amount) for cf in cashflows] == [
            (date(2024, 1, 1), Decimal("-900")),
            (date(2024, 6, 1), Decimal("180")),
        ]


class TestExpenseAndMtdMetrics:
    """Parity KPIs ported from the spreadsheet's ``Total`` block."""

    def test_weighted_expense_ratio_and_annual_cost(self, session: Session) -> None:
        # EUR brokerage so value_eur == value_native (no FX in play).
        acct = accounts_repo.create_account(
            session,
            broker="vanguard",
            account_label="Vanguard EUR",
            native_currency="EUR",
            account_type="brokerage",
        )
        vti = instruments_repo.get_or_create(
            session, symbol="VTI", native_currency="EUR", expense_ratio=Decimal("0.0003")
        )
        vug = instruments_repo.get_or_create(
            session, symbol="VUG", native_currency="EUR", expense_ratio=Decimal("0.0005")
        )
        session.add_all(
            [
                Transaction(
                    account_id=acct.id,
                    instrument_id=vti.id,
                    date=date(2024, 1, 5),
                    kind="buy",
                    quantity=Decimal("10"),
                    price_native=Decimal("100"),
                    net_native=Decimal("-1000"),
                    net_eur=Decimal("-1000"),
                    source="manual",
                ),
                Transaction(
                    account_id=acct.id,
                    instrument_id=vug.id,
                    date=date(2024, 1, 5),
                    kind="buy",
                    quantity=Decimal("10"),
                    price_native=Decimal("300"),
                    net_native=Decimal("-3000"),
                    net_eur=Decimal("-3000"),
                    source="manual",
                ),
            ]
        )
        as_of = date(2024, 6, 1)
        prices_repo.upsert_closes(session, vti.id, {as_of: Decimal("100")})
        prices_repo.upsert_closes(session, vug.id, {as_of: Decimal("300")})
        session.flush()

        m = metrics_service.compute_portfolio_metrics(session, as_of=as_of)
        # Values: VTI 1000 @ 0.0003 = 0.30; VUG 3000 @ 0.0005 = 1.50; total 4000.
        assert m.annual_expense_cost_eur == Decimal("1.80")
        # Weighted ratio = 1.80 / 4000 = 0.00045.
        assert m.weighted_expense_ratio is not None
        assert abs(m.weighted_expense_ratio - Decimal("0.00045")) < Decimal("0.0000001")

    def test_dividend_yield_is_dividends_over_closing_balance(self, session: Session) -> None:
        acct_id = _seed_eur_account(session, "Dividend Account")
        session.add_all(
            [
                Transaction(
                    account_id=acct_id,
                    date=date(2024, 1, 1),
                    kind="deposit",
                    net_native=Decimal("1000"),
                    net_eur=Decimal("1000"),
                    source="manual",
                ),
                Transaction(
                    account_id=acct_id,
                    date=date(2024, 6, 1),
                    kind="dividend_cash",
                    net_native=Decimal("20"),
                    net_eur=Decimal("20"),
                    source="manual",
                ),
            ]
        )
        session.flush()
        m = metrics_service.compute_portfolio_metrics(session, as_of=date(2024, 12, 31))
        # Closing balance = 1000 + 20 = 1020; yield = 20 / 1020.
        assert m.total_value_eur == Decimal("1020")
        assert m.dividend_yield_pct is not None
        assert abs(m.dividend_yield_pct - (Decimal("20") / Decimal("1020"))) < Decimal("1e-9")

    def test_dividend_yield_none_when_empty(self, session: Session) -> None:
        m = metrics_service.compute_portfolio_metrics(session)
        assert m.dividend_yield_pct is None

    def test_expense_metrics_none_when_empty(self, session: Session) -> None:
        m = metrics_service.compute_portfolio_metrics(session)
        assert m.weighted_expense_ratio is None
        assert m.annual_expense_cost_eur == Decimal(0)

    def test_mtd_growth_excludes_contributions(self, session: Session) -> None:
        # EUR savings: 1100 at start of month, +110 interest within month ⇒ +10 %.
        acct_id = _seed_eur_account(session)
        session.add_all(
            [
                Transaction(
                    account_id=acct_id,
                    date=date(2024, 1, 1),
                    kind="deposit",
                    net_native=Decimal("1000"),
                    net_eur=Decimal("1000"),
                    source="manual",
                ),
                Transaction(
                    account_id=acct_id,
                    date=date(2024, 2, 15),
                    kind="interest",
                    net_native=Decimal("100"),
                    net_eur=Decimal("100"),
                    source="manual",
                ),
                Transaction(
                    account_id=acct_id,
                    date=date(2024, 3, 10),
                    kind="interest",
                    net_native=Decimal("110"),
                    net_eur=Decimal("110"),
                    source="manual",
                ),
            ]
        )
        session.flush()
        m = metrics_service.compute_portfolio_metrics(session, as_of=date(2024, 3, 15))
        assert m.mtd_growth_pct is not None
        assert abs(m.mtd_growth_pct - Decimal("0.10")) < Decimal("0.0001")

    def test_mtd_growth_none_without_month_start_value(self, session: Session) -> None:
        acct_id = _seed_eur_account(session)
        session.add(
            Transaction(
                account_id=acct_id,
                date=date(2024, 3, 5),
                kind="deposit",
                net_native=Decimal("1000"),
                net_eur=Decimal("1000"),
                source="manual",
            )
        )
        session.flush()
        # Month start (2024-03-01) precedes the only deposit ⇒ no base value.
        m = metrics_service.compute_portfolio_metrics(session, as_of=date(2024, 3, 15))
        assert m.mtd_growth_pct is None


class TestMoneyMarketSweptDistributions:
    def test_distribution_swept_into_settlement_fund_not_an_xirr_outflow(
        self, session: Session
    ) -> None:
        """A dividend paid into a brokerage account that also holds a
        money-market settlement fund (VMFXX/SPAXX) is already captured by that
        fund's terminal value, so it must not double-count as an XIRR outflow
        and inflate the return."""
        acct_id = _seed_usd_brokerage(session)
        vti = instruments_repo.get_or_create(session, symbol="VTI", name="VTI")
        vmfxx = instruments_repo.get_or_create(session, symbol="VMFXX", name="VMFXX")
        session.add_all(
            [
                Transaction(
                    account_id=acct_id,
                    instrument_id=vti.id,
                    date=date(2024, 1, 5),
                    kind="buy",
                    quantity=Decimal("10"),
                    price_native=Decimal("100"),
                    net_native=Decimal("-1000"),
                    net_eur=Decimal("-1000"),
                    net_usd=Decimal("-1000"),
                    source="manual",
                ),
                # Settlement-fund holding in the same account.
                Transaction(
                    account_id=acct_id,
                    instrument_id=vmfxx.id,
                    date=date(2024, 1, 5),
                    kind="buy",
                    quantity=Decimal("50"),
                    price_native=Decimal("1"),
                    net_native=Decimal("-50"),
                    net_eur=Decimal("-50"),
                    net_usd=Decimal("-50"),
                    source="manual",
                ),
                # A cash dividend swept into the settlement fund.
                Transaction(
                    account_id=acct_id,
                    instrument_id=vti.id,
                    date=date(2024, 6, 1),
                    kind="dividend_cash",
                    net_native=Decimal("30"),
                    net_eur=Decimal("30"),
                    net_usd=Decimal("30"),
                    source="manual",
                ),
            ]
        )
        prices_repo.upsert_closes(session, vti.id, {date.today(): Decimal("120")})
        fx_repo.upsert_rates(
            session,
            {
                date(2024, 1, 5): Decimal("1"),
                date(2024, 6, 1): Decimal("1"),
                date.today(): Decimal("1"),
            },
        )
        session.flush()

        from investment_dashboard.domain.money_market import is_money_market
        from investment_dashboard.repositories import transactions_repo
        from investment_dashboard.services import metrics_service as ms

        txns = list(transactions_repo.list_transactions(session))
        retained = {
            t.account_id
            for t in txns
            if t.account_id is not None
            and t.instrument is not None
            and is_money_market(t.instrument.symbol, name=t.instrument.name)
        }
        assert acct_id in retained
        flows = ms.build_portfolio_cashflows(txns, retained_cash_account_ids=retained)
        # No positive distribution flow: the swept dividend is retained.
        assert all(cf.amount <= 0 for cf in flows)
