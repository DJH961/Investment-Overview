"""The scheduler's "settle yesterday" step (first run after the New York date rolls over)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from pathlib import Path

from investment_dashboard.db import cache_write_session, ledger_session_scope
from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.repositories import (
    accounts_repo,
    fx_repo,
    instruments_repo,
    prices_repo,
    snapshots_repo,
)
from investment_dashboard.services import scheduler

D = Decimal
FRI, SAT, SUN = date(2026, 11, 13), date(2026, 11, 14), date(2026, 11, 15)


def _seed() -> None:
    with ledger_session_scope() as s:
        acct = accounts_repo.create_account(
            s,
            broker="fidelity",
            account_label="Main",
            native_currency="USD",
            account_type="brokerage",
        )
        inst = instruments_repo.get_or_create(s, symbol="VTI", asset_class="etf")
        prices_repo.upsert_closes(s, inst.id, {FRI: D("100")})
        fx_repo.upsert_rates(s, {FRI: D("1.10"), SAT: D("1.10")})
        legs = {"net_eur": D("-909.09"), "fx_rate_to_eur": D("1.10")}
        s.add_all(
            [
                Transaction(
                    account_id=acct.id,
                    date=FRI,
                    kind="deposit",
                    source=TransactionSource.MANUAL,
                    net_native=D("1000"),
                    net_usd=D("1000"),
                    net_eur=D("909.09"),
                    fx_rate_to_eur=D("1.10"),
                ),
                Transaction(
                    account_id=acct.id,
                    date=FRI,
                    kind="buy",
                    source=TransactionSource.MANUAL,
                    instrument_id=inst.id,
                    quantity=D("10"),
                    price_native=D("100"),
                    net_native=D("-1000"),
                    net_usd=D("-1000"),
                    **legs,
                ),
            ]
        )
        # Saturday was stored while it was "today": at the live rate 1.50.
        with cache_write_session(s) as cache:
            snapshots_repo.upsert_snapshot(
                cache, SAT, D("666.67"), total_value_usd=D("1000"), fx_eur_usd=D("1.50")
            )


def _row() -> tuple[Decimal, Decimal | None, Decimal | None]:
    with ledger_session_scope() as s, cache_write_session(s) as cache:
        row = snapshots_repo.get_snapshot(cache, SAT)
        assert row is not None
        return row.total_value_eur, row.total_value_usd, row.fx_eur_usd


def test_rollover_settles_yesterday_at_its_own_rate_then_is_a_no_op(api_db: Path) -> None:
    _seed()
    assert _row()[2] == D("1.50")

    assert scheduler.default_settle_job(SUN) is True
    eur, usd, fx = _row()
    assert fx == D("1.10")  # the ECB rate, not the live overlay
    assert usd == D("1000")  # native dollars
    assert abs(eur - D("1000") / D("1.10")) < D("0.01")

    # Second run on the same date: nothing is recomputed.
    with ledger_session_scope() as s, cache_write_session(s) as cache:
        snapshots_repo.upsert_snapshot(
            cache, SAT, D("1"), total_value_usd=D("2"), fx_eur_usd=D("3")
        )
    assert scheduler.default_settle_job(SUN) is False
    assert _row() == (D("1"), D("2"), D("3"))
