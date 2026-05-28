"""Smoke tests for ``repositories``: round-trip CRUD on the in-memory DB."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.repositories import (
    accounts_repo,
    allocations_repo,
    fx_repo,
    instruments_repo,
    prices_repo,
    transactions_repo,
)


def _seed_account(session: Session) -> int:
    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Fidelity Brokerage",
        native_currency="USD",
        account_type="brokerage",
    )
    return acct.id


def _seed_instrument(session: Session, symbol: str = "VTI") -> int:
    instr = instruments_repo.get_or_create(
        session, symbol=symbol, name="Vanguard Total Stock", native_currency="USD"
    )
    return instr.id


class TestAccountsRepo:
    def test_create_and_list(self, session: Session) -> None:
        _seed_account(session)
        accts = accounts_repo.list_accounts(session)
        assert len(accts) == 1
        assert accts[0].broker == "fidelity"

    def test_find_by_broker(self, session: Session) -> None:
        _seed_account(session)
        accounts_repo.create_account(
            session,
            broker="vanguard",
            account_label="Vanguard",
            native_currency="USD",
        )
        assert len(accounts_repo.find_by_broker(session, "fidelity")) == 1
        assert len(accounts_repo.find_by_broker(session, "vanguard")) == 1


class TestInstrumentsRepo:
    def test_get_or_create_idempotent(self, session: Session) -> None:
        first = instruments_repo.get_or_create(session, symbol="VTI")
        second = instruments_repo.get_or_create(session, symbol="VTI")
        assert first.id == second.id

    def test_active_filter(self, session: Session) -> None:
        # ``active`` is now a config-tier override; the ledger repo
        # returns every instrument. Filtering by active happens in the
        # caller via ``instrument_overrides_repo.inactive_ids``.
        from investment_dashboard.repositories import instrument_overrides_repo

        a = instruments_repo.get_or_create(session, symbol="VTI")
        b = instruments_repo.get_or_create(session, symbol="VOO")
        instrument_overrides_repo.set_active(session, b.id, False)
        session.flush()
        all_ = instruments_repo.list_instruments(session)
        assert {i.symbol for i in all_} == {"VTI", "VOO"}
        # Composition: active filter at the call site.
        inactive = instrument_overrides_repo.inactive_ids(session)
        assert {i.symbol for i in all_ if i.id not in inactive} == {"VTI"}
        # Defaults are honoured: a has no override row, treated as active.
        assert a.id not in inactive
        assert instrument_overrides_repo.is_active(session, a.id) is True


class TestTransactionsRepo:
    def test_insert_and_query(self, session: Session) -> None:
        acct_id = _seed_account(session)
        instr_id = _seed_instrument(session)
        txn = Transaction(
            account_id=acct_id,
            instrument_id=instr_id,
            date=date(2024, 1, 5),
            kind="buy",
            quantity=Decimal("10"),
            price_native=Decimal("220.5"),
            net_native=Decimal("-2205.00"),
            source="manual",
        )
        inserted = transactions_repo.insert_transaction(session, txn)
        assert inserted is not None
        rows = transactions_repo.list_transactions(session, account_id=acct_id)
        assert len(rows) == 1
        assert rows[0].kind == "buy"

    def test_dedup_by_external_id(self, session: Session) -> None:
        acct_id = _seed_account(session)
        instr_id = _seed_instrument(session)
        t1 = Transaction(
            account_id=acct_id,
            instrument_id=instr_id,
            date=date(2024, 1, 5),
            kind="buy",
            quantity=Decimal(1),
            net_native=Decimal("-100"),
            external_id="hash-abc",
            source="import_fidelity_csv",
        )
        assert transactions_repo.insert_transaction(session, t1) is not None
        t2 = Transaction(
            account_id=acct_id,
            instrument_id=instr_id,
            date=date(2024, 1, 5),
            kind="buy",
            quantity=Decimal(1),
            net_native=Decimal("-100"),
            external_id="hash-abc",
            source="import_fidelity_csv",
        )
        assert transactions_repo.insert_transaction(session, t2) is None

    def test_filter_by_kind(self, session: Session) -> None:
        acct_id = _seed_account(session)
        for kind, net in [("deposit", "100"), ("interest", "5"), ("withdrawal", "-50")]:
            session.add(
                Transaction(
                    account_id=acct_id,
                    date=date(2024, 1, 1),
                    kind=kind,
                    net_native=Decimal(net),
                    source="manual",
                )
            )
        session.flush()
        deposits = transactions_repo.list_transactions(session, kinds=["deposit"])
        assert {t.kind for t in deposits} == {"deposit"}


class TestPricesRepo:
    def test_upsert_and_lookup(self, session: Session) -> None:
        instr_id = _seed_instrument(session)
        prices_repo.upsert_closes(
            session,
            instr_id,
            {date(2024, 1, 2): Decimal("220.50"), date(2024, 1, 3): Decimal("221.10")},
        )
        all_closes = prices_repo.get_closes_for_instrument(session, instr_id)
        assert all_closes[date(2024, 1, 3)] == Decimal("221.10")
        # Idempotent: re-upsert overwrites.
        prices_repo.upsert_closes(session, instr_id, {date(2024, 1, 3): Decimal("222.00")})
        assert prices_repo.latest_close(session, instr_id) == Decimal("222.00")


class TestFxRepo:
    def test_upsert_and_lookup(self, session: Session) -> None:
        fx_repo.upsert_rates(
            session,
            {date(2024, 1, 2): Decimal("1.0950"), date(2024, 1, 3): Decimal("1.0975")},
        )
        rates = fx_repo.get_rates(session)
        assert rates[date(2024, 1, 3)] == Decimal("1.09750000")
        assert fx_repo.latest_rate_date(session) == date(2024, 1, 3)


class TestAllocationsRepo:
    def test_create_and_activate(self, session: Session) -> None:
        i1 = _seed_instrument(session, "VTI")
        i2 = _seed_instrument(session, "VOO")
        alloc = allocations_repo.create_allocation(
            session,
            name="Default",
            weights_by_instrument_id={i1: Decimal("60"), i2: Decimal("40")},
            active=True,
        )
        active = allocations_repo.get_active(session)
        assert active is not None
        assert active.id == alloc.id
        assert {item.weight_pct for item in active.items} == {Decimal("60.00"), Decimal("40.00")}
