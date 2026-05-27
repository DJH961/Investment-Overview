"""Map Vanguard CSV ``Transaction Type`` to ledger ``kind`` (spec §5.2).

``Sweep In`` / ``Sweep Out`` rows are *internal* settlement-fund moves —
they double-count cash if imported, so we map them to ``None`` and the
parser discards them.
"""

from __future__ import annotations

from investment_dashboard.adapters.importer_types import UnknownActionError

# value of None means "drop this row".
_RULES: dict[str, str | None] = {
    "buy": "buy",
    "sell": "sell",
    "reinvestment": "dividend_reinvest",
    "dividend": "dividend_cash",
    "dividend received": "dividend_cash",
    "funds received": "deposit",
    # Vanguard's Full-History export labels post-settlement corrections to
    # incoming wires as "Funds Received (adjustment)" — still a deposit.
    "funds received (adjustment)": "deposit",
    "transfer (incoming)": "deposit",
    "transfer in": "deposit",
    "funds withdrawn": "withdrawal",
    "transfer (outgoing)": "withdrawal",
    "transfer out": "withdrawal",
    "fee": "fee",
    "stock split": "split",
    "sweep in": None,
    "sweep out": None,
}


def map_transaction_type(txn_type: str) -> str | None:
    """Map a Vanguard ``Transaction Type``. Returns ``None`` for sweeps.

    Raises
    ------
    UnknownActionError
        If no rule matches.
    """
    key = txn_type.strip().lower()
    if key in _RULES:
        return _RULES[key]
    raise UnknownActionError(f"Unmapped Vanguard transaction type: {txn_type!r}")
