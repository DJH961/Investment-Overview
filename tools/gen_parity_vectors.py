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
from investment_dashboard.ui.pages._projection_query import (  # noqa: E402
    DEFAULT_SCENARIOS,
    project,
)

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


def _projection_case(
    name: str,
    starting_value_eur: Decimal,
    annual_contribution_eur: Decimal,
    years: int,
    base_year: int,
    scenarios: tuple[Decimal, ...] = DEFAULT_SCENARIOS,
) -> dict[str, Any]:
    """Build one projection-annuity parity case from the desktop ``project``.

    The web ``projectForward`` (``web/src/phase4.ts``) re-implements this exact
    ordinary annuity ("so the web calculator agrees with the desktop one"), so
    locking the row-by-row output is part of the desktop<->web math contract
    (v5.0 plan B6).
    """
    rows = project(
        starting_value_eur,
        annual_contribution_eur,
        years=years,
        scenarios=scenarios,
        start_year=base_year,
    )
    return {
        "name": name,
        "inputs": {
            "starting_value_eur": dec(starting_value_eur),
            "annual_contribution_eur": dec(annual_contribution_eur),
            "years": years,
            "base_year": base_year,
            "scenarios": [dec(r) for r in scenarios],
        },
        "expected": [
            {
                "year": row.year,
                "contributed": dec(row.contributed),
                "values_by_rate": {
                    dec(rate): dec(value) for rate, value in row.values_by_rate.items()
                },
            }
            for row in rows
        ],
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
        # A mid-life withdrawal (positive flow) between two contributions plus a
        # terminal value — exercises the Newton solver on a non-trivial sign
        # pattern, not just buy-then-hold.
        _xirr_case(
            "with_withdrawal",
            [
                Cashflow(date(2019, 3, 1), Decimal("-20000")),
                Cashflow(date(2020, 9, 15), Decimal("5000")),
                Cashflow(date(2022, 1, 10), Decimal("-3000")),
            ],
            date(2024, 6, 1),
            Decimal("24000"),
        ),
        # A large, USD-magnitude book (USD is the canonical backend currency):
        # guards against any precision drift between the solvers at realistic
        # portfolio scale rather than toy thousands.
        _xirr_case(
            "large_usd_book",
            [
                Cashflow(date(2018, 1, 2), Decimal("-250000")),
                Cashflow(date(2021, 7, 1), Decimal("-120000")),
            ],
            date(2025, 1, 2),
            Decimal("612500"),
        ),
        # A net loss: terminal value below total contributions yields a negative
        # XIRR root — the solver must still converge below zero.
        _xirr_case(
            "net_loss",
            [
                Cashflow(date(2021, 1, 1), Decimal("-10000")),
                Cashflow(date(2021, 7, 1), Decimal("-5000")),
            ],
            date(2024, 1, 1),
            Decimal("9000"),
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
            # Sub-year window: the annualising exponent (1 / years) is > 1, so the
            # float-power path is pushed the other way from the multi-year cases.
            {
                "name": "sub_year_gain",
                "inputs": {"start_value": "1000", "end_value": "1100", "days": 180},
                "expected": dec(cagr(Decimal("1000"), Decimal("1100"), 180)),
            },
            # Ten-year horizon at USD scale — the longest float-power lever and
            # the case most likely to expose libm pow drift between TS and Python.
            {
                "name": "long_horizon_usd",
                "inputs": {"start_value": "250000", "end_value": "1000000", "days": 3650},
                "expected": dec(cagr(Decimal("250000"), Decimal("1000000"), 3650)),
            },
            # Negative end value is outside the real-valued domain -> None/null on
            # both sides; locks the guard branch, not just the happy path.
            {
                "name": "negative_end_invalid",
                "inputs": {"start_value": "1000", "end_value": "-50", "days": 365},
                "expected": dec(cagr(Decimal("1000"), Decimal("-50"), 365)),
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
            # A loss annualised over a short window — base (1 + r) stays positive
            # but below 1, so the float power shrinks rather than grows.
            {
                "name": "loss_short_window",
                "inputs": {"total_return": "-0.20", "days": 90},
                "expected": dec(annualize_return(Decimal("-0.20"), 90)),
            },
            # Catastrophic loss below -100%: base (1 + r) <= 0 -> None/null. Locks
            # the real-valued-domain guard on both sides.
            {
                "name": "below_minus_one_invalid",
                "inputs": {"total_return": "-1.50", "days": 30},
                "expected": dec(annualize_return(Decimal("-1.50"), 30)),
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
            # Current value below contributions -> a genuine negative growth %.
            {
                "name": "underwater",
                "inputs": {"contributions": "1000", "current_value": "750"},
                "expected": dec(total_growth_pct(Decimal("1000"), Decimal("750"))),
            },
            # Total wipeout: -100% exactly.
            {
                "name": "total_loss",
                "inputs": {"contributions": "1000", "current_value": "0"},
                "expected": dec(total_growth_pct(Decimal("1000"), Decimal("0"))),
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
            # Negative XIRR compounded over several years — the float power must
            # shrink the base on both sides identically.
            {
                "name": "negative_rate",
                "inputs": {"xirr_rate": "-0.20", "years": "3"},
                "expected": dec(total_growth_pct_compounded(Decimal("-0.20"), Decimal("3"))),
            },
            # Below -100%: base (1 + xirr) <= 0 -> None/null guard.
            {
                "name": "below_minus_one_invalid",
                "inputs": {"xirr_rate": "-1.50", "years": "2"},
                "expected": dec(total_growth_pct_compounded(Decimal("-1.50"), Decimal("2"))),
            },
            # Non-positive horizon -> None/null even with a valid rate.
            {
                "name": "zero_years",
                "inputs": {"xirr_rate": "0.08", "years": "0"},
                "expected": dec(total_growth_pct_compounded(Decimal("0.08"), Decimal("0"))),
            },
            # A long, fractional horizon at a healthy rate — the largest growth
            # lever and the most exposed to libm pow divergence.
            {
                "name": "long_horizon",
                "inputs": {"xirr_rate": "0.12", "years": "10.5"},
                "expected": dec(total_growth_pct_compounded(Decimal("0.12"), Decimal("10.5"))),
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
            # End before start -> clamped to zero (not negative).
            {
                "name": "reversed_range",
                "inputs": {"start": "2024-06-01", "end": "2023-06-01"},
                "expected": dec(years_between(date(2024, 6, 1), date(2023, 6, 1))),
            },
            # A leap-spanning fractional window to confirm the 365.25 divisor is
            # applied identically on both sides.
            {
                "name": "leap_spanning",
                "inputs": {"start": "2019-07-01", "end": "2023-09-15"},
                "expected": dec(years_between(date(2019, 7, 1), date(2023, 9, 15))),
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
            },
            # A loss that cash dividends only partly offset -> negative gain.
            {
                "name": "loss_with_dividends",
                "inputs": {
                    "contributions": "5000",
                    "current_value": "4200",
                    "cumulative_dividends_cash": "150",
                },
                "expected": dec(
                    capital_gain(
                        contributions=Decimal("5000"),
                        current_value=Decimal("4200"),
                        cumulative_dividends_cash=Decimal("150"),
                    )
                ),
            },
            # USD-scale book with no cash dividends (reinvested) — large-magnitude
            # exact-Decimal arithmetic must agree to the cent.
            {
                "name": "large_usd_no_dividends",
                "inputs": {
                    "contributions": "370000",
                    "current_value": "612500.42",
                    "cumulative_dividends_cash": "0",
                },
                "expected": dec(
                    capital_gain(
                        contributions=Decimal("370000"),
                        current_value=Decimal("612500.42"),
                        cumulative_dividends_cash=Decimal("0"),
                    )
                ),
            },
        ],
        # Forward-projection ordinary annuity. The web `projectForward`
        # (`web/src/phase4.ts`) mirrors the desktop `project`
        # (`ui/pages/_projection_query.py`); these vectors lock the row-by-row
        # agreement so the mobile and desktop calculators can never diverge
        # (v5.0 plan B6).
        "project": [
            _projection_case("ordinary", Decimal("10000"), Decimal("1200"), 3, 2025),
            # Pure annuity from an empty portfolio (no starting balance).
            _projection_case("zero_start", Decimal("0"), Decimal("2400"), 5, 2025),
            # Pure compounding at USD scale with no further contributions.
            _projection_case("no_contribution_usd", Decimal("250000"), Decimal("0"), 4, 2025),
            # Single-year horizon — the minimal non-empty projection.
            _projection_case("single_year", Decimal("1000"), Decimal("100"), 1, 2025),
            # Zero-year horizon must yield an empty table on both sides.
            _projection_case("zero_years", Decimal("1000"), Decimal("100"), 0, 2025),
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
