"""Map Fidelity CSV ``Action`` strings to ledger ``kind`` values (spec §5.1).

Fidelity reports the action in free-form English (e.g.
``"YOU BOUGHT VANGUARD TOTAL STOCK MARKET ETF"``). We match by uppercased
substring; the first hit wins. Anything that doesn't match raises
:class:`UnknownActionError` so unmapped rows surface as bugs rather than
silently disappearing.
"""

from __future__ import annotations

from investment_dashboard.adapters.importer_types import UnknownActionError

# Order matters: more specific patterns first.
_RULES: tuple[tuple[str, str], ...] = (
    ("YOU BOUGHT", "buy"),
    ("YOU SOLD", "sell"),
    ("REINVESTMENT", "dividend_reinvest"),
    ("DIVIDEND RECEIVED", "dividend_cash"),
    # Fund capital-gain distributions are paid out like dividends — the
    # short/long-term flavour is purely a tax classification and is not
    # tracked separately in the ledger.
    ("LONG-TERM CAP GAIN", "dividend_cash"),
    ("SHORT-TERM CAP GAIN", "dividend_cash"),
    # Generic "DISTRIBUTION" on a holding (e.g. SCHD) is also a cash payout.
    ("DISTRIBUTION", "dividend_cash"),
    ("INTEREST EARNED", "interest"),
    ("ELECTRONIC FUNDS TRANSFER RECEIVED", "deposit"),
    ("EFT FUNDS RECEIVED", "deposit"),
    ("ELECTRONIC FUNDS TRANSFER PAID", "withdrawal"),
    ("EFT FUNDS PAID", "withdrawal"),
    ("FOREIGN TAX PAID", "fee"),
    ("FEE", "fee"),
)


def map_action(action: str) -> str:
    """Return the ledger ``kind`` for a Fidelity Action string.

    Raises
    ------
    UnknownActionError
        If no rule matches. The importer surfaces this row in the UI so
        the user can decide whether to add a new rule or skip it.
    """
    upper = action.upper().strip()
    for needle, kind in _RULES:
        if needle in upper:
            return kind
    raise UnknownActionError(f"Unmapped Fidelity action: {action!r}")
