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
    if name and "money market" in name.lower():
        return True
    return False
