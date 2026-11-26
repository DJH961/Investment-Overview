"""P19 golden: moving every reader off the frozen legs moves no figure (7.4 lane A).

A synthetic ledger (no real data) is seeded the way the pre-7.4 writers stored it:
native amounts **plus** the frozen ``net_eur`` / ``net_usd`` / ``fx_rate_to_eur`` legs
struck at each date's rate. :func:`figures` collects what the owner sees on the
Overview (portfolio metrics), Deposits, Periods (monthly and yearly, EUR and USD)
and Transactions (page rows, summary, month totals).

``p19_nothing_moves.json`` holds those figures as the **pre-7.4 code** computed them
(generated at commit a9ed004f from this same seed and :func:`figures`). The test
asserts the 7.4 code gives the same figures, except the entries in :data:`MOVED`:

* the Transactions EUR of the deposit matched to a conversion now shows the EUR you
  actually paid (your rate) instead of the ECB rate, and so does its month's EUR
  total. Everything else, USD included, is unchanged.

A second check clears the frozen legs (as the 7.4 writers leave them) and gets the
very same figures, so nothing reads them any more.

Seed (USD per EUR): 1.25 from 1 Jan 2024, 1.10 from 1 Mar, 1.20 from 1 May.

* Conversion 20 Jan: €850 → $1,000 (your rate 1.1765). It covers the 1 Feb deposit,
  which therefore cost €850; the ECB rate on 1 Feb gives $1,000 / 1.25 = €800. The
  Overview and Deposits already counted €850; the Transactions EUR showed €800.
* USD account: deposit $1,000 (1 Feb, matched), buy 10 VTI @ $80 (5 Feb), cash
  dividend $12 (15 Mar), interest $3 (1 Apr), deposit $600 (2 May, no conversion
  left: ECB), sell 2 VTI @ $100 (10 May), withdrawal $150 (1 Jun).
* EUR account: deposit €500 (5 Mar), interest €2 (30 Apr).
"""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from sqlalchemy import update
from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.readmodels import deposits as deposits_rm
from investment_dashboard.readmodels import periods as periods_rm
from investment_dashboard.readmodels import transactions as transactions_rm
from investment_dashboard.readmodels._context import build_context
from investment_dashboard.repositories import (
    accounts_repo,
    fx_repo,
    instruments_repo,
    prices_repo,
)
from investment_dashboard.services import (
    fx_conversion_service,
    metrics_service,
    read_cache,
    transaction_fx_service,
)

D = Decimal
AS_OF = date(2024, 6, 28)
GOLDEN = Path(__file__).with_name("p19_nothing_moves.json")

#: Figures that move on purpose: ``path -> (pre-7.4 value, 7.4 value)``. Only the
#: Transactions EUR of the matched deposit (1 Feb, $1,000 for €850) and its month.
MOVED: dict[str, tuple[str, str]] = {
    "transactions.rows[2024-02-01 deposit 1000].net_eur": ("800.0000", "850.0000"),
    "transactions.rows[2024-02-01 deposit 1000].cash_eur": ("800.0000", "850.0000"),
    "transactions.months[2024-02].net_eur": ("160.0000", "210.0000"),
}

#: 7.4 lane B2 (cash pool, ``fx.holding_cost_basis = pool``): the 5 Feb buy's $800 came
#: from the 1 Feb deposit ($1,000 for €850), so it cost €680, not $800 / 1.25 = €640.
#: Its month and the average trade size follow. ``path -> (value after P19, 7.4 value)``.
#: Fields 7.4 added that the pre-7.4 code did not have (new, not moved): every path
#: ending in one of these is expected at this value. The seed converts nothing back,
#: so the Deposits and Periods cashed-out figures are 0.
ADDED_SUFFIXES: dict[str, str] = {".cashed_out_eur": "0.0000"}

MOVED_POOL: dict[str, tuple[str, str]] = {
    "transactions.rows[2024-02-05 buy -800].net_eur": ("-640.0000", "-680.0000"),
    "transactions.rows[2024-02-05 buy -800].cash_eur": ("-640.0000", "-680.0000"),
    "transactions.months[2024-02].net_eur": ("210.0000", "170.0000"),
    "transactions.summary.avg_trade_size_eur": ("403.3333", "423.3333"),
}


def seed(session: Session) -> None:
    """The synthetic ledger above, with frozen legs as the pre-7.4 writers stored them."""
    usd = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Brokerage",
        native_currency="USD",
        account_type="brokerage",
    )
    eur = accounts_repo.create_account(
        session,
        broker="savings_bank",
        account_label="Savings",
        native_currency="EUR",
        account_type="savings",
    )
    vti = instruments_repo.get_or_create(session, symbol="VTI", native_currency="USD")
    fx_repo.upsert_rates(
        session,
        {date(2024, 1, 1): D("1.25"), date(2024, 3, 1): D("1.10"), date(2024, 5, 1): D("1.20")},
    )
    prices_repo.upsert_closes(
        session,
        vti.id,
        {date(2024, 2, 5): D("80"), date(2024, 5, 10): D("100"), AS_OF: D("110")},
    )
    fx_conversion_service.create_conversion(
        session, on=date(2024, 1, 20), eur_sent=D("850"), usd_received=D("1000")
    )
    rows: list[tuple[Any, date, str, str, dict[str, Any]]] = [
        (usd, date(2024, 2, 1), "deposit", "1000", {}),
        (
            usd,
            date(2024, 2, 5),
            "buy",
            "-800",
            {"instrument_id": vti.id, "quantity": D("10"), "price_native": D("80")},
        ),
        (usd, date(2024, 3, 15), "dividend_cash", "12", {"instrument_id": vti.id}),
        (usd, date(2024, 4, 1), "interest", "3", {}),
        (usd, date(2024, 5, 2), "deposit", "600", {}),
        (
            usd,
            date(2024, 5, 10),
            "sell",
            "200",
            {"instrument_id": vti.id, "quantity": D("-2"), "price_native": D("100")},
        ),
        (usd, date(2024, 6, 1), "withdrawal", "-150", {}),
        (eur, date(2024, 3, 5), "deposit", "500", {}),
        (eur, date(2024, 4, 30), "interest", "2", {}),
    ]
    for account, on, kind, native, extra in rows:
        amount = D(native)
        legs = transaction_fx_service.compute_legs(
            session, native_currency=account.native_currency, net_native=amount, on=on
        )
        session.add(
            Transaction(
                account_id=account.id,
                date=on,
                kind=kind,
                net_native=amount,
                fx_rate_to_eur=legs.fx_rate_to_eur,
                net_eur=legs.net_eur,
                net_usd=legs.net_usd,
                source=TransactionSource.MANUAL,
                **extra,
            )
        )
    session.flush()


def _norm(value: Any) -> Any:
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, Decimal | int | float):
        return format(round(Decimal(str(value)), 4), "f")
    if isinstance(value, str):
        try:
            return format(round(Decimal(value), 4), "f")
        except InvalidOperation:
            return value
    return str(value)


def _flatten(prefix: str, value: Any, out: dict[str, Any]) -> None:
    if isinstance(value, dict):
        for k, v in value.items():
            _flatten(f"{prefix}.{k}", v, out)
    elif isinstance(value, list | tuple):
        for i, v in enumerate(value):
            _flatten(f"{prefix}[{i}]", v, out)
    else:
        out[prefix] = _norm(value)


def _row_key(row: dict[str, Any]) -> str:
    return f"{row['date']} {row['kind']} {Decimal(str(row['net_native'])).normalize():f}"


def figures(session: Session) -> dict[str, Any]:
    """Every Overview / Deposits / Periods / Transactions figure, flattened."""
    read_cache.invalidate()
    ctx = build_context(session, as_of=AS_OF)
    out: dict[str, Any] = {}
    metrics = metrics_service.compute_portfolio_metrics(session, as_of=AS_OF)
    _flatten("overview", {k: v for k, v in vars(metrics).items() if not k.startswith("_")}, out)
    for ccy in ("EUR", "USD"):
        _flatten(f"deposits.{ccy}", deposits_rm.build_for_ccy(session, ccy=ccy, context=ctx), out)
        for monthly, label in ((True, "monthly"), (False, "yearly")):
            body = periods_rm.build_for_ccy(session, monthly=monthly, ccy=ccy, context=ctx)
            _flatten(f"periods.{label}.{ccy}", body, out)
    page = transactions_rm.build_page(session, context=ctx, limit=500)
    _flatten("transactions.summary", page["summary"], out)
    for row in page["rows"]:
        key = _row_key(row)
        for field in ("net_native", "net_eur", "net_usd", "cash_eur", "cash_usd", "fx_incomplete"):
            out[f"transactions.rows[{key}].{field}"] = _norm(row[field])
    for month in page["months"]:
        for field in ("count", "net_eur", "net_usd", "fx_incomplete"):
            out[f"transactions.months[{month['month']}].{field}"] = _norm(month[field])
    return out


def _expected() -> dict[str, Any]:
    golden: dict[str, Any] = json.loads(GOLDEN.read_text(encoding="utf-8"))
    for path, (old, new) in MOVED.items():
        assert golden[path] == old, path  # the pre-7.4 value really was the ECB one
        golden[path] = new
    for path, (old, new) in MOVED_POOL.items():
        assert golden[path] == old, path
        golden[path] = new
    return golden


def test_nothing_moves_but_the_matched_deposit_eur(session: Session) -> None:
    seed(session)
    got = figures(session)
    expected = _expected()
    for path in set(got) - set(expected):
        for suffix, value in ADDED_SUFFIXES.items():
            if path.endswith(suffix):
                expected[path] = value
    diff = {
        k: (expected.get(k), got.get(k))
        for k in sorted(set(expected) | set(got))
        if expected.get(k) != got.get(k)
    }
    assert diff == {}


def test_frozen_legs_are_not_read(session: Session) -> None:
    seed(session)
    with_legs = figures(session)
    session.execute(update(Transaction).values(net_eur=None, net_usd=None, fx_rate_to_eur=None))
    session.flush()
    session.expire_all()
    assert figures(session) == with_legs
