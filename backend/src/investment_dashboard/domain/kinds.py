"""Canonical transaction-kind sets (pure strings, no ORM import).

Every module that needs "which kinds move external cash / shares / net sign"
imports from here. Values mirror ``models.TransactionKind`` (a test pins the
two together) so the domain layer stays free of ORM imports.
"""

from __future__ import annotations

BUY = "buy"
SELL = "sell"
DIVIDEND_CASH = "dividend_cash"
DIVIDEND_REINVEST = "dividend_reinvest"
DEPOSIT = "deposit"
WITHDRAWAL = "withdrawal"
INTEREST = "interest"
FEE = "fee"
TRANSFER_IN = "transfer_in"
TRANSFER_OUT = "transfer_out"
SPLIT = "split"

# Kinds that move *external* cash (the user's bank <-> portfolio).
# ``transfer_in`` / ``transfer_out`` model inter-account or in-kind moves: a
# transfer between two *tracked* accounts records both legs, so counting
# ``transfer_in`` as a contribution and ``transfer_out`` as a withdrawal nets to
# zero at the portfolio level, while a move that crosses the tracked boundary
# (only one leg exists) is correctly treated as an external flow.
CONTRIBUTION_KINDS: frozenset[str] = frozenset({DEPOSIT, TRANSFER_IN})
WITHDRAWAL_KINDS: frozenset[str] = frozenset({WITHDRAWAL, TRANSFER_OUT})
#: Contributions + withdrawals: the moves that change the cumulative baseline.
EXTERNAL_FLOW_KINDS: frozenset[str] = CONTRIBUTION_KINDS | WITHDRAWAL_KINDS
#: Kinds that receive cash not represented in the current portfolio value.
DISTRIBUTION_KINDS: frozenset[str] = frozenset({DIVIDEND_CASH, INTEREST})
#: Dividend income rows (cash legs plus reinvested distributions).
DIVIDEND_KINDS: frozenset[str] = frozenset({DIVIDEND_CASH, DIVIDEND_REINVEST})
#: Share-count kinds that move the running holding total (a cash dividend does not).
SHARE_MOVING_KINDS: frozenset[str] = frozenset({BUY, SELL, DIVIDEND_REINVEST, SPLIT})
#: Kinds whose booked cash flow is **into** the account (positive net).
NET_POSITIVE_KINDS: frozenset[str] = frozenset(
    {SELL, DEPOSIT, DIVIDEND_CASH, INTEREST, TRANSFER_IN}
)
#: Kinds whose booked cash flow is **out of** the account (negative net).
NET_NEGATIVE_KINDS: frozenset[str] = frozenset(
    {BUY, WITHDRAWAL, FEE, TRANSFER_OUT, DIVIDEND_REINVEST}
)
#: Trade kinds for which ``quantity x price`` should reconcile with ``total``.
TRADE_KINDS: frozenset[str] = frozenset({BUY, SELL, DIVIDEND_REINVEST})
