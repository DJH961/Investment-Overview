"""Built-in ETF "twin" suggestions for mutual funds (pure, no I/O).

A mutual fund prints one NAV a day, hours after the 16:00 New York close. During
the session the 1D graph can estimate the fund from an ETF that moves with it
(see :mod:`investment_dashboard.domain.late_data`). The owner picks the twin per
instrument on the Instruments page; nothing here is applied automatically.

Two tiers, both only suggestions:

* ``"same_index"`` - the fund and the ETF track **the exact same index**, or are
  share classes of the same Vanguard portfolio. Compiled from each fund's stated
  benchmark (one comment per row names it).
* ``"close"`` - the fund's index has no ETF, but an ETF on a different index
  follows its daily moves as tightly as an identical pair does. Measured over 250
  trading days of daily returns (adjusted closes): typical daily gap / 95 % of
  days within. For scale, the identical pair FXAIX vs VOO measured 0.024 % /
  0.068 %.

Deliberately **not** listed (no identical-index ETF and no measured close twin):
FZILX (Fidelity ZERO International, proprietary index; VXUS measured 0.115 %
typical, too loose) and FSELX (actively managed). The owner can still type any
ETF by hand for those.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

TwinTier = Literal["same_index", "close"]

TIER_SAME_INDEX: TwinTier = "same_index"
TIER_CLOSE: TwinTier = "close"


@dataclass(frozen=True)
class TwinSuggestion:
    """One suggested ETF twin for a fund."""

    fund: str
    etf: str
    tier: TwinTier
    #: The index (or indexes) the pair follows, for the label on the Instruments page.
    index: str
    #: Measured typical daily gap as a fraction (``0.0002`` = 0.02 %), close tier only.
    typical_daily_gap: str | None = None


def _same(fund: str, etf: str, index: str) -> TwinSuggestion:
    return TwinSuggestion(fund, etf, TIER_SAME_INDEX, index)


_SAME_INDEX: tuple[TwinSuggestion, ...] = (
    # -- Fidelity index funds vs an ETF on the identical index --------------------
    _same("FXAIX", "VOO", "S&P 500"),
    _same("FSPSX", "EFA", "MSCI EAFE"),
    _same("FTIHX", "IXUS", "MSCI ACWI ex USA IMI"),
    _same("FXNAX", "AGG", "Bloomberg US Aggregate Bond"),
    _same("FSMDX", "IWR", "Russell Midcap"),
    _same("FSSNX", "IWM", "Russell 2000"),
    _same("FSGGX", "ACWX", "MSCI ACWI ex USA"),
    _same("FSPGX", "IWF", "Russell 1000 Growth"),
    _same("FLCOX", "IWD", "Russell 1000 Value"),
    _same("FPADX", "EEM", "MSCI Emerging Markets"),
    # -- Vanguard: same portfolio, ETF share class (Admiral + Investor) -----------
    _same("VTSAX", "VTI", "CRSP US Total Market"),
    _same("VTSMX", "VTI", "CRSP US Total Market"),
    _same("VFIAX", "VOO", "S&P 500"),
    _same("VFINX", "VOO", "S&P 500"),
    _same("VTIAX", "VXUS", "FTSE Global All Cap ex US"),
    _same("VGTSX", "VXUS", "FTSE Global All Cap ex US"),
    _same("VBTLX", "BND", "Bloomberg US Aggregate Float Adjusted"),
    _same("VBMFX", "BND", "Bloomberg US Aggregate Float Adjusted"),
    _same("VTMGX", "VEA", "FTSE Developed All Cap ex US"),
    _same("VEMAX", "VWO", "FTSE Emerging Markets All Cap China A Inclusion"),
    _same("VIMAX", "VO", "CRSP US Mid Cap"),
    _same("VSMAX", "VB", "CRSP US Small Cap"),
    _same("VGSLX", "VNQ", "MSCI US IMI Real Estate 25/50"),
    _same("VTWAX", "VT", "FTSE Global All Cap"),
    _same("VIGAX", "VUG", "CRSP US Large Cap Growth"),
    _same("VVIAX", "VTV", "CRSP US Large Cap Value"),
    _same("VTABX", "BNDX", "Bloomberg Global Aggregate ex-USD Float Adj. (USD hedged)"),
    _same("VEXAX", "VXF", "S&P Completion"),
    _same("VDADX", "VIG", "S&P US Dividend Growers"),
    _same("VHYAX", "VYM", "FTSE High Dividend Yield"),
    _same("VSIAX", "VBR", "CRSP US Small Cap Value"),
    _same("VSGAX", "VBK", "CRSP US Small Cap Growth"),
    _same("VFWAX", "VEU", "FTSE All-World ex US"),
    _same("VBIRX", "BSV", "Bloomberg US 1-5 Year Gov/Credit Float Adjusted"),
    _same("VBILX", "BIV", "Bloomberg US 5-10 Year Gov/Credit Float Adjusted"),
    _same("VBLAX", "BLV", "Bloomberg US Long Gov/Credit Float Adjusted"),
)

_CLOSE: tuple[TwinSuggestion, ...] = (
    # FSKAX: Dow Jones U.S. Total Stock Market (no ETF) vs VTI (CRSP US Total Market).
    # 250 days: typical gap 0.019 %, 95 % within 0.070 %, correlation 0.99896.
    TwinSuggestion(
        "FSKAX",
        "VTI",
        TIER_CLOSE,
        "Dow Jones U.S. Total Stock Market vs CRSP US Total Market",
        "0.00019",
    ),
    # FZROX: Fidelity U.S. Total Investable Market (proprietary) vs VTI.
    # 250 days: typical gap 0.020 %, 95 % within 0.073 %.
    TwinSuggestion(
        "FZROX",
        "VTI",
        TIER_CLOSE,
        "Fidelity U.S. Total Investable Market vs CRSP US Total Market",
        "0.00020",
    ),
    # FNILX: Fidelity U.S. Large Cap (proprietary) vs VOO (S&P 500).
    # 250 days: typical gap 0.029 %, 95 % within 0.108 %.
    TwinSuggestion("FNILX", "VOO", TIER_CLOSE, "Fidelity U.S. Large Cap vs S&P 500", "0.00029"),
)

_BY_FUND: dict[str, TwinSuggestion] = {s.fund: s for s in (*_SAME_INDEX, *_CLOSE)}


def all_suggestions() -> tuple[TwinSuggestion, ...]:
    """Every built-in suggestion, identical-index tier first."""
    return (*_SAME_INDEX, *_CLOSE)


def suggest_twin(symbol: str | None) -> TwinSuggestion | None:
    """The built-in twin for a fund ticker (case-insensitive), or ``None``."""
    if not symbol:
        return None
    return _BY_FUND.get(symbol.strip().upper())
