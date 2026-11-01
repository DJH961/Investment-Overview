"""Tests for the config-tier instrument_overrides repository."""

from __future__ import annotations

from sqlalchemy.orm import Session

from investment_dashboard.repositories import instrument_overrides_repo, instruments_repo


def test_defaults_when_no_row(session: Session) -> None:
    instr = instruments_repo.get_or_create(session, symbol="VTI")
    assert instrument_overrides_repo.get(session, instr.id) is None
    assert instrument_overrides_repo.get_category(session, instr.id) is None
    assert instrument_overrides_repo.is_active(session, instr.id) is True
    assert instrument_overrides_repo.inactive_ids(session) == set()


def test_set_category_upserts(session: Session) -> None:
    instr = instruments_repo.get_or_create(session, symbol="VTI")
    ov = instrument_overrides_repo.set_category(session, instr.id, "Total US")
    assert ov.category == "Total US"
    assert ov.active is True
    # Second call updates in place.
    ov2 = instrument_overrides_repo.set_category(session, instr.id, "US Stocks")
    assert ov2.category == "US Stocks"
    assert ov2.instrument_id == instr.id


def test_set_active_does_not_clobber_category(session: Session) -> None:
    instr = instruments_repo.get_or_create(session, symbol="VTI")
    instrument_overrides_repo.set_category(session, instr.id, "Total US")
    instrument_overrides_repo.set_active(session, instr.id, False)
    ov = instrument_overrides_repo.get(session, instr.id)
    assert ov is not None
    assert ov.category == "Total US"
    assert ov.active is False


def test_inactive_ids_only_tracks_explicit_false(session: Session) -> None:
    a = instruments_repo.get_or_create(session, symbol="VTI")
    b = instruments_repo.get_or_create(session, symbol="VOO")
    c = instruments_repo.get_or_create(session, symbol="BND")
    instrument_overrides_repo.set_active(session, b.id, False)
    instrument_overrides_repo.set_category(session, c.id, "US Bonds")  # active stays True
    inactive = instrument_overrides_repo.inactive_ids(session)
    assert inactive == {b.id}
    assert a.id not in inactive
    assert c.id not in inactive


def test_get_override_map_partial(session: Session) -> None:
    a = instruments_repo.get_or_create(session, symbol="VTI")
    b = instruments_repo.get_or_create(session, symbol="VOO")
    instrument_overrides_repo.set_category(session, a.id, "Total US")
    overrides = instrument_overrides_repo.get_override_map(session, [a.id, b.id])
    assert set(overrides.keys()) == {a.id}
    assert overrides[a.id].category == "Total US"


def test_get_override_map_all_when_none(session: Session) -> None:
    a = instruments_repo.get_or_create(session, symbol="VTI")
    instrument_overrides_repo.set_category(session, a.id, "Total US")
    overrides = instrument_overrides_repo.get_override_map(session, None)
    assert set(overrides.keys()) == {a.id}


def test_get_override_map_empty_ids(session: Session) -> None:
    assert instrument_overrides_repo.get_override_map(session, []) == {}


def test_delete_for(session: Session) -> None:
    instr = instruments_repo.get_or_create(session, symbol="VTI")
    instrument_overrides_repo.set_active(session, instr.id, False)
    instrument_overrides_repo.delete_for(session, instr.id)
    assert instrument_overrides_repo.get(session, instr.id) is None
    # Deleting a missing row is a no-op (idempotent).
    instrument_overrides_repo.delete_for(session, instr.id)
