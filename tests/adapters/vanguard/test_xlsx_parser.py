"""Tests for the Vanguard Full-History XLSX parser (spec §5.2 — v1.4)."""

from __future__ import annotations

import io
from datetime import date
from decimal import Decimal
from pathlib import Path

import openpyxl
import pytest

from investment_dashboard.adapters.importer_types import UnknownActionError
from investment_dashboard.adapters.vanguard.xlsx_parser import (
    VanguardXlsxParseResult,
    parse_vanguard_xlsx,
)

FIXTURE = Path(__file__).parents[3] / "docs" / "Comparison Files" / "Vanguard Full History.xlsx"


def _build_xlsx(rows: list[tuple[object, ...]]) -> bytes:
    """Render a one-sheet workbook mimicking the Vanguard Full History layout.

    The real export prepends two banner rows + a blank row before the
    header — we reproduce that here so the parser's header lookup is
    exercised end-to-end.
    """
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(("Custom report created on: 05/27/2026.",))
    ws.append(("This report includes settlements from: 01/01/2024 to 05/27/2026.",))
    ws.append(())
    ws.append(
        (
            "Settlement date",
            "Trade date",
            "Symbol",
            "Name",
            "Transaction type",
            "Account type",
            "Quantity",
            "Price",
            "Commission & fees**",
            "Amount",
        )
    )
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


class TestSyntheticWorkbook:
    """Synthetic, hand-built fixtures keep these tests fast + hermetic."""

    def test_basic_buy_sell_dividend(self) -> None:
        data = _build_xlsx(
            [
                (
                    "01/05/2024",
                    "01/03/2024",
                    "VTI",
                    "VANGUARD TOTAL STOCK MARKET ETF",
                    "Buy",
                    "CASH",
                    "5.0000",
                    "$220.0000",
                    "Free",
                    "-$1,100.0000",
                ),
                (
                    "02/15/2024",
                    "02/15/2024",
                    "VTI",
                    "VANGUARD TOTAL STOCK MARKET ETF",
                    "Dividend",
                    "CASH",
                    "",
                    "",
                    "",
                    "$15.0000",
                ),
                (
                    "04/03/2024",
                    "04/01/2024",
                    "VTI",
                    "VANGUARD TOTAL STOCK MARKET ETF",
                    "Sell",
                    "CASH",
                    "-2.0000",
                    "$225.0000",
                    "$0.2500",
                    "$449.7500",
                ),
            ]
        )
        result = parse_vanguard_xlsx(data)
        assert isinstance(result, VanguardXlsxParseResult)
        assert result.sweeps_dropped == 0
        kinds = [r.kind for r in result.rows]
        assert kinds == ["buy", "dividend_cash", "sell"]

        buy = result.rows[0]
        assert buy.date == date(2024, 1, 3)
        assert buy.settlement_date == date(2024, 1, 5)
        assert buy.symbol == "VTI"
        assert buy.quantity == Decimal("5.0000")
        assert buy.net_native == Decimal("-1100.0000")
        # "Free" → no fees.
        assert buy.fees_native is None

        # XLSX export already signs sell quantity negative — parser must
        # preserve that and not double-flip it.
        sell = result.rows[2]
        assert sell.quantity == Decimal("-2.0000")
        assert sell.net_native == Decimal("449.7500")
        assert sell.fees_native == Decimal("0.2500")

    def test_sweeps_dropped(self) -> None:
        data = _build_xlsx(
            [
                (
                    "01/05/2024",
                    "01/05/2024",
                    "VMFXX",
                    "Vanguard Federal Money Market Fund (Settlement Fund)",
                    "Sweep in",
                    "CASH",
                    "",
                    "",
                    "",
                    "-$1,100.0000",
                ),
                (
                    "01/05/2024",
                    "01/05/2024",
                    "VMFXX",
                    "Vanguard Federal Money Market Fund (Settlement Fund)",
                    "Sweep out",
                    "CASH",
                    "",
                    "",
                    "",
                    "$1,100.0000",
                ),
                (
                    "01/05/2024",
                    "01/05/2024",
                    "",
                    "To: SAMPLE BANK, NA",
                    "Funds Received",
                    "CASH",
                    "",
                    "",
                    "",
                    "$1,100.0000",
                ),
            ]
        )
        result = parse_vanguard_xlsx(data)
        assert result.sweeps_dropped == 2
        assert len(result.rows) == 1
        assert result.rows[0].kind == "deposit"
        assert result.rows[0].symbol is None
        assert result.rows[0].net_native == Decimal("1100.0000")

    def test_stock_split(self) -> None:
        data = _build_xlsx(
            [
                (
                    "04/21/2026",
                    "04/21/2026",
                    "VUG",
                    "VANGUARD GROWTH ETF",
                    "Stock split",
                    "CASH",
                    "37.1610",
                    "",
                    "",
                    "",
                ),
            ]
        )
        result = parse_vanguard_xlsx(data)
        assert [r.kind for r in result.rows] == ["split"]
        split = result.rows[0]
        assert split.quantity == Decimal("37.1610")
        # Blank Amount → no net.
        assert split.net_native is None

    def test_funds_received_adjustment(self) -> None:
        data = _build_xlsx(
            [
                (
                    "02/18/2025",
                    "02/18/2025",
                    "",
                    "CASH",
                    "Funds Received (adjustment)",
                    "CASH",
                    "",
                    "",
                    "",
                    "-$25.0100",
                ),
            ]
        )
        result = parse_vanguard_xlsx(data)
        assert result.rows[0].kind == "deposit"
        assert result.rows[0].net_native == Decimal("-25.0100")

    def test_unknown_action_raises(self) -> None:
        data = _build_xlsx(
            [
                (
                    "01/05/2024",
                    "01/05/2024",
                    "VTI",
                    "VANGUARD TOTAL STOCK MARKET ETF",
                    "Some Brand New Type",
                    "CASH",
                    "1.0",
                    "$100.0000",
                    "Free",
                    "-$100.0000",
                ),
            ]
        )
        with pytest.raises(UnknownActionError):
            parse_vanguard_xlsx(data)

    def test_missing_header_raises(self) -> None:
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.append(("only", "garbage", "here"))
        buf = io.BytesIO()
        wb.save(buf)
        with pytest.raises(ValueError, match="header"):
            parse_vanguard_xlsx(buf.getvalue())

    def test_external_ids_unique_per_row(self) -> None:
        data = _build_xlsx(
            [
                (
                    "01/05/2024",
                    "01/03/2024",
                    "VTI",
                    "VANGUARD TOTAL STOCK MARKET ETF",
                    "Buy",
                    "CASH",
                    "5.0000",
                    "$220.0000",
                    "Free",
                    "-$1,100.0000",
                ),
                (
                    "01/06/2024",
                    "01/04/2024",
                    "VTI",
                    "VANGUARD TOTAL STOCK MARKET ETF",
                    "Buy",
                    "CASH",
                    "5.0000",
                    "$221.0000",
                    "Free",
                    "-$1,105.0000",
                ),
            ]
        )
        result = parse_vanguard_xlsx(data)
        ids = [r.external_id for r in result.rows]
        assert len(set(ids)) == len(ids)


@pytest.mark.skipif(not FIXTURE.exists(), reason="real fixture is not in this checkout")
class TestRealFullHistoryFixture:
    """Smoke-test the parser against the real workbook shipped under
    ``docs/Comparison Files/``. Guards against regressions in either
    the action map or the header lookup when a new export style appears.
    """

    def test_parses_without_unknown_actions(self) -> None:
        result = parse_vanguard_xlsx(FIXTURE.read_bytes())
        # Should produce hundreds of rows + drop the sweep rows.
        assert len(result.rows) > 100
        assert result.sweeps_dropped > 0

    def test_all_supported_kinds_present(self) -> None:
        result = parse_vanguard_xlsx(FIXTURE.read_bytes())
        kinds = {r.kind for r in result.rows}
        # The real export covers at least these kinds.
        assert {"buy", "sell", "dividend_cash", "dividend_reinvest", "deposit"} <= kinds
