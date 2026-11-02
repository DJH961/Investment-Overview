"""Map Fidelity CSV ``Action`` strings to ledger ``kind`` values (spec §5.1).

Fidelity reports the action in free-form English (e.g.
``"YOU BOUGHT VANGUARD TOTAL STOCK MARKET ETF"``). We match by uppercased
substring; the first hit wins. Anything that doesn't match raises
:class:`UnknownActionError` so unmapped rows surface as bugs rather than
silently disappearing.
"""

from __future__ import annotations

from collections.abc import Mapping

from investment_dashboard.adapters.importer_types import (
    IGNORE_ACTION,
    UnknownActionError,
    lookup_override,
)

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


def map_action(action: str, overrides: Mapping[str, str] | None = None) -> str | None:
    """Return the ledger ``kind`` for a Fidelity Action string.

    ``overrides`` (setting ``import.action_overrides.fidelity``) maps a whole
    action string (case-insensitive) to a kind, or to ``ignore`` (returns
    ``None``: the row is dropped); it wins over the built-in rules.

    Raises
    ------
    UnknownActionError
        If no rule matches. The importer surfaces this row in the UI so
        the user can decide whether to add a new rule or skip it.
    """
    override = lookup_override(action, overrides)
    if override is not None:
        return None if override == IGNORE_ACTION else override
    upper = action.upper().strip()
    for needle, kind in _RULES:
        if needle in upper:
            return kind
    raise UnknownActionError(f"Unmapped Fidelity action: {action!r}")
