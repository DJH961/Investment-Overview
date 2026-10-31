"""Data assembly for the Calculator page.

Builds the per-instrument facts the in-page allocation builder needs — current
EUR value, current weight, category, and an EUR-denominated price for share
math — grouped by category so the user can think in categories ("10 %
International") and let the funds inside share that slice automatically.

Kept separate from :mod:`investment_dashboard.ui.pages.calculator` so the page
stays a thin view layer and this query is reusable / inspectable.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.domain.allocation import current_weights_pct
from investment_dashboard.repositories import instrument_overrides_repo, instruments_repo
from investment_dashboard.services import display_currency_service
from investment_dashboard.services.instrument_enrichment_service import effective_instrument
from investment_dashboard.services.positions_service import compute_positions
from investment_dashboard.services.prices_service import latest_closes

ZERO = Decimal(0)
UNCATEGORIZED = "Uncategorized"


@dataclass(frozen=True)
class CalcInstrument:
    """One investable instrument with the facts the calculator needs."""

    instrument_id: int
    symbol: str
    name: str
    category: str
    current_value_eur: Decimal
    current_pct: Decimal
    price_eur: Decimal | None


@dataclass(frozen=True)
class CalcCategory:
    """A category bucket grouping its member instruments."""

    name: str
    current_value_eur: Decimal
    current_pct: Decimal
    members: list[CalcInstrument] = field(default_factory=list)


@dataclass(frozen=True)
class CalcData:
    """Everything the calculator page needs to render its allocation builder."""

    instruments: list[CalcInstrument]
    categories: list[CalcCategory]
    fx_rate_usd_per_eur: Decimal | None
    default_currency: str

    @property
    def total_value_eur(self) -> Decimal:
        return sum((i.current_value_eur for i in self.instruments), start=ZERO)

    def by_id(self) -> dict[int, CalcInstrument]:
        return {i.instrument_id: i for i in self.instruments}


def _category_label(category: str | None, asset_class: str | None) -> str:
    """Mirror the Overview treemap bucketing: category → asset_class → fallback."""
    return category or asset_class or UNCATEGORIZED


def _price_to_eur(
    native_price: Decimal | None,
    native_currency: str,
    fx_rate_usd_per_eur: Decimal | None,
) -> Decimal | None:
    """Convert a native close to EUR for share math (EUR/USD only)."""
    if native_price is None or native_price <= ZERO:
        return None
    ccy = (native_currency or "EUR").upper()
    if ccy == "EUR":
        return native_price
    if ccy == "USD" and fx_rate_usd_per_eur and fx_rate_usd_per_eur > ZERO:
        return native_price / fx_rate_usd_per_eur
    # Unknown currency with no rate — leave priceless (share count unavailable).
    return None


def build_calculator_data(session: Session) -> CalcData:
    """Assemble the calculator's per-instrument / per-category data set.

    Includes every instrument (held or not) so the user can target a fund they
    don't yet own. Inactive instruments are skipped so the builder is not
    cluttered with retired tickers.
    """
    default_ccy = display_currency_service.get_display_currency(session)
    fx_rate = display_currency_service.current_rate(session, quote="USD")

    positions = compute_positions(session)
    value_by_id: dict[int, Decimal] = {}
    for p in positions:
        value_by_id[p.instrument.id] = value_by_id.get(p.instrument.id, ZERO) + p.current_value_eur

    inactive = instrument_overrides_repo.inactive_ids(session)
    overrides = instrument_overrides_repo.get_override_map(session)
    instruments = [i for i in instruments_repo.list_instruments(session) if i.id not in inactive]
    prices = latest_closes(session, [i.id for i in instruments])

    pct_by_id = current_weights_pct({i.id: value_by_id.get(i.id, ZERO) for i in instruments})

    calc_instruments: list[CalcInstrument] = []
    category_order: list[str] = []
    by_category: dict[str, list[CalcInstrument]] = {}
    for instr in instruments:
        eff = effective_instrument(instr, overrides.get(instr.id))
        category = _category_label(eff.category, eff.asset_class)
        ci = CalcInstrument(
            instrument_id=instr.id,
            symbol=eff.symbol,
            name=eff.name or eff.symbol,
            category=category,
            current_value_eur=value_by_id.get(instr.id, ZERO),
            current_pct=pct_by_id.get(instr.id, ZERO),
            price_eur=_price_to_eur(prices.get(instr.id), instr.native_currency, fx_rate),
        )
        calc_instruments.append(ci)
        if category not in by_category:
            by_category[category] = []
            category_order.append(category)
        by_category[category].append(ci)

    total = sum((i.current_value_eur for i in calc_instruments), start=ZERO)
    categories: list[CalcCategory] = []
    for name in category_order:
        members = by_category[name]
        cat_value = sum((m.current_value_eur for m in members), start=ZERO)
        cat_pct = (cat_value * Decimal(100) / total) if total > ZERO else ZERO
        categories.append(
            CalcCategory(
                name=name,
                current_value_eur=cat_value,
                current_pct=cat_pct,
                members=members,
            )
        )
    # Heaviest categories first so the builder leads with what matters.
    categories.sort(key=lambda c: c.current_value_eur, reverse=True)

    return CalcData(
        instruments=calc_instruments,
        categories=categories,
        fx_rate_usd_per_eur=fx_rate,
        default_currency=default_ccy,
    )
