# ruff: noqa: PT018
"""Conversions back to euros (7.4): direction, the deposit pool and withdrawal pins."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.models import Account, FxHistory, Transaction
from investment_dashboard.services import fx_conversion_service as svc
from investment_dashboard.services import settings_registry as reg

D = Decimal


def _seed(session: Session) -> tuple[int, int]:
    usd = Account(broker="vanguard", account_label="V", native_currency="USD")
    session.add(usd)
    session.flush()
    session.add(FxHistory(date=date(2024, 1, 1), base="EUR", quote="USD", rate=D("1.25")))
    dep = Transaction(
        account_id=usd.id,
        date=date(2024, 2, 1),
        kind="deposit",
        net_native=D("1000"),
        source="manual",
    )
    wd = Transaction(
        account_id=usd.id,
        date=date(2024, 3, 1),
        kind="withdrawal",
        net_native=D("-300"),
        source="manual",
    )
    session.add_all([dep, wd])
    session.flush()
    return dep.id, wd.id


def test_direction_is_derived_from_the_pair(session: Session) -> None:
    to_usd = svc.create_conversion(
        session, on=date(2024, 1, 10), eur_sent=D("800"), usd_received=D("1000")
    )
    back = svc.create_conversion(
        session,
        on=date(2024, 3, 5),
        eur_sent=D("230"),
        usd_received=D("300"),
        from_ccy="USD",
        to_ccy="EUR",
    )
    assert svc.direction(to_usd) == "to_usd"
    assert svc.direction(back) == "to_eur"
    with pytest.raises(ValueError, match="kept_usd"):
        svc.create_conversion(
            session,
            on=date(2024, 3, 5),
            eur_sent=D("1"),
            usd_received=D("2"),
            from_ccy="USD",
            to_ccy="EUR",
            kept_usd=D("1"),
        )
    with pytest.raises(ValueError, match="supported"):
        svc.create_conversion(
            session,
            on=date(2024, 3, 5),
            eur_sent=D("1"),
            usd_received=D("2"),
            from_ccy="GBP",
            to_ccy="EUR",
        )


def test_conversion_back_never_fills_the_deposit_pool(session: Session) -> None:
    dep_id, _wd = _seed(session)
    svc.create_conversion(session, on=date(2024, 1, 10), eur_sent=D("800"), usd_received=D("1000"))
    before = svc.effective_eur_overrides(session)
    back = svc.create_conversion(
        session,
        on=date(2024, 3, 5),
        eur_sent=D("230"),
        usd_received=D("300"),
        fees_eur=D("2"),
        from_ccy="USD",
        to_ccy="EUR",
    )
    assert svc.effective_eur_overrides(session) == before == {dep_id: D("800")}
    assert [b.id for b in svc.batches(session)] != [back.id]
    assert all(b.id != back.id for b in svc.batches(session))
    (cb,) = svc.conversions_back(session)
    assert (cb.id, cb.from_ccy, cb.sent, cb.eur_received, cb.fees_eur) == (
        back.id,
        "USD",
        D("300"),
        D("230"),
        D("2"),
    )


def test_only_back_rows_keep_today_without_overrides(session: Session) -> None:
    _seed(session)
    svc.create_conversion(
        session,
        on=date(2024, 3, 5),
        eur_sent=D("230"),
        usd_received=D("300"),
        from_ccy="USD",
        to_ccy="EUR",
    )
    assert svc.effective_eur_overrides(session) == {}


def test_withdrawal_pins_reuse_the_pins_table(session: Session) -> None:
    dep_id, wd_id = _seed(session)
    to_usd = svc.create_conversion(
        session, on=date(2024, 1, 10), eur_sent=D("800"), usd_received=D("1000")
    )
    back = svc.create_conversion(
        session,
        on=date(2024, 3, 5),
        eur_sent=D("230"),
        usd_received=D("300"),
        from_ccy="USD",
        to_ccy="EUR",
    )
    svc.set_withdrawal_pins(session, wd_id, [(back.id, D("300"))])
    (pin,) = svc.withdrawal_pins(session)
    assert (pin.deposit_id, pin.conversion_id, pin.usd) == (wd_id, back.id, D("300"))
    # deposit matching ignores it
    assert svc.deposit_match(session, dep_id).matched[0].conversion_id == to_usd.id
    with pytest.raises(ValueError, match="back to euros"):
        svc.set_withdrawal_pins(session, wd_id, [(to_usd.id, D("1"))])
    with pytest.raises(ValueError, match="withdrawal"):
        svc.set_pins(session, dep_id, [(back.id, D("1"))])
    with pytest.raises(ValueError, match="more than its amount"):
        svc.set_withdrawal_pins(session, wd_id, [(back.id, D("301"))])
    with pytest.raises(ValueError, match="not a USD withdrawal"):
        svc.set_withdrawal_pins(session, dep_id, [(back.id, D("1"))])


def test_currency_section_holds_the_fx_settings() -> None:
    assert reg.SECTIONS["currency"] == "Currency"
    basis = reg.BY_KEY["fx.holding_cost_basis"]
    assert (basis.section, basis.default, basis.choices) == (
        "currency",
        "pool",
        ("pool", "buy_date"),
    )
    for key in ("fx.holding_cost_basis", "fx.tracked_quotes", "fx.stale_after_seconds"):
        d = reg.BY_KEY[key]
        assert d.section == "currency" and d.level != "advanced", key
