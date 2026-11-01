"""Tests for the manual-entry helpers (services.manual_entry)."""

from __future__ import annotations

from decimal import Decimal

import pytest

from investment_dashboard.services import manual_entry


class TestSignedNet:
    @pytest.mark.parametrize(
        ("kind", "expected"),
        [
            ("buy", Decimal("-100")),
            ("sell", Decimal("100")),
            ("deposit", Decimal("100")),
            ("withdrawal", Decimal("-100")),
            ("transfer_in", Decimal("100")),
            ("transfer_out", Decimal("-100")),
            ("dividend_cash", Decimal("100")),
            ("dividend_reinvest", Decimal("-100")),
            ("interest", Decimal("100")),
            ("fee", Decimal("-100")),
        ],
    )
    def test_sign_is_derived_from_kind(self, kind: str, expected: Decimal) -> None:
        # The user always types a positive magnitude; the kind owns the sign.
        assert manual_entry.signed_net(kind, Decimal("100")) == expected

    def test_user_sign_is_ignored(self) -> None:
        # Even a wrongly-signed magnitude is normalised by the kind (the bug
        # the user hit: logged a sale with the wrong +/- symbol).
        assert manual_entry.signed_net("sell", Decimal("-100")) == Decimal("100")
        assert manual_entry.signed_net("buy", Decimal("100")) == Decimal("-100")

    def test_split_carries_no_cash(self) -> None:
        assert manual_entry.signed_net("split", Decimal("100")) is None

    def test_missing_magnitude(self) -> None:
        assert manual_entry.signed_net("buy", None) is None


class TestReconcileTrade:
    def test_fills_total_from_qty_and_price(self) -> None:
        figs = manual_entry.reconcile_trade(Decimal("10"), Decimal("5"), None)
        assert figs.total == Decimal("50")
        assert figs.error is None

    def test_fills_price_from_qty_and_total(self) -> None:
        figs = manual_entry.reconcile_trade(Decimal("10"), None, Decimal("50"))
        assert figs.price == Decimal("5")
        assert figs.error is None

    def test_fills_qty_from_price_and_total(self) -> None:
        figs = manual_entry.reconcile_trade(None, Decimal("5"), Decimal("50"))
        assert figs.quantity == Decimal("10")
        assert figs.error is None

    def test_all_three_consistent(self) -> None:
        figs = manual_entry.reconcile_trade(Decimal("10"), Decimal("5"), Decimal("50"))
        assert figs.error is None

    def test_all_three_within_tolerance(self) -> None:
        # 10 * 5.001 = 50.01, total 50 — inside the 1% slack.
        figs = manual_entry.reconcile_trade(Decimal("10"), Decimal("5.001"), Decimal("50"))
        assert figs.error is None

    def test_all_three_mismatch_flags_error(self) -> None:
        figs = manual_entry.reconcile_trade(Decimal("10"), Decimal("5"), Decimal("80"))
        assert figs.error is not None
        assert "doesn't match" in figs.error

    def test_too_few_values_is_a_noop(self) -> None:
        figs = manual_entry.reconcile_trade(Decimal("10"), None, None)
        assert figs.error is None
        assert figs.total is None

    def test_zero_price_with_total_is_flagged(self) -> None:
        figs = manual_entry.reconcile_trade(None, Decimal("0"), Decimal("50"))
        assert figs.error is not None


class TestMoneyMarketLeg:
    def test_transfer_in_buys_fund_shares(self) -> None:
        # transfer_in net is +X (cash in); the fund is filled (buy at $1).
        leg = manual_entry.money_market_leg("transfer_in", Decimal("500"))
        assert leg is not None
        assert leg.kind == "buy"
        assert leg.quantity == Decimal("500")
        assert leg.price == Decimal("1")
        assert leg.net_native == Decimal("-500")

    def test_transfer_out_sells_fund_shares(self) -> None:
        leg = manual_entry.money_market_leg("transfer_out", Decimal("-500"))
        assert leg is not None
        assert leg.kind == "sell"
        assert leg.quantity == Decimal("-500")
        assert leg.net_native == Decimal("500")

    def test_deposit_and_withdrawal_trigger(self) -> None:
        assert manual_entry.money_market_leg("deposit", Decimal("100")) is not None
        assert manual_entry.money_market_leg("withdrawal", Decimal("-100")) is not None

    def test_non_cash_kinds_do_not_trigger(self) -> None:
        assert manual_entry.money_market_leg("buy", Decimal("-100")) is None
        assert manual_entry.money_market_leg("sell", Decimal("100")) is None
        assert manual_entry.money_market_leg("dividend_cash", Decimal("5")) is None

    def test_zero_or_missing_net(self) -> None:
        assert manual_entry.money_market_leg("deposit", Decimal("0")) is None
        assert manual_entry.money_market_leg("deposit", None) is None


class TestSettlementLegValues:
    """Kind-agnostic settlement leg builder used when re-syncing an edit."""

    def test_cash_in_buys_shares(self) -> None:
        leg = manual_entry.settlement_leg_values(Decimal("500"))
        assert leg is not None
        assert leg.kind == "buy"
        assert leg.quantity == Decimal("500")
        assert leg.price == Decimal("1")
        assert leg.net_native == Decimal("-500")

    def test_cash_out_sells_shares(self) -> None:
        leg = manual_entry.settlement_leg_values(Decimal("-500"))
        assert leg is not None
        assert leg.kind == "sell"
        assert leg.quantity == Decimal("-500")
        assert leg.net_native == Decimal("500")

    def test_ignores_kind_gate(self) -> None:
        # Unlike money_market_leg, this builds a leg for *any* non-zero flow
        # (the importer pairs a leg with buys/sells too).
        assert manual_entry.settlement_leg_values(Decimal("-100")) is not None

    def test_zero_or_missing_net(self) -> None:
        assert manual_entry.settlement_leg_values(Decimal("0")) is None
        assert manual_entry.settlement_leg_values(None) is None


class TestSignedQuantity:
    def test_buy_is_positive(self) -> None:
        assert manual_entry.signed_quantity("buy", Decimal("10")) == Decimal("10")

    def test_sell_is_negative(self) -> None:
        assert manual_entry.signed_quantity("sell", Decimal("10")) == Decimal("-10")
        # Even a wrongly-signed input is normalised.
        assert manual_entry.signed_quantity("sell", Decimal("-10")) == Decimal("-10")

    def test_reinvest_and_split_positive(self) -> None:
        assert manual_entry.signed_quantity("dividend_reinvest", Decimal("3")) == Decimal("3")
        assert manual_entry.signed_quantity("split", Decimal("3")) == Decimal("3")

    def test_missing(self) -> None:
        assert manual_entry.signed_quantity("buy", None) is None
