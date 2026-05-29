"""Test for the ``inv-dashboard-export-snapshot`` CLI."""

from __future__ import annotations

import json
from contextlib import contextmanager
from pathlib import Path

import pytest
from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from investment_dashboard.tools import export_snapshot


def test_export_writes_json_snapshot(
    engine: Engine, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

    @contextmanager
    def _fake_scope():  # type: ignore[no-untyped-def]
        s: Session = factory()
        try:
            yield s
            s.commit()
        finally:
            s.close()

    # Avoid the real boot sequence (migrations/lock/network) and DB wiring.
    monkeypatch.setattr(
        "investment_dashboard.boot.run_boot_sequence", lambda **_: None, raising=True
    )
    monkeypatch.setattr("investment_dashboard.db.session_scope", _fake_scope, raising=True)

    out = tmp_path / "cloud" / "mobile_snapshot.json"
    rc = export_snapshot.main(["--output", str(out), "--indent", "2"])
    assert rc == 0
    assert out.exists()

    data = json.loads(out.read_text(encoding="utf-8"))
    assert "meta" in data
    assert data["meta"]["base_currency"] == "EUR"
    # Atomic-write must leave no temp files behind.
    assert list(out.parent.glob(".*tmp*")) == []
