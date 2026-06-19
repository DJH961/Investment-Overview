"""Generate deterministic Python return-function parity vectors."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from investment_dashboard.domain.returns import (  # noqa: E402
    Cashflow,
    annualize_return,
    cagr,
    capital_gain,
    total_growth_pct,
    total_growth_pct_compounded,
    xirr,
    years_between,
)
from investment_dashboard.readmodels._serialize import dec  # noqa: E402

VECTORS_PATH = ROOT / "tests" / "parity" / "vectors.json"


def _date(value: date) -> str:
    return value.isoformat()


def _cashflow_dict(flow: Cashflow) -> dict[str, str | None]:
    return {"date": _date(flow.date), "amount": dec(flow.amount)}


def _xirr_case(
    name: str,
    cashflows: list[Cashflow],
    as_of: date,
    terminal_value: Decimal | None,
) -> dict[str, Any]:
    return {
        "name": name,
        "inputs": {
            "cashflows": [_cashflow_dict(flow) for flow in cashflows],
            "as_of": _date(as_of),
            "terminal_value": dec(terminal_value),
        },
        "expected": dec(xirr(cashflows, as_of=as_of, terminal_value=terminal_value)),
    }


def build_vectors() -> dict[str, Any]:
    """Return the full deterministic vector document."""
    xirr_cases = [
        _xirr_case(
            "ordinary",
            [
                Cashflow(date(2020, 1, 15), Decimal("-10000")),
                Cashflow(date(2021, 6, 1), Decimal("-2500")),
                Cashflow(date(2022, 3, 20), Decimal("900")),
            ],
            date(2024, 1, 15),
            Decimal("16800"),
        ),
        _xirr_case(
            "negative",
            [
                Cashflow(date(2021, 1, 1), Decimal("-10000")),
                Cashflow(date(2022, 1, 1), Decimal("500")),
            ],
            date(2023, 1, 1),
            Decimal("8200"),
        ),
        _xirr_case(
            "all_same_day_single_cashflow",
            [Cashflow(date(2024, 5, 1), Decimal("-1000"))],
            date(2024, 5, 1),
            None,
        ),
        _xirr_case(
            "leap_year_span",
            [Cashflow(date(2020, 2, 29), Decimal("-1000"))],
            date(2024, 2, 29),
            Decimal("1500"),
        ),
    ]
    return {
        "schema_version": 1,
        "tolerances": {
            "money": "0.000001",
            "rates": "0.00000001",
            "xirr": "0.000001",
        },
        "xirr": xirr_cases,
        "cagr": [
            {
                "name": "ordinary",
                "inputs": {"start_value": "1000", "end_value": "1500", "days": 730},
                "expected": dec(cagr(Decimal("1000"), Decimal("1500"), 730)),
            },
            {
                "name": "total_loss",
                "inputs": {"start_value": "1000", "end_value": "0", "days": 365},
                "expected": dec(cagr(Decimal("1000"), Decimal("0"), 365)),
            },
            {
                "name": "invalid_zero_start",
                "inputs": {"start_value": "0", "end_value": "1000", "days": 365},
                "expected": dec(cagr(Decimal("0"), Decimal("1000"), 365)),
            },
        ],
        "annualize_return": [
            {
                "name": "ordinary",
                "inputs": {"total_return": "0.10", "days": 30},
                "expected": dec(annualize_return(Decimal("0.10"), 30)),
            },
            {
                "name": "invalid_days",
                "inputs": {"total_return": "0.10", "days": 0},
                "expected": dec(annualize_return(Decimal("0.10"), 0)),
            },
        ],
        "total_growth_pct": [
            {
                "name": "ordinary",
                "inputs": {"contributions": "1000", "current_value": "1250"},
                "expected": dec(total_growth_pct(Decimal("1000"), Decimal("1250"))),
            },
            {
                "name": "zero_contributions",
                "inputs": {"contributions": "0", "current_value": "1250"},
                "expected": dec(total_growth_pct(Decimal("0"), Decimal("1250"))),
            },
        ],
        "total_growth_pct_compounded": [
            {
                "name": "ordinary",
                "inputs": {"xirr_rate": "0.08", "years": "2.5"},
                "expected": dec(total_growth_pct_compounded(Decimal("0.08"), Decimal("2.5"))),
            },
            {
                "name": "none_xirr",
                "inputs": {"xirr_rate": None, "years": "2.5"},
                "expected": dec(total_growth_pct_compounded(None, Decimal("2.5"))),
            },
        ],
        "years_between": [
            {
                "name": "ordinary",
                "inputs": {"start": "2020-01-01", "end": "2024-01-01"},
                "expected": dec(years_between(date(2020, 1, 1), date(2024, 1, 1))),
            },
            {
                "name": "same_day",
                "inputs": {"start": "2024-01-01", "end": "2024-01-01"},
                "expected": dec(years_between(date(2024, 1, 1), date(2024, 1, 1))),
            },
        ],
        "capital_gain": [
            {
                "name": "ordinary",
                "inputs": {
                    "contributions": "1000",
                    "current_value": "1250",
                    "cumulative_dividends_cash": "75",
                },
                "expected": dec(
                    capital_gain(
                        contributions=Decimal("1000"),
                        current_value=Decimal("1250"),
                        cumulative_dividends_cash=Decimal("75"),
                    )
                ),
            }
        ],
    }


def render_vectors() -> bytes:
    """Render vectors exactly as committed."""
    text = json.dumps(build_vectors(), indent=2, sort_keys=True)
    return f"{text}\n".encode()


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="gen_parity_vectors")
    parser.add_argument(
        "--write",
        action="store_true",
        help=f"Write {VECTORS_PATH.relative_to(ROOT)} instead of printing.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    data = render_vectors()
    if args.write:
        VECTORS_PATH.parent.mkdir(parents=True, exist_ok=True)
        VECTORS_PATH.write_bytes(data)
    else:
        sys.stdout.buffer.write(data)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
