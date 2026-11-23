# ruff: noqa: PT018
"""Recurring plans: est. row generation (catch-up, idempotence, pending), settling, CRUD."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from investment_dashboard.models import Account, FxConversion, FxHistory, Instrument, Transaction
from investment_dashboard.services import diagnostics_service, prices_service
from investment_dashboard.services import recurring_service as svc

D = Decimal


def _world(session: Session) -> tuple[Account, Instrument]:
    acct = Account(broker="vanguard", account_label="Brokerage", native_currency="USD")
    inst = Instrument(symbol="VOO", name="Test fund", asset_class="etf", native_currency="USD")
    session.add_all([acct, inst])
    session.flush()
    return acct, inst


def _buy_plan(
    session: Session,
    acct: Account,
    inst: Instrument,
    *,
    amount: Decimal | None = Decimal(20),
    shares: Decimal | None = None,
    legs: tuple[svc.LegInput, ...] | None = None,
    **kw: object,
) -> int:
    data = svc.PlanInput(
        **{
            "kind": "buy",
            "unit": "months",
            "every": 1,
            "anchor": 15,
            "start_date": date(2026, 1, 1),
            "account_id": acct.id,
            "legs": legs or (svc.LegInput(inst.id, amount, shares),),
            **kw,
        }  # type: ignore[arg-type]
    )
    return svc.create_plan(session, data).id


def _estimates(session: Session) -> list[Transaction]:
    return list(session.scalars(select(Transaction).where(Transaction.is_estimate.is_(True))))


def test_buy_catches_up_every_missed_due_date_at_the_session_close(session: Session) -> None:
    acct, inst = _world(session)
    plan_id = _buy_plan(session, acct, inst)
    # Due 15 Jan (Thu), 15 Feb (Sun -> Presidents' Day Mon -> Tue 17th), 15 Mar (Sun -> Mon 16th).
    prices_service.store_closes(
        session,
        inst.id,
        {date(2026, 1, 15): D("100"), date(2026, 2, 17): D("125"), date(2026, 3, 16): D("80")},
        source="test",
    )
    report = svc.generate_due_estimates(session, today=date(2026, 3, 20), settled=date(2026, 3, 20))
    assert (report.created, report.pending) == (3, 0)
    rows = sorted(_estimates(session), key=lambda t: t.date)
    assert [r.date for r in rows] == [date(2026, 1, 15), date(2026, 2, 17), date(2026, 3, 16)]
    assert [r.estimate_due_date for r in rows] == [
        date(2026, 1, 15),
        date(2026, 2, 15),
        date(2026, 3, 15),
    ]
    assert [r.quantity for r in rows] == [D("0.2"), D("0.16"), D("0.25")]
    assert all(
        r.kind == "buy" and r.gross_native == D("20") and r.net_native == D("-20") for r in rows
    )
    assert all(r.fees_native == 0 and r.estimate_plan_id == plan_id for r in rows)
    # Idempotent, and a deleted est. row stays deleted.
    assert svc.generate_due_estimates(session, today=date(2026, 3, 20)).created == 0
    session.delete(rows[1])
    session.flush()
    assert svc.generate_due_estimates(session, today=date(2026, 3, 20)).created == 0
    assert len(_estimates(session)) == 2


def test_unsettled_close_waits_and_blocks_later_dates(session: Session) -> None:
    acct, inst = _world(session)
    plan_id = _buy_plan(session, acct, inst, shares=D("2"), amount=None)
    prices_service.store_closes(session, inst.id, {date(2026, 1, 15): D("50")}, source="test")
    report = svc.generate_due_estimates(session, today=date(2026, 2, 20), settled=date(2026, 2, 20))
    assert (report.created, report.pending) == (1, 1)
    only = _estimates(session)[0]
    assert only.quantity == D("2") and only.gross_native == D("100")
    plan = svc.get_plan(session, plan_id)
    assert plan.generated_through == date(2026, 1, 15)
    # Not settled yet: the session of the due date is after the latest settled one.
    prices_service.store_closes(session, inst.id, {date(2026, 2, 17): D("60")}, source="test")
    assert (
        svc.generate_due_estimates(
            session, today=date(2026, 2, 17), settled=date(2026, 2, 16)
        ).created
        == 0
    )
    assert (
        svc.generate_due_estimates(
            session, today=date(2026, 2, 17), settled=date(2026, 2, 17)
        ).created
        == 1
    )


def test_paused_plan_writes_nothing_and_resume_skips_the_pause(session: Session) -> None:
    acct, inst = _world(session)
    plan_id = _buy_plan(session, acct, inst)
    svc.pause_plan(session, plan_id)
    assert svc.generate_due_estimates(session, today=date(2026, 3, 20)).created == 0
    svc.resume_plan(session, plan_id, today=date(2026, 3, 20))
    prices_service.store_closes(session, inst.id, {date(2026, 4, 15): D("100")}, source="test")
    report = svc.generate_due_estimates(session, today=date(2026, 4, 20), settled=date(2026, 4, 20))
    assert report.created == 1  # only 15 Apr; Jan to Mar fell inside the pause
    view = svc.plan_view(session, svc.get_plan(session, plan_id), today=date(2026, 4, 20))
    assert view.status == "active" and view.next_due == date(2026, 5, 15)


def test_ended_plan_and_delete_keeps_rows(session: Session) -> None:
    acct, inst = _world(session)
    plan_id = _buy_plan(session, acct, inst, end_date=date(2026, 1, 31))
    prices_service.store_closes(session, inst.id, {date(2026, 1, 15): D("100")}, source="test")
    assert (
        svc.generate_due_estimates(
            session, today=date(2026, 3, 20), settled=date(2026, 3, 20)
        ).created
        == 1
    )
    assert (
        svc.plan_view(session, svc.get_plan(session, plan_id), today=date(2026, 3, 20)).status
        == "ended"
    )
    svc.delete_plan(session, plan_id)
    (row,) = _estimates(session)
    assert row.estimate_plan_id is None and row.estimate_due_date == date(2026, 1, 15)
    with pytest.raises(svc.PlanNotFoundError):
        svc.get_plan(session, plan_id)


def test_unique_plan_and_due_date(session: Session) -> None:
    acct, inst = _world(session)
    plan_id = _buy_plan(session, acct, inst)
    for _ in range(2):
        session.add(
            Transaction(
                account_id=acct.id,
                date=date(2026, 1, 15),
                kind="buy",
                source="manual",
                is_estimate=True,
                estimate_plan_id=plan_id,
                estimate_due_date=date(2026, 1, 15),
            )
        )
    with pytest.raises(IntegrityError):
        session.flush()


def _fx(session: Session, rates: dict[date, str]) -> None:
    for on, rate in rates.items():
        session.add(FxHistory(date=on, base="EUR", quote="USD", rate=D(rate)))
    session.flush()


def _conv_plan(session: Session, provider: str, **kw: object) -> int:
    data = svc.PlanInput(
        **{
            "kind": "conversion",
            "unit": "months",
            "every": 1,
            "anchor": 10,
            "start_date": date(2026, 2, 1),
            "end_date": date(2026, 2, 28),
            "amount": D("500"),
            "provider": provider,
            **kw,
        }  # type: ignore[arg-type]
    )
    return svc.create_plan(session, data).id


def test_conversion_is_ecb_pushed_by_the_providers_average_off_pct(session: Session) -> None:
    from investment_dashboard.services import fx_conversion_service as fxs

    _fx(session, {date(2026, 1, 5): "1.10", date(2026, 2, 10): "1.20"})
    fxs.create_conversion(
        session,
        on=date(2026, 1, 5),
        eur_sent=D("1000"),
        usd_received=D("1089"),  # 1.089 = ECB 1.10 less 1 %
        fees_eur=D("2"),
        provider="wise",
    )
    plan_id = _conv_plan(session, "wise")
    assert svc.get_plan(session, plan_id).expected_fee == D("2")  # defaulted from the last real one
    report = svc.generate_due_estimates(session, today=date(2026, 2, 12), settled=date(2026, 2, 12))
    assert report.created == 1
    est = session.scalars(select(FxConversion).where(FxConversion.is_estimate.is_(True))).one()
    assert est.date == date(2026, 2, 10) and est.provider == "wise"
    assert est.eur_sent == D("500") and est.fees_eur == D("2")
    assert est.usd_received == D("594")  # 500 x 1.20 x 0.99
    # The est. row is not "history": the next estimate still uses real conversions only.
    assert svc.estimate_count(session) == 1


def test_conversion_without_history_is_plain_ecb_and_weekend_uses_last_fixing(
    session: Session,
) -> None:
    _fx(session, {date(2026, 2, 13): "1.25"})  # a Friday; the 14th is a Saturday
    _conv_plan(session, "revolut", anchor=14, expected_fee=D("1.5"))
    # A weekday's fixing may still be published; a Saturday never is.
    report = svc.generate_due_estimates(session, today=date(2026, 2, 15), settled=date(2026, 2, 13))
    assert report.created == 1
    est = session.scalars(select(FxConversion)).one()
    assert est.date == date(2026, 2, 14)  # keeps its date
    assert est.usd_received == D("625")  # plain ECB 1.25 x 500
    assert est.fees_eur == D("1.5")


def test_conversion_waits_for_a_weekdays_own_fixing(session: Session) -> None:
    _fx(session, {date(2026, 2, 9): "1.20"})
    _conv_plan(session, "wise")
    assert svc.generate_due_estimates(session, today=date(2026, 2, 10)).created == 0
    assert svc.generate_due_estimates(session, today=date(2026, 2, 12)).created == 0
    # Four days on without a fixing: fall back to the last one.
    assert svc.generate_due_estimates(session, today=date(2026, 2, 14)).created == 1


def test_settle_typed_figures_and_whole_due_date(session: Session) -> None:
    acct, inst = _world(session)
    _buy_plan(session, acct, inst)
    prices_service.store_closes(
        session,
        inst.id,
        {date(2026, 1, 15): D("100"), date(2026, 2, 17): D("125")},
        source="test",
    )
    svc.generate_due_estimates(session, today=date(2026, 2, 20), settled=date(2026, 2, 20))
    jan, feb = sorted(_estimates(session), key=lambda t: t.date)
    assert svc.estimate_count(session) == 2
    n = svc.settle(
        session, [svc.SettleItem("transaction", jan.id, price=D("101"), total=D("19.99"))]
    )
    assert n == 1
    assert jan.is_estimate is False
    assert jan.price_native == D("101") and jan.gross_native == D("19.99")
    assert jan.estimate_due_date == date(2026, 1, 15)  # the slot stays taken
    assert svc.settle(session, due_date=date(2026, 2, 15)) == 1
    assert feb.is_estimate is False and feb.price_native == D("125")
    assert svc.estimate_count(session) == 0
    with pytest.raises(svc.RecurringError):
        svc.settle(session, [svc.SettleItem("transaction", jan.id)])  # already settled


def test_confirm_estimate_clears_only_the_flag(session: Session) -> None:
    _fx(session, {date(2026, 2, 10): "1.20"})
    _conv_plan(session, "other", expected_fee=D("0"))
    svc.generate_due_estimates(session, today=date(2026, 2, 12))
    est = session.scalars(select(FxConversion)).one()
    assert svc.confirm_estimate(session, est) is True
    assert est.is_estimate is False and est.estimate_due_date == date(2026, 2, 10)
    assert svc.confirm_estimate(session, est) is False


def test_settle_typed_conversion(session: Session) -> None:
    _fx(session, {date(2026, 2, 10): "1.20"})
    _conv_plan(session, "other", expected_fee=D("0"))
    svc.generate_due_estimates(session, today=date(2026, 2, 12))
    est = session.scalars(select(FxConversion)).one()
    svc.settle(
        session,
        [svc.SettleItem("fx_conversion", est.id, sent=D("500"), received=D("598.5"), fees=D("1"))],
    )
    assert est.usd_received == D("598.5") and est.fees_eur == D("1") and not est.is_estimate


def test_plan_validation(session: Session) -> None:
    acct, inst = _world(session)
    with pytest.raises(svc.RecurringError, match="amount or shares"):
        _buy_plan(session, acct, inst, shares=D("1"))
    plan = svc.create_plan(
        session,
        svc.PlanInput(
            kind="conversion", unit="days", every=7, start_date=date(2026, 1, 1), amount=D("5")
        ),
    )
    assert plan.provider == "revolut"  # the default provider
    with pytest.raises(svc.RecurringError, match="account"):
        svc.create_plan(
            session,
            svc.PlanInput(
                kind="deposit", unit="months", every=1, start_date=date(2026, 1, 1), amount=D("5")
            ),
        )
    with pytest.raises(svc.RecurringError, match="end date"):
        _buy_plan(session, acct, inst, end_date=date(2025, 1, 1))
    with pytest.raises(svc.RecurringError, match="weekday"):
        _buy_plan(session, acct, inst, unit="weeks", anchor=9)


def test_est_buy_draws_the_settlement_fund_and_settles_with_it(session: Session) -> None:
    acct, inst = _world(session)
    fund = Instrument(
        symbol="VMFXX", name="Money Market", asset_class="mutual_fund", native_currency="USD"
    )
    session.add(fund)
    session.flush()
    session.add(
        Transaction(
            account_id=acct.id,
            date=date(2025, 12, 1),
            kind="buy",
            instrument_id=fund.id,
            quantity=D("5000"),
            price_native=D("1"),
            net_native=D("-5000"),
            source="manual",
        )
    )
    _buy_plan(session, acct, inst, amount=D("500"))
    prices_service.store_closes(session, inst.id, {date(2026, 1, 15): D("250.00")}, source="test")
    report = svc.generate_due_estimates(session, today=date(2026, 1, 20), settled=date(2026, 1, 20))
    assert report.created == 1
    flagged = _estimates(session)
    assert len(flagged) == 2  # the buy and its fund leg carry the flag...
    assert svc.estimate_count(session) == 1  # ...but are one row to settle
    parent = next(t for t in flagged if t.instrument_id == inst.id)
    leg = next(t for t in flagged if t.instrument_id == fund.id)
    assert parent.quantity == D("2")
    assert (leg.kind, leg.quantity, leg.price_native, leg.net_native) == (
        "sell",
        D("-500"),
        D("1"),
        D("500"),
    )
    assert leg.external_id == f"{parent.external_id}:vmfxx"
    svc.settle(
        session, [svc.SettleItem("transaction", parent.id, price=D("249.90"), total=D("499.80"))]
    )
    assert svc.estimate_count(session) == 0
    assert _estimates(session) == []
    assert leg.quantity == D("-499.80") and leg.net_native == D("499.80")


def test_plan_notes_a_missing_settlement_fund(session: Session) -> None:
    acct, inst = _world(session)
    plan_id = _buy_plan(session, acct, inst)
    view = svc.plan_view(session, svc.get_plan(session, plan_id), today=date(2026, 1, 1))
    assert view.note == svc.NO_FUND_NOTE


def _fund(session: Session, acct: Account) -> Instrument:
    fund = Instrument(
        symbol="VMFXX", name="Money Market", asset_class="mutual_fund", native_currency="USD"
    )
    session.add(fund)
    session.flush()
    session.add(
        Transaction(
            account_id=acct.id,
            date=date(2025, 12, 1),
            kind="buy",
            instrument_id=fund.id,
            quantity=D("1"),
            price_native=D("1"),
            net_native=D("-1"),
            source="manual",
        )
    )
    return fund


def test_est_deposit_is_the_import_shape_and_needs_no_input(session: Session) -> None:
    acct, _inst = _world(session)
    fund = _fund(session, acct)
    svc.create_plan(
        session,
        svc.PlanInput(
            kind="deposit",
            unit="months",
            every=1,
            anchor=5,
            start_date=date(2026, 1, 1),
            account_id=acct.id,
            amount=D("2500"),
        ),
    )
    assert svc.generate_due_estimates(session, today=date(2026, 2, 10)).created == 2
    flagged = _estimates(session)
    deposits = [t for t in flagged if t.kind == "deposit"]
    legs = [t for t in flagged if t.instrument_id == fund.id]
    assert [d.net_native for d in deposits] == [D("2500"), D("2500")]
    assert [leg.quantity for leg in legs] == [D("2500"), D("2500")]  # core fund bought at $1
    assert all(leg.external_id.endswith(":vmfxx") for leg in legs)
    # Carries the flag (for the import to update) but never prompts.
    assert svc.estimate_count(session) == 0
    assert svc.estimate_views(session) == []
    assert svc.reminder_groups(session) == []


def test_reminder_is_one_line_per_plan_and_says_what_to_do(session: Session) -> None:
    acct, inst = _world(session)
    _buy_plan(session, acct, inst, unit="weeks", anchor=0)
    prices_service.store_closes(
        session,
        inst.id,
        {date(2026, 1, 5): D("10"), date(2026, 1, 12): D("11"), date(2026, 1, 20): D("12")},
        source="test",
    )
    _fx(session, {date(2026, 1, 20): "1.2"})
    _conv_plan(session, "revolut", anchor=20, start_date=date(2026, 1, 1), end_date=None)
    svc.generate_due_estimates(session, today=date(2026, 1, 21), settled=date(2026, 1, 21))
    groups = {g.kind: g for g in svc.reminder_groups(session)}
    assert (groups["buy"].count, groups["buy"].input) == (3, "import")
    assert groups["buy"].message.startswith("Weekly buys (Vanguard): 3 to settle")
    assert "import your Vanguard file, or type them" in groups["buy"].message.lower() or (
        "Import your Vanguard file, or type them" in groups["buy"].message
    )
    assert groups["conversion"].message == "Revolut conversion, 20 Jan: type what you received"
    assert svc.estimate_count(session) == 4


def test_ledger_precision_follows_real_rows_not_estimates(session: Session) -> None:
    acct, inst = _world(session)
    assert svc.ledger_precision(session, acct.id, inst.id) == (4, 4)
    session.add(
        Transaction(
            account_id=acct.id,
            date=date(2026, 1, 2),
            kind="buy",
            instrument_id=inst.id,
            quantity=D("1.234"),
            price_native=D("101.123456"),
            net_native=D("-124.8"),
            source="import_generic",
        )
    )
    session.flush()
    assert svc.ledger_precision(session, acct.id, inst.id) == (6, 3)


def test_hand_settled_row_is_a_normal_confirmed_row(session: Session) -> None:
    acct, inst = _world(session)
    _buy_plan(session, acct, inst)
    prices_service.store_closes(session, inst.id, {date(2026, 1, 15): D("100")}, source="test")
    svc.generate_due_estimates(session, today=date(2026, 1, 20), settled=date(2026, 1, 20))
    (row,) = _estimates(session)
    svc.settle(session, [svc.SettleItem("transaction", row.id, price=D("100.01"), total=D("20"))])
    # What a later import's matcher compares: account, instrument, date, kind, shares, amount.
    assert (row.is_estimate, row.source, row.kind) == (False, "manual", "buy")
    assert (row.account_id, row.instrument_id, row.date) == (acct.id, inst.id, date(2026, 1, 15))
    assert row.gross_native == D("20") and row.fees_native == D("0")
    assert abs(row.quantity - D("20") / D("100.01")) < D("0.00000001")


def test_suggestions_read_the_recent_ledger(session: Session) -> None:
    acct, inst = _world(session)
    for d in (date(2026, 9, 5), date(2026, 10, 5), date(2026, 11, 5)):
        session.add(
            Transaction(
                account_id=acct.id,
                date=d,
                kind="deposit",
                net_native=D("2500"),
                source="import_generic",
            )
        )
    for i in range(4):
        session.add(
            Transaction(
                account_id=acct.id,
                date=date(2026, 11, 2) + timedelta(weeks=i),
                kind="buy",
                instrument_id=inst.id,
                quantity=D("1"),
                price_native=D("50"),
                gross_native=D("50"),
                net_native=D("-50"),
                source="import_generic",
            )
        )
    session.flush()
    found = {s.kind: s for s in svc.suggest_routine(session, today=date(2026, 11, 30))}
    assert (found["deposit"].cadence.unit, found["deposit"].cadence.anchor) == ("months", 5)
    assert found["deposit"].cadence.amount == D("2500")
    assert (found["buy"].cadence.unit, [leg.symbol for leg in found["buy"].legs]) == (
        "weeks",
        ["VOO"],
    )
    assert svc.list_plans(session) == []  # suggestions never create plans


def test_data_health_reports_one_quiet_item(session: Session) -> None:
    acct, inst = _world(session)
    _buy_plan(session, acct, inst)
    prices_service.store_closes(
        session, inst.id, {date(2026, 1, 15): D("100"), date(2026, 2, 17): D("125")}, source="test"
    )
    svc.generate_due_estimates(session, today=date(2026, 2, 20), settled=date(2026, 2, 20))
    item = diagnostics_service._check_estimated_rows(session)
    assert (item.key, item.severity, item.count) == ("estimated_rows", "warning", 2)
    svc.settle(session, due_date=date(2026, 1, 15))
    svc.settle(session, due_date=date(2026, 2, 15))
    assert diagnostics_service._check_estimated_rows(session).severity == "ok"


def test_one_plan_buys_several_holdings_per_due_date(session: Session) -> None:
    acct, inst = _world(session)
    other = Instrument(symbol="BND", name="Bonds", asset_class="etf", native_currency="USD")
    fund = Instrument(
        symbol="VMFXX", name="Money Market", asset_class="mutual_fund", native_currency="USD"
    )
    session.add_all([other, fund])
    session.flush()
    session.add(
        Transaction(
            account_id=acct.id,
            date=date(2025, 12, 1),
            kind="buy",
            instrument_id=fund.id,
            quantity=D("1"),
            price_native=D("1"),
            net_native=D("-1"),
            source="manual",
        )
    )
    _buy_plan(
        session,
        acct,
        inst,
        unit="weeks",
        anchor=0,
        legs=(svc.LegInput(inst.id, D("100")), svc.LegInput(other.id, None, D("2"))),
    )
    prices_service.store_closes(
        session, inst.id, {date(2026, 1, 5): D("50"), date(2026, 1, 12): D("50")}, source="test"
    )
    prices_service.store_closes(session, other.id, {date(2026, 1, 5): D("10")}, source="test")
    # BND has no close on the 12th yet: the 5th is complete, the 12th waits (VOO's leg is written).
    report = svc.generate_due_estimates(session, today=date(2026, 1, 13), settled=date(2026, 1, 13))
    assert (report.created, report.pending) == (3, 1)
    rows = [t for t in _estimates(session) if t.estimate_plan_id is not None]
    assert sorted((t.date, t.instrument_id) for t in rows) == sorted(
        [(date(2026, 1, 5), inst.id), (date(2026, 1, 5), other.id), (date(2026, 1, 12), inst.id)]
    )
    assert len({t.estimate_leg_id for t in rows}) == 2  # one leg id per holding
    # One core-fund draw per buy, like the import; two items to settle (one per due date).
    legs = [t for t in _estimates(session) if t.instrument_id == fund.id]
    assert len(legs) == 3
    assert svc.estimate_count(session) == 2
    prices_service.store_closes(session, other.id, {date(2026, 1, 12): D("11")}, source="test")
    assert (
        svc.generate_due_estimates(
            session, today=date(2026, 1, 13), settled=date(2026, 1, 13)
        ).created
        == 1
    )
    assert svc.generate_due_estimates(session, today=date(2026, 1, 13)).created == 0
    (g,) = svc.reminder_groups(session)
    assert g.count == 2
    assert g.message.startswith("Weekly buys (Vanguard): 2 due dates (4 buys) to settle")


def test_same_rhythm_buys_are_suggested_as_one_multi_leg_plan(session: Session) -> None:
    acct, inst = _world(session)
    other = Instrument(symbol="BND", name="Bonds", asset_class="etf", native_currency="USD")
    session.add(other)
    session.flush()
    for i in range(4):
        for ins, amt in ((inst, "100"), (other, "50")):
            session.add(
                Transaction(
                    account_id=acct.id,
                    date=date(2026, 11, 2) + timedelta(weeks=i),
                    kind="buy",
                    instrument_id=ins.id,
                    quantity=D("1"),
                    price_native=D(amt),
                    gross_native=D(amt),
                    net_native=-D(amt),
                    source="import_generic",
                )
            )
    session.flush()
    (found,) = [
        s for s in svc.suggest_routine(session, today=date(2026, 11, 30)) if s.kind == "buy"
    ]
    assert sorted((leg.symbol, leg.amount) for leg in found.legs) == [
        ("BND", D("50")),
        ("VOO", D("100")),
    ]
    assert (found.cadence.unit, found.cadence.anchor) == ("weeks", 0)
