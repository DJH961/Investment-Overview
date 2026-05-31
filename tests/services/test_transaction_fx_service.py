"""Tests for :mod:`investment_dashboard.services.transaction_fx_service`.

Covers the v2.9 "freeze the trade-date legs" behaviour:

* the pure domain split (:func:`split_native_to_dual_legs`),
* the backfill / force-recalculate service over a populated ledger, and
* the read-path consistency guarantee — a row with frozen legs renders the
  same EUR/USD pair whether or not FX history is loaded.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.domain.currency import (
    dual_currency_amounts,
    split_native_to_dual_legs,
)
from investment_dashboard.models import Transaction
from investment_dashboard.repositories import accounts_repo, fx_repo, transactions_repo
from investment_dashboard.services import transaction_fx_service


class TestSplitNativeToDualLegs:
    def test_usd_native_freezes_usd_and_derives_eur(self) -> None:
        net_eur, net_usd = split_native_to_dual_legs(
            native_currency="USD",
            net_native=Decimal("-1000"),
            eur_to_usd_rate=Decimal("1.25"),
        )
        assert net_usd == Decimal("-1000")  # booked verbatim
        assert net_eur == Decimal("-800")  # -1000 / 1.25

    def test_eur_native_freezes_eur_and_derives_usd(self) -> None:
        net_eur, net_usd = split_native_to_dual_legs(
            native_currency="EUR",
            net_native=Decimal("-800"),
            eur_to_usd_rate=Decimal("1.25"),
        )
        assert net_eur == Decimal("-800")
        assert net_usd == Decimal("-1000")  # -800 * 1.25

    def test_missing_rate_leaves_derived_leg_none(self) -> None:
        net_eur, net_usd = split_native_to_dual_legs(
            native_currency="USD",
            net_native=Decimal("-1000"),
            eur_to_usd_rate=None,
        )
        assert net_usd == Decimal("-1000")
        assert net_eur is None

    def test_other_currency_uses_native_rate_then_usd(self) -> None:
        net_eur, net_usd = split_native_to_dual_legs(
            native_currency="GBP",
            net_native=Decimal("-100"),
            eur_to_usd_rate=Decimal("1.25"),
            native_to_eur_rate=Decimal("0.8"),  # 0.8 GBP per EUR
        )
        assert net_eur == Decimal("-125")  # -100 / 0.8
        assert net_usd == Decimal("-156.25")  # -125 * 1.25


def _seed(session: Session, *, native: str) -> int:
    return accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label=f"Acct {native}",
        native_currency=native,
        account_type="brokerage",
    ).id


def _fx(session: Session) -> None:
    fx_repo.upsert_rates(session, {date(2024, 1, 5): Decimal("1.08")})


class TestBackfill:
    def test_compute_legs_stamps_usd_rate_to_eur(self, session: Session) -> None:
        _fx(session)

        legs = transaction_fx_service.compute_legs(
            session,
            native_currency="USD",
            net_native=Decimal("1000"),
            on=date(2024, 1, 5),
        )

        assert legs.fx_rate_to_eur == Decimal(1) / Decimal("1.08")
        assert legs.net_usd == Decimal("1000")
        assert abs((legs.net_eur or Decimal(0)) - Decimal("925.93")) < Decimal("0.01")

    def test_backfill_fills_missing_legs(self, session: Session) -> None:
        account_id = _seed(session, native="USD")
        _fx(session)
        # A row written before the v2.9 freeze: net_usd / net_eur are NULL.
        txn = Transaction(
            account_id=account_id,
            date=date(2024, 1, 5),
            kind="deposit",
            net_native=Decimal("1000"),
            source="manual",
        )
        transactions_repo.insert_transaction(session, txn)

        result = transaction_fx_service.backfill_missing_legs(session)
        assert result.updated == 1
        assert result.incomplete == 0

        refreshed = transactions_repo.get_transaction(session, txn.id)
        assert refreshed is not None
        assert refreshed.net_usd == Decimal("1000")  # USD-native: verbatim
        assert refreshed.net_eur is not None
        assert abs(refreshed.net_eur - Decimal("925.93")) < Decimal("0.01")  # 1000/1.08

    def test_backfill_is_noop_on_healthy_ledger(self, session: Session) -> None:
        account_id = _seed(session, native="USD")
        _fx(session)
        txn = Transaction(
            account_id=account_id,
            date=date(2024, 1, 5),
            kind="deposit",
            net_native=Decimal("1000"),
            net_eur=Decimal("925.93"),
            net_usd=Decimal("1000"),
            source="manual",
        )
        transactions_repo.insert_transaction(session, txn)
        result = transaction_fx_service.backfill_missing_legs(session)
        assert result.updated == 0

    def test_force_recompute_repairs_after_fx_correction(self, session: Session) -> None:
        account_id = _seed(session, native="USD")
        txn = Transaction(
            account_id=account_id,
            date=date(2024, 1, 5),
            kind="deposit",
            net_native=Decimal("1000"),
            net_usd=Decimal("1000"),
            source="manual",
        )
        transactions_repo.insert_transaction(session, txn)
        # No FX yet: EUR leg can't be derived.
        first = transaction_fx_service.backfill_missing_legs(session)
        assert first.incomplete == 1
        # FX arrives; a forced recompute now fills the EUR leg.
        _fx(session)
        second = transaction_fx_service.backfill_missing_legs(session, force=True)
        assert second.incomplete == 0
        refreshed = transactions_repo.get_transaction(session, txn.id)
        assert refreshed is not None
        assert refreshed.net_eur is not None

    def test_missing_fx_dates_lists_gap(self, session: Session) -> None:
        account_id = _seed(session, native="USD")
        txn = Transaction(
            account_id=account_id,
            date=date(2024, 1, 5),
            kind="deposit",
            net_native=Decimal("1000"),
            net_usd=Decimal("1000"),
            source="manual",
        )
        transactions_repo.insert_transaction(session, txn)
        assert transaction_fx_service.missing_fx_dates(session) == [date(2024, 1, 5)]


class TestRenderConsistency:
    def test_frozen_legs_render_without_fx_history(self) -> None:
        # Both legs frozen ⇒ dual_currency_amounts returns them verbatim and
        # never touches the (here empty) FX map.
        eur, usd = dual_currency_amounts(
            native_currency="USD",
            net_native=Decimal("-1000"),
            net_eur=Decimal("-800"),
            net_usd=Decimal("-1000"),
            on=date(2024, 1, 5),
            eur_to_usd={},  # no history at all
        )
        assert eur == Decimal("-800")
        assert usd == Decimal("-1000")

    def test_render_matches_live_derivation(self) -> None:
        rates = {date(2024, 1, 5): Decimal("1.25")}
        live_eur, live_usd = dual_currency_amounts(
            native_currency="USD",
            net_native=Decimal("-1000"),
            net_eur=None,
            net_usd=None,
            on=date(2024, 1, 5),
            eur_to_usd=rates,
        )
        frozen_eur, frozen_usd = dual_currency_amounts(
            native_currency="USD",
            net_native=Decimal("-1000"),
            net_eur=live_eur,
            net_usd=live_usd,
            on=date(2024, 1, 5),
            eur_to_usd={},
        )
        assert (frozen_eur, frozen_usd) == (live_eur, live_usd)


class TestEnsureFxCoverage:
    def test_returns_true_when_history_already_covers(self, session: Session) -> None:
        fx_repo.upsert_rates(session, {date(2024, 1, 1): Decimal("1.1")})
        assert transaction_fx_service.ensure_fx_coverage(
            session, earliest_needed=date(2024, 6, 1), max_attempts=1
        )

    def test_returns_false_when_uncovered_and_offline(self, session: Session) -> None:
        # No history and the network is unavailable in tests ⇒ stays uncovered.
        assert not transaction_fx_service.ensure_fx_coverage(
            session, earliest_needed=date(2024, 1, 1), max_attempts=1
        )
