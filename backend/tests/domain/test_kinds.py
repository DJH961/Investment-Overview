"""Canonical kind sets agree with the ORM enum."""

from investment_dashboard.domain import kinds
from investment_dashboard.domain.instruments import is_money_market_effective
from investment_dashboard.models import TransactionKind


def test_kind_constants_match_orm_enum() -> None:
    assert {k.value for k in TransactionKind} >= {
        kinds.BUY,
        kinds.SELL,
        kinds.DIVIDEND_CASH,
        kinds.DIVIDEND_REINVEST,
        kinds.DEPOSIT,
        kinds.WITHDRAWAL,
        kinds.INTEREST,
        kinds.FEE,
        kinds.TRANSFER_IN,
        kinds.TRANSFER_OUT,
        kinds.SPLIT,
    }


def test_set_relations() -> None:
    assert kinds.EXTERNAL_FLOW_KINDS == kinds.CONTRIBUTION_KINDS | kinds.WITHDRAWAL_KINDS
    assert not kinds.NET_POSITIVE_KINDS & kinds.NET_NEGATIVE_KINDS


class _I:
    symbol = "XYZ"
    asset_class = "stock"
    name = "Plain"


class _E:
    asset_class = "mutual_fund"
    name = "Prime Money Market Fund"


def test_effective_override_marks_money_market() -> None:
    assert not is_money_market_effective(_I(), None)
    assert is_money_market_effective(_I(), _E())
