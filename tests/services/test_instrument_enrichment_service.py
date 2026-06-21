"""Tests for the v2.2 phase (b) instrument-enrichment service."""

from __future__ import annotations

from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.adapters.yfinance_client import InstrumentInfo
from investment_dashboard.models import InstrumentOverride
from investment_dashboard.repositories import instrument_overrides_repo, instruments_repo
from investment_dashboard.services.instrument_enrichment_service import (
    QUOTE_TYPE_MAP,
    InstrumentSuggestion,
    effective_instrument,
    enrich_instrument,
    ensure_instrument,
    suggest_instrument_fields,
)


def _fake_fetcher(payloads: dict[str, InstrumentInfo | None]):
    def _fetch(symbol: str) -> InstrumentInfo | None:
        return payloads.get(symbol)

    return _fetch


class TestEffectiveInstrument:
    def test_no_override_returns_ledger_values(self, session: Session) -> None:
        instr = instruments_repo.get_or_create(
            session, symbol="VTI", name="Vanguard Total US", asset_class="etf"
        )
        eff = effective_instrument(instr, None)
        assert eff.name == "Vanguard Total US"
        assert eff.asset_class == "etf"
        assert eff.category is None

    def test_override_wins_over_ledger(self, session: Session) -> None:
        instr = instruments_repo.get_or_create(
            session,
            symbol="VTI",
            name="ledger name",
            asset_class="unknown",
            expense_ratio=Decimal("0.001"),
        )
        ov = InstrumentOverride(
            instrument_id=instr.id,
            category="Total US",
            active=True,
            name_override="Pretty Name",
            asset_class_override="etf",
            expense_ratio_override=Decimal("0.0003"),
        )
        eff = effective_instrument(instr, ov)
        assert eff.name == "Pretty Name"
        assert eff.asset_class == "etf"
        assert eff.expense_ratio == Decimal("0.0003")
        assert eff.category == "Total US"

    def test_partial_override_falls_through_to_ledger(self, session: Session) -> None:
        instr = instruments_repo.get_or_create(
            session, symbol="VTI", name="ledger name", asset_class="etf"
        )
        ov = InstrumentOverride(instrument_id=instr.id, active=True)
        eff = effective_instrument(instr, ov)
        assert eff.name == "ledger name"
        assert eff.asset_class == "etf"

    def test_unknown_default_when_ledger_missing(self, session: Session) -> None:
        instr = instruments_repo.get_or_create(session, symbol="WAT", asset_class="unknown")
        eff = effective_instrument(instr, None)
        assert eff.asset_class == "unknown"


class TestEnrichInstrument:
    def test_fills_missing_fields_from_yfinance(self, session: Session) -> None:
        instr = instruments_repo.get_or_create(session, symbol="VTI", asset_class="unknown")
        fetcher = _fake_fetcher(
            {
                "VTI": InstrumentInfo(
                    symbol="VTI",
                    long_name="Vanguard Total Stock Market",
                    quote_type="ETF",
                    currency="USD",
                    expense_ratio=Decimal("0.0003"),
                )
            }
        )
        enriched = enrich_instrument(session, instr.id, fetcher=fetcher)
        assert enriched.name == "Vanguard Total Stock Market"
        assert enriched.asset_class == "etf"
        assert enriched.expense_ratio == Decimal("0.0003")

    def test_preserves_existing_fields(self, session: Session) -> None:
        instr = instruments_repo.get_or_create(
            session,
            symbol="VTI",
            name="user-chosen name",
            asset_class="stock",
            expense_ratio=Decimal("0.05"),
        )
        fetcher = _fake_fetcher(
            {
                "VTI": InstrumentInfo(
                    symbol="VTI",
                    long_name="should not overwrite",
                    quote_type="ETF",
                    currency="USD",
                    expense_ratio=Decimal("0.0003"),
                )
            }
        )
        out = enrich_instrument(session, instr.id, fetcher=fetcher)
        assert out.name == "user-chosen name"
        assert out.asset_class == "stock"
        assert out.expense_ratio == Decimal("0.05")

    def test_yfinance_miss_leaves_unknown(self, session: Session) -> None:
        instr = instruments_repo.get_or_create(session, symbol="ZZZ", asset_class="unknown")
        out = enrich_instrument(session, instr.id, fetcher=_fake_fetcher({"ZZZ": None}))
        assert out.asset_class == "unknown"
        assert out.name is None

    def test_yfinance_miss_reports_unresolved(self, session: Session) -> None:
        # Audit D2: a symbol yfinance can't resolve is reported via the
        # ``on_unresolved`` callback so the importer can surface it.
        instr = instruments_repo.get_or_create(session, symbol="ZZZ", asset_class="unknown")
        seen: list[str] = []
        enrich_instrument(
            session,
            instr.id,
            fetcher=_fake_fetcher({"ZZZ": None}),
            on_unresolved=seen.append,
        )
        assert seen == ["ZZZ"]

    def test_resolved_symbol_not_reported_unresolved(self, session: Session) -> None:
        instr = instruments_repo.get_or_create(session, symbol="VTI", asset_class="unknown")
        fetcher = _fake_fetcher(
            {"VTI": InstrumentInfo("VTI", "Vanguard Total", "ETF", "USD", None)}
        )
        seen: list[str] = []
        enrich_instrument(session, instr.id, fetcher=fetcher, on_unresolved=seen.append)
        assert seen == []

    def test_skips_synthetic_cash(self, session: Session) -> None:
        instr = instruments_repo.get_or_create(
            session, symbol="SAVINGS_CASH", asset_class="cash", native_currency="EUR"
        )

        def _boom(_s: str) -> InstrumentInfo | None:  # pragma: no cover - must not run
            raise AssertionError("enrichment should be skipped for cash")

        out = enrich_instrument(session, instr.id, fetcher=_boom)
        assert out.asset_class == "cash"

    def test_unknown_quote_type_stays_unknown(self, session: Session) -> None:
        instr = instruments_repo.get_or_create(session, symbol="BTC-USD", asset_class="unknown")
        fetcher = _fake_fetcher(
            {
                "BTC-USD": InstrumentInfo(
                    symbol="BTC-USD",
                    long_name="Bitcoin USD",
                    quote_type="CRYPTOCURRENCY",
                    currency="USD",
                    expense_ratio=None,
                )
            }
        )
        out = enrich_instrument(session, instr.id, fetcher=fetcher)
        assert out.asset_class == "unknown"
        assert out.name == "Bitcoin USD"


class TestEnsureInstrument:
    def test_creates_with_parsed_metadata_then_no_yfinance_needed(self, session: Session) -> None:
        called: list[str] = []

        def _spy(symbol: str) -> InstrumentInfo | None:
            called.append(symbol)
            return None

        instr = ensure_instrument(
            session,
            symbol="VOO",
            fallback_native_currency="USD",
            parsed_name="Vanguard S&P 500",
            parsed_asset_class="etf",
            parsed_native_currency="USD",
            parsed_expense_ratio=Decimal("0.0003"),
            fetcher=_spy,
        )
        assert instr.name == "Vanguard S&P 500"
        assert instr.asset_class == "etf"
        assert called == []  # nothing missing → no yfinance call

    def test_falls_back_to_enrichment_for_gaps(self, session: Session) -> None:
        fetcher = _fake_fetcher(
            {
                "MSFT": InstrumentInfo(
                    symbol="MSFT",
                    long_name="Microsoft Corporation",
                    quote_type="EQUITY",
                    currency="USD",
                    expense_ratio=None,
                )
            }
        )
        instr = ensure_instrument(
            session,
            symbol="MSFT",
            fallback_native_currency="USD",
            fetcher=fetcher,
        )
        assert instr.name == "Microsoft Corporation"
        assert instr.asset_class == "stock"

    def test_quote_type_map_covers_known_classes(self) -> None:
        assert QUOTE_TYPE_MAP["ETF"] == "etf"
        assert QUOTE_TYPE_MAP["EQUITY"] == "stock"
        assert QUOTE_TYPE_MAP["MUTUALFUND"] == "mutual_fund"


class TestSuggestInstrumentFields:
    def test_maps_market_metadata_to_form_fields(self) -> None:
        fetcher = _fake_fetcher(
            {
                "VTI": InstrumentInfo(
                    symbol="VTI",
                    long_name="Vanguard Total Stock Market",
                    quote_type="ETF",
                    currency="USD",
                    expense_ratio=Decimal("0.0003"),
                    category="Large Blend",
                )
            }
        )
        s = suggest_instrument_fields("vti", fetcher=fetcher)
        assert s.name == "Vanguard Total Stock Market"
        assert s.asset_class == "etf"
        assert s.native_currency == "USD"
        assert s.expense_ratio == Decimal("0.0003")
        assert s.category == "Large Blend"

    def test_blank_symbol_returns_empty_suggestion(self) -> None:
        s = suggest_instrument_fields("   ", fetcher=_fake_fetcher({}))
        assert s == InstrumentSuggestion(None, None, None, None, None)

    def test_missing_payload_returns_empty_suggestion(self) -> None:
        s = suggest_instrument_fields("ZZZZ", fetcher=_fake_fetcher({"ZZZZ": None}))
        assert s.asset_class is None
        assert s.category is None

    def test_unmapped_quote_type_leaves_asset_class_none(self) -> None:
        fetcher = _fake_fetcher(
            {
                "BTC-USD": InstrumentInfo(
                    symbol="BTC-USD",
                    long_name="Bitcoin USD",
                    quote_type="CRYPTOCURRENCY",
                    currency="USD",
                    expense_ratio=None,
                    category=None,
                )
            }
        )
        s = suggest_instrument_fields("BTC-USD", fetcher=fetcher)
        assert s.asset_class is None
        assert s.name == "Bitcoin USD"


class TestOverridesRepoExtended:
    def test_upsert_round_trip_new_fields(self, session: Session) -> None:
        instrument_overrides_repo.upsert(
            session,
            instrument_id=42,
            name_override="My Name",
            asset_class_override="etf",
            expense_ratio_override=Decimal("0.0009"),
        )
        ov = instrument_overrides_repo.get(session, 42)
        assert ov is not None
        assert ov.name_override == "My Name"
        assert ov.asset_class_override == "etf"
        assert ov.expense_ratio_override == Decimal("0.0009")

    def test_upsert_preserves_unset_fields(self, session: Session) -> None:
        instrument_overrides_repo.upsert(session, 7, category="Growth")
        instrument_overrides_repo.upsert(session, 7, name_override="Pretty")
        ov = instrument_overrides_repo.get(session, 7)
        assert ov is not None
        assert ov.category == "Growth"  # untouched
        assert ov.name_override == "Pretty"

    def test_upsert_can_clear_a_field(self, session: Session) -> None:
        instrument_overrides_repo.upsert(session, 7, name_override="Pretty")
        instrument_overrides_repo.upsert(session, 7, name_override=None)
        ov = instrument_overrides_repo.get(session, 7)
        assert ov is not None
        assert ov.name_override is None
