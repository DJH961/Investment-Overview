"""Money-market fund helpers.

Brokerage *settlement* / *core* funds (Vanguard ``VMFXX``, Fidelity
``SPAXX`` …) hold uninvested cash. They have no tradeable price on
yfinance, so without special handling their positions value to ``0`` —
which makes monthly/yearly **closing values** understate the portfolio by
the whole uninvested-cash balance, and gives the funds a wildly inflated
growth percentage (cost basis ≫ a zero current value).

These funds maintain a **constant $1.00 NAV** by design, so we price them
at par instead of asking the price provider. One share == one dollar of
settlement cash.
"""

from __future__ import annotations

from decimal import Decimal

#: Constant net asset value of a money-market fund share (USD).
MONEY_MARKET_NAV = Decimal(1)

#: ``external_id`` suffix that marks an auto-generated settlement (money-market)
#: leg paired to a cash-moving *parent* transaction. The importer tags every
#: VMFXX counter-leg with ``{parent.external_id}:vmfxx`` (see
#: ``adapters/vanguard/settlement.py``); the ledger view hides these rows by
#: default, and edit/delete use the link to keep the leg in sync with its
#: parent so the settlement balance never silently diverges.
SETTLEMENT_EXTERNAL_ID_SUFFIX = ":vmfxx"


def settlement_external_id_for(parent_external_id: str) -> str:
    """Return the settlement leg's ``external_id`` for a given parent's id."""
    return f"{parent_external_id}{SETTLEMENT_EXTERNAL_ID_SUFFIX}"


def is_settlement_external_id(external_id: str | None) -> bool:
    """Return ``True`` if ``external_id`` marks an auto settlement leg."""
    return external_id is not None and external_id.endswith(SETTLEMENT_EXTERNAL_ID_SUFFIX)


#: Description prefix stamped on a *manually*-triggered settlement leg (the
#: auto-leg the manual-entry form pairs with a deposit/withdrawal/transfer).
#: Used both to label new legs and to recognise legacy ones that predate the
#: ``:vmfxx`` external-id link, so editing/deleting their parent can still find
#: and keep them in sync.
MANUAL_SETTLEMENT_DESCRIPTION_PREFIX = "Money-market settlement (auto)"

#: Asset-class tag used when seeding money-market / settlement funds. They
#: are technically mutual funds; we keep them in the existing taxonomy and
#: identify them by ticker/name (see :func:`is_money_market`) rather than
#: adding a new ``asset_class`` value that would require a DB constraint
#: migration on existing installs.
MONEY_MARKET_ASSET_CLASS = "mutual_fund"

#: Well-known settlement / core money-market fund tickers.
MONEY_MARKET_SYMBOLS: frozenset[str] = frozenset(
    {
        # Vanguard
        "VMFXX",
        "VMRXX",
        "VUSXX",
        # Fidelity
        "SPAXX",
        "FDRXX",
        "SPRXX",
        "FZFXX",
        "FDLXX",
        "FCASH",
        # Schwab
        "SWVXX",
        "SNVXX",
        "SNSXX",
    }
)


def is_money_market(
    symbol: str | None,
    *,
    asset_class: str | None = None,
    name: str | None = None,
) -> bool:
    """Return ``True`` if the instrument is a money-market / settlement fund.

    Detection is by known ticker or by a name that mentions "money market".
    ``asset_class`` is accepted for call-site symmetry but intentionally not
    used on its own: money-market funds share the broad ``mutual_fund`` class
    with ordinary funds, so it is not a reliable discriminator.
    """
    if symbol and symbol.strip().upper() in MONEY_MARKET_SYMBOLS:
        return True
    return bool(name and "money market" in name.lower())
