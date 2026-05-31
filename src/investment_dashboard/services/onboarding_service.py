"""Onboarding service — first-run detection and "seed default setup".

Whenever the dashboard is opened on a fresh database (or one that the
user has reset) the UI redirects to ``/onboarding``. From there the user
can either seed the default broker + instrument set from the project
spec (§1.3, §2 instruments list) or skip and add things manually from
``/settings``.

The default seed mirrors the user's existing Excel spreadsheet:

* **Accounts** — one each for Vanguard (USD brokerage), Fidelity (USD
  brokerage) and Direct Savings Bank (EUR savings).
* **Instruments** — every ticker mentioned in spec §2 plus the synthetic
  ``SAVINGS_CASH`` line used by the Tagesgeldkonto.

Each seeding helper is idempotent: re-running the seed never duplicates
rows (it uses ``broker``+``account_label`` and ``symbol`` as natural
keys), so the user can safely re-invoke it after adding their own
entries.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.models import Account
from investment_dashboard.repositories import (
    accounts_repo,
    instrument_overrides_repo,
    instruments_repo,
)
from investment_dashboard.services.ticker_validation_service import (
    TickerValidation,
    validate_ticker,
)


@dataclass(frozen=True)
class _SeedAccount:
    broker: str
    account_label: str
    native_currency: str
    account_type: str


@dataclass(frozen=True)
class _SeedInstrument:
    symbol: str
    name: str
    asset_class: str
    category: str
    native_currency: str
    expense_ratio: Decimal | None = None


#: Default broker accounts (spec §1.3).
DEFAULT_ACCOUNTS: tuple[_SeedAccount, ...] = (
    _SeedAccount("vanguard", "Vanguard Brokerage", "USD", "brokerage"),
    _SeedAccount("fidelity", "Fidelity Brokerage", "USD", "brokerage"),
    _SeedAccount("savings_bank", "Direct Savings (Tagesgeld)", "EUR", "savings"),
)


#: Default instruments — the tickers listed in spec §2 plus the synthetic
#: Savings cash position. Expense ratios are best-effort and editable
#: from /settings after the seed.
DEFAULT_INSTRUMENTS: tuple[_SeedInstrument, ...] = (
    _SeedInstrument(
        "VTI", "Vanguard Total Stock Market ETF", "etf", "Total US", "USD", Decimal("0.0003")
    ),
    _SeedInstrument("VOO", "Vanguard S&P 500 ETF", "etf", "S&P 500", "USD", Decimal("0.0003")),
    _SeedInstrument("VUG", "Vanguard Growth ETF", "etf", "Growth", "USD", Decimal("0.0004")),
    _SeedInstrument("VTV", "Vanguard Value ETF", "etf", "Value", "USD", Decimal("0.0004")),
    _SeedInstrument(
        "VXUS",
        "Vanguard Total International Stock ETF",
        "etf",
        "International",
        "USD",
        Decimal("0.0005"),
    ),
    _SeedInstrument("VGK", "Vanguard FTSE Europe ETF", "etf", "Europe", "USD", Decimal("0.0006")),
    _SeedInstrument(
        "VT", "Vanguard Total World Stock ETF", "etf", "World", "USD", Decimal("0.0006")
    ),
    _SeedInstrument(
        "VWO", "Vanguard FTSE Emerging Markets ETF", "etf", "Emerging", "USD", Decimal("0.0007")
    ),
    _SeedInstrument("SCHK", "Schwab 1000 Index ETF", "etf", "Total US", "USD", Decimal("0.0003")),
    _SeedInstrument("IAUM", "iShares Gold Trust Micro", "etf", "Gold", "USD", Decimal("0.0009")),
    _SeedInstrument("MSFT", "Microsoft Corporation", "stock", "US Single Stock", "USD"),
    _SeedInstrument(
        "FXAIX", "Fidelity 500 Index Fund", "mutual_fund", "S&P 500", "USD", Decimal("0.00015")
    ),
    _SeedInstrument(
        "FSKAX",
        "Fidelity Total Market Index Fund",
        "mutual_fund",
        "Total US",
        "USD",
        Decimal("0.00015"),
    ),
    _SeedInstrument(
        "FSPSX",
        "Fidelity International Index Fund",
        "mutual_fund",
        "International",
        "USD",
        Decimal("0.00035"),
    ),
    _SeedInstrument(
        "FTIHX",
        "Fidelity Total International Index Fund",
        "mutual_fund",
        "International",
        "USD",
        Decimal("0.00060"),
    ),
    _SeedInstrument(
        "SCHD", "Schwab US Dividend Equity ETF", "etf", "Dividend", "USD", Decimal("0.0006")
    ),
    _SeedInstrument(
        "FSELX",
        "Fidelity Select Semiconductors Portfolio",
        "mutual_fund",
        "Sector",
        "USD",
        Decimal("0.0066"),
    ),
    _SeedInstrument("DAX", "Global X DAX Germany ETF", "etf", "DAX", "USD", Decimal("0.0020")),
    _SeedInstrument(
        "SAVINGS_CASH", "Direct Savings (Tagesgeld) balance", "savings", "Cash", "EUR"
    ),
)


@dataclass(frozen=True)
class SeedResult:
    """Counts of rows inserted by a seed run (zero for already-present ones)."""

    accounts_created: int
    instruments_created: int


def is_onboarded(session: Session) -> bool:
    """True once the user has at least one account."""
    return bool(list(accounts_repo.list_accounts(session)))


def seed_default_setup(session: Session) -> SeedResult:
    """Create the default Vanguard/Fidelity/Savings accounts + instruments.

    Idempotent — existing rows are left alone. Returns the count of rows
    actually inserted so the UI can show a meaningful summary.
    """
    accounts_created = 0
    existing_accounts: dict[tuple[str, str], Account] = {
        (a.broker, a.account_label): a for a in accounts_repo.list_accounts(session)
    }
    for seed in DEFAULT_ACCOUNTS:
        if (seed.broker, seed.account_label) in existing_accounts:
            continue
        accounts_repo.create_account(
            session,
            broker=seed.broker,
            account_label=seed.account_label,
            native_currency=seed.native_currency,
            account_type=seed.account_type,
        )
        accounts_created += 1

    instruments_created = 0
    for instr in DEFAULT_INSTRUMENTS:
        existing = instruments_repo.get_by_symbol(session, instr.symbol)
        if existing is not None:
            # Idempotent: only seed the override category if it isn't
            # already set (the user may have customised it).
            if (
                instr.category
                and instrument_overrides_repo.get_category(session, existing.id) is None
            ):
                instrument_overrides_repo.set_category(session, existing.id, instr.category)
            # Repair placeholder metadata on a row that was created by the
            # importer (or an older seed) before the canonical preset facts
            # were known — e.g. a DAX line left as ``unknown`` / no TER. Only
            # missing or placeholder fields are filled, so deliberate user
            # edits (a real name, a chosen asset class) are never clobbered.
            _repair_preset_metadata(session, existing, instr)
            continue
        created = instruments_repo.get_or_create(
            session,
            symbol=instr.symbol,
            name=instr.name,
            asset_class=instr.asset_class,
            native_currency=instr.native_currency,
            expense_ratio=instr.expense_ratio,
        )
        if instr.category:
            instrument_overrides_repo.set_category(session, created.id, instr.category)
        instruments_created += 1

    return SeedResult(
        accounts_created=accounts_created,
        instruments_created=instruments_created,
    )


def _repair_preset_metadata(
    session: Session,
    existing: object,
    seed: _SeedInstrument,
) -> None:
    """Fill missing/placeholder ledger metadata on an existing preset row.

    Conservative on purpose: a field is only written when the stored value is
    absent or a placeholder (no name, ``unknown`` asset class, no expense
    ratio), so a user's deliberate customisation survives a re-seed. The
    canonical preset values come straight from the issuer, so this lets a
    re-seed repair an instrument (e.g. DAX) that an import created with stub
    metadata.
    """
    name = seed.name if not getattr(existing, "name", None) else None
    asset_class = seed.asset_class if getattr(existing, "asset_class", None) == "unknown" else None
    expense_ratio = (
        seed.expense_ratio
        if (seed.expense_ratio is not None and getattr(existing, "expense_ratio", None) is None)
        else None
    )
    if name is None and asset_class is None and expense_ratio is None:
        return
    instruments_repo.update_instrument(
        session,
        existing.id,  # type: ignore[attr-defined]
        name=name,
        asset_class=asset_class,
        expense_ratio=expense_ratio,
    )


class InvalidTickerError(ValueError):
    """Raised when a caller tries to seed a ticker that didn't validate."""


def add_validated_instrument(
    session: Session,
    symbol: str,
    *,
    category: str | None = None,
    asset_class: str | None = None,
    native_currency: str | None = None,
    name: str | None = None,
    expense_ratio: Decimal | None = None,
    validator: object | None = None,
) -> TickerValidation:
    """Validate ``symbol`` and, only if it resolves, persist the instrument.

    This is the *validated path* the onboarding wizard offers so the user can
    add their own tickers (e.g. the DAX ETF) without risking a typo'd or
    wrong-exchange symbol that never prices. The provider-resolved metadata is
    used to fill any field the caller didn't override.

    Returns the :class:`TickerValidation` so the UI can show the resolved
    name / price. Raises :class:`InvalidTickerError` when the symbol does not
    validate — nothing is written in that case.
    """
    validate = validator or validate_ticker
    result: TickerValidation = validate(symbol)  # type: ignore[operator]
    if not result.valid:
        raise InvalidTickerError(result.message)

    instruments_repo.get_or_create(
        session,
        symbol=result.symbol,
        name=name or result.name,
        asset_class=(asset_class or result.asset_class or "unknown"),
        native_currency=(native_currency or result.native_currency or "USD"),
        expense_ratio=(expense_ratio if expense_ratio is not None else result.expense_ratio),
    )
    if category:
        created = instruments_repo.get_by_symbol(session, result.symbol)
        if (
            created is not None
            and instrument_overrides_repo.get_category(session, created.id) is None
        ):
            instrument_overrides_repo.set_category(session, created.id, category)
    return result
