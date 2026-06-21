"""H2 — Full-metrics golden-master regression harness (desktop side).

The web port is protected against numeric drift by ``tests/parity/vectors.json``.
This is the desktop equivalent: it seeds a *fixed* fixture portfolio, runs the
complete :func:`metrics_service.compute_portfolio_metrics` pipeline at a frozen
``as_of``, and asserts the serialised output is byte-stable against a committed
golden file (``tests/services/golden/portfolio_metrics.json``).

Why it exists: the planned B-series performance refactor will move a lot of
math around ("walk the ledger once, reuse the valuation"). A golden-master lock
is the cheapest insurance that the refactor stays *numerically* identical —
"same numbers, fewer round-trips" — rather than silently changing a KPI.

To regenerate the golden file after an *intended* change, run::

    UPDATE_GOLDEN=1 python -m pytest tests/services/test_metrics_golden_master.py

and review the diff before committing.
"""

from __future__ import annotations

import dataclasses
import json
import os
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.repositories import (
    accounts_repo,
    fx_repo,
    instruments_repo,
    prices_repo,
)
from investment_dashboard.services import metrics_service

GOLDEN_PATH = Path(__file__).parent / "golden" / "portfolio_metrics.json"

#: Frozen valuation date for the fixture so the golden file is deterministic.
AS_OF = date(2024, 6, 30)


def _seed_fixture_portfolio(session: Session) -> None:
    """A deterministic, mixed-currency fixture exercising most KPIs.

    Two accounts (a EUR savings account and a USD brokerage), an ETF buy with
    a subsequent price gain, a cash dividend, and a savings deposit + interest.
    FX history covers the trade dates and the valuation date so both the EUR
    and USD legs are fully populated.
    """
    savings = accounts_repo.create_account(
        session,
        broker="savings_bank",
        account_label="Savings",
        native_currency="EUR",
        account_type="savings",
    )
    brokerage = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Fidelity Brokerage",
        native_currency="USD",
        account_type="brokerage",
    )
    vti = instruments_repo.get_or_create(session, symbol="VTI", native_currency="USD")

    # EUR savings: deposit + interest.
    session.add_all(
        [
            Transaction(
                account_id=savings.id,
                date=date(2024, 1, 2),
                kind="deposit",
                net_native=Decimal("5000.00"),
                net_eur=Decimal("5000.00"),
                source="manual",
            ),
            Transaction(
                account_id=savings.id,
                date=date(2024, 4, 1),
                kind="interest",
                net_native=Decimal("25.00"),
                net_eur=Decimal("25.00"),
                source="manual",
            ),
        ]
    )

    # USD brokerage: buy VTI, then receive a cash dividend.
    session.add_all(
        [
            Transaction(
                account_id=brokerage.id,
                instrument_id=vti.id,
                date=date(2024, 1, 15),
                kind="buy",
                quantity=Decimal("20"),
                price_native=Decimal("230.00"),
                net_native=Decimal("-4600.00"),
                net_eur=Decimal("-4230.00"),
                net_usd=Decimal("-4600.00"),
                source="manual",
            ),
            Transaction(
                account_id=brokerage.id,
                instrument_id=vti.id,
                date=date(2024, 3, 20),
                kind="dividend_cash",
                net_native=Decimal("32.00"),
                net_eur=Decimal("29.50"),
                net_usd=Decimal("32.00"),
                source="manual",
            ),
        ]
    )

    # Price history: a January cost-basis print and a June valuation print.
    prices_repo.upsert_closes(
        session,
        vti.id,
        {date(2024, 1, 15): Decimal("230.00"), date(2024, 6, 28): Decimal("265.00")},
    )

    # EUR->USD FX across the relevant dates (forward-filled by the services).
    fx_repo.upsert_rates(
        session,
        {
            date(2024, 1, 2): Decimal("1.10"),
            date(2024, 1, 15): Decimal("1.0875"),
            date(2024, 3, 20): Decimal("1.0850"),
            date(2024, 6, 28): Decimal("1.0700"),
        },
    )
    session.flush()


def _normalise(value: Any) -> Any:
    """Serialise Decimals/dates to stable strings for byte-comparison."""
    if isinstance(value, Decimal):
        # Normalise the exponent so 0.10 and 0.1 compare equal.
        return format(value.normalize(), "f")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _normalise(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_normalise(v) for v in value]
    return value


def _metrics_snapshot(session: Session) -> dict[str, Any]:
    metrics = metrics_service.compute_portfolio_metrics(session, as_of=AS_OF)
    return _normalise(dataclasses.asdict(metrics))


def test_portfolio_metrics_golden_master(session: Session) -> None:
    _seed_fixture_portfolio(session)
    snapshot = _metrics_snapshot(session)

    # Only (re)write the golden file on an explicit opt-in. A missing committed
    # golden file is treated as a hard failure rather than silently
    # auto-created, so a lost fixture can never make this regression gate pass
    # vacuously in CI.
    if os.environ.get("UPDATE_GOLDEN") == "1":
        GOLDEN_PATH.parent.mkdir(parents=True, exist_ok=True)
        GOLDEN_PATH.write_text(json.dumps(snapshot, indent=2, sort_keys=True) + "\n")

    assert GOLDEN_PATH.exists(), (
        f"Golden master file missing: {GOLDEN_PATH}. Generate it with "
        "UPDATE_GOLDEN=1 python -m pytest "
        "tests/services/test_metrics_golden_master.py and commit the result."
    )
    golden = json.loads(GOLDEN_PATH.read_text())
    assert snapshot == golden, (
        "compute_portfolio_metrics output drifted from the golden master. "
        "If this change is intentional, regenerate with "
        "UPDATE_GOLDEN=1 python -m pytest "
        "tests/services/test_metrics_golden_master.py and review the diff."
    )
