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

    def test_list_transactions_missing_legs(self, session: Session) -> None:
        acct_id = _seed_account(session)
        # One healthy row (both legs frozen) and two with a NULL leg.
        session.add(
            Transaction(
                account_id=acct_id,
                date=date(2024, 1, 1),
                kind="deposit",
                net_native=Decimal("100"),
                net_eur=Decimal("90"),
                net_usd=Decimal("100"),
                source="manual",
            )
        )
        session.add(
            Transaction(
                account_id=acct_id,
                date=date(2024, 1, 2),
                kind="deposit",
                net_native=Decimal("50"),
                net_usd=Decimal("50"),  # net_eur NULL
                source="manual",
            )
        )
        session.add(
            Transaction(
                account_id=acct_id,
                date=date(2024, 1, 3),
                kind="deposit",
                net_native=Decimal("25"),
                net_eur=Decimal("23"),  # net_usd NULL
                source="manual",
            )
        )
        session.flush()
        missing = transactions_repo.list_transactions_missing_legs(session)
        # Only the two rows with a NULL leg, ordered by date asc.
        assert [t.date for t in missing] == [date(2024, 1, 2), date(2024, 1, 3)]


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

    def test_latest_closes_batch_matches_singular(self, session: Session) -> None:
        a = _seed_instrument(session, symbol="VTI")
        b = _seed_instrument(session, symbol="VXUS")
        c = _seed_instrument(session, symbol="BND")  # no prices ⇒ absent
        prices_repo.upsert_closes(
            session, a, {date(2024, 1, 2): Decimal("10"), date(2024, 1, 5): Decimal("12")}
        )
        prices_repo.upsert_closes(
            session, b, {date(2024, 1, 3): Decimal("20"), date(2024, 1, 6): Decimal("25")}
        )
        ids = [a, b, c]
        # Batched "latest" equals the per-instrument helper for every id.
        batched_latest = prices_repo.latest_closes(session, ids)
        assert batched_latest == {a: Decimal("12"), b: Decimal("25")}
        for iid in ids:
            assert batched_latest.get(iid) == prices_repo.latest_close(session, iid)
        # Batched "as-of" forward-fills exactly like ``close_as_of`` per id.
        as_of = date(2024, 1, 5)
        batched_as_of = prices_repo.latest_closes(session, ids, on_or_before=as_of)
        assert batched_as_of == {a: Decimal("12"), b: Decimal("20")}
        for iid in ids:
            assert batched_as_of.get(iid) == prices_repo.close_as_of(session, iid, as_of)

    def test_latest_closes_empty_ids(self, session: Session) -> None:
        assert prices_repo.latest_closes(session, []) == {}


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

    def test_persists_no_buy_and_settings(self, session: Session) -> None:
        i1 = _seed_instrument(session, "VTI")
        i2 = _seed_instrument(session, "VOO")
        allocations_repo.create_allocation(
            session,
            name="With no-buy",
            weights_by_instrument_id={i1: Decimal("70"), i2: Decimal("30")},
            active=True,
            no_buy_ids={i2},
            allow_sell=True,
            display_currency="USD",
        )
        active = allocations_repo.get_active(session)
        assert active is not None
        assert active.allow_sell is True
        assert active.display_currency == "USD"
        no_buy_by_id = {item.instrument_id: item.no_buy for item in active.items}
        assert no_buy_by_id == {i1: False, i2: True}

    def test_defaults_when_settings_omitted(self, session: Session) -> None:
        i1 = _seed_instrument(session, "VTI")
        allocations_repo.create_allocation(
            session,
            name="Plain",
            weights_by_instrument_id={i1: Decimal("100")},
            active=True,
        )
        active = allocations_repo.get_active(session)
        assert active is not None
        assert active.allow_sell is False
        assert active.display_currency is None
        assert all(item.no_buy is False for item in active.items)
