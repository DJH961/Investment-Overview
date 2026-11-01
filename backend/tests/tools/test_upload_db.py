"""Tests for ``inv-dashboard-upload-db`` (no network, tmp DBs only)."""

from __future__ import annotations

import hashlib
import importlib.util
import sqlite3
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config

from investment_dashboard.models.base import ConfigBase
from investment_dashboard.tools import upload_db

V5_HEAD = "c1f5a3b9e2d4"  # migration 0014, the last v5 revision


def _sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def _make_v5_ledger(path: Path) -> None:
    ini = upload_db._find_alembic_ini()
    cfg = Config(str(ini))
    cfg.set_main_option("script_location", str(ini.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", f"sqlite:///{path.as_posix()}")
    cfg.attributes["embedded"] = True
    command.upgrade(cfg, V5_HEAD)
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        INSERT INTO accounts (id, broker, account_label, native_currency, active)
            VALUES (1, 'vanguard', 'Main', 'USD', 1), (2, 'fidelity', 'Empty', 'USD', 1);
        INSERT INTO instruments (id, symbol, asset_class, native_currency)
            VALUES (1, 'VTI', 'etf', 'USD'), (2, 'OLD', 'stock', 'USD'), (3, 'TGT', 'etf', 'USD');
        INSERT INTO transactions (account_id, date, kind, instrument_id, source)
            VALUES (1, '2024-01-02', 'buy', 1, 'manual');
        """
    )
    conn.commit()
    conn.close()


def _make_config(path: Path) -> None:
    eng = sa.create_engine(f"sqlite:///{path.as_posix()}")
    ConfigBase.metadata.create_all(eng)
    eng.dispose()
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        INSERT INTO app_config (key, value) VALUES ('display_currency', 'EUR');
        INSERT INTO instrument_overrides (instrument_id, active) VALUES (2, 1);
        INSERT INTO target_allocations (id, name, active, allow_sell, created_at)
            VALUES (1, 'Plan', 1, 0, '2024-01-01');
        INSERT INTO target_allocation_items
            (target_allocation_id, instrument_id, weight_pct, no_buy)
            VALUES (1, 3, 100, 0);
        """
    )
    conn.commit()
    conn.close()


@pytest.fixture
def v5(tmp_path: Path) -> tuple[Path, Path]:
    ledger, config = tmp_path / "ledger.sqlite", tmp_path / "config.sqlite"
    _make_v5_ledger(ledger)
    _make_config(config)
    return ledger, config


def _query(path: Path, sql: str) -> list[tuple]:
    conn = sqlite3.connect(path)
    try:
        return conn.execute(sql).fetchall()
    finally:
        conn.close()


def test_prepare_plain(v5: tuple[Path, Path], tmp_path: Path) -> None:
    ledger, config = v5
    before = (_sha(ledger), _sha(config))
    out = tmp_path / "out" / "app.sqlite"

    res = upload_db.prepare_upload(ledger=ledger, config=config, out=out, encrypt=False)

    assert (_sha(ledger), _sha(config)) == before  # originals untouched
    assert _query(out, "SELECT version_num FROM alembic_version")[0][0] == res.revision
    assert res.revision != V5_HEAD
    assert _query(out, "SELECT key, value FROM app_config") == [("display_currency", "EUR")]
    # OLD pruned (unused, override dropped); TGT kept (target allocation); VTI used.
    assert res.pruned_instruments == ["OLD"]
    assert any(k.startswith("TGT") for k in res.kept_instruments)
    assert sorted(r[0] for r in _query(out, "SELECT symbol FROM instruments")) == ["TGT", "VTI"]
    assert _query(out, "SELECT COUNT(*) FROM instrument_overrides") == [(0,)]
    assert res.pruned_accounts == ["fidelity/Empty"]
    assert res.counts["accounts"] == 1
    assert res.counts["transactions"] == 1


def test_no_prune(v5: tuple[Path, Path], tmp_path: Path) -> None:
    ledger, config = v5
    out = tmp_path / "app.sqlite"
    res = upload_db.prepare_upload(
        ledger=ledger, config=config, out=out, prune=False, encrypt=False
    )
    assert res.counts["instruments"] == 3
    assert res.counts["accounts"] == 2


def test_rejects_output_equal_input(v5: tuple[Path, Path]) -> None:
    ledger, config = v5
    with pytest.raises(upload_db.UploadDbError):
        upload_db.prepare_upload(ledger=ledger, config=config, out=ledger, encrypt=False)


def test_missing_input(tmp_path: Path) -> None:
    with pytest.raises(upload_db.UploadDbError):
        upload_db.prepare_upload(
            ledger=tmp_path / "a", config=tmp_path / "b", out=tmp_path / "o", encrypt=False
        )


def test_encrypted_requires_passphrase(v5: tuple[Path, Path], tmp_path: Path) -> None:
    ledger, config = v5
    with pytest.raises(upload_db.UploadDbError):
        upload_db.prepare_upload(ledger=ledger, config=config, out=tmp_path / "o")


@pytest.mark.skipif(
    importlib.util.find_spec("sqlcipher3") is None
    and importlib.util.find_spec("pysqlcipher3") is None,
    reason="no SQLCipher driver",
)
def test_encrypted_roundtrip(v5: tuple[Path, Path], tmp_path: Path) -> None:
    ledger, config = v5
    out = tmp_path / "app.sqlite"
    res = upload_db.prepare_upload(ledger=ledger, config=config, out=out, passphrase="s3cret-pass")
    assert res.encrypted
    assert not out.read_bytes().startswith(b"SQLite format 3")


def test_local_only_summary_has_no_server_commands(
    v5: tuple[Path, Path], tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    ledger, config = v5
    res = upload_db.prepare_upload(
        ledger=ledger, config=config, out=tmp_path / "app.sqlite", encrypt=False
    )
    upload_db._print_summary(res, local_only=True)
    out = capsys.readouterr().out
    assert "inv-dashboard-server" in out
    assert "scp" not in out.lower()
    upload_db._print_summary(res)
    assert "scp" in capsys.readouterr().out.lower()


def test_cli_plain_local_trial_needs_no_passphrase(
    v5: tuple[Path, Path],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    ledger, config = v5
    monkeypatch.delenv("INV_DASHBOARD_DB_PASSPHRASE", raising=False)
    out = tmp_path / "app.sqlite"
    argv = ["--ledger", str(ledger), "--config", str(config), "--out", str(out)]
    assert upload_db.main([*argv, "--local-only", "--plain"]) == 0
    assert out.read_bytes()[:16] == b"SQLite format 3\x00"
    assert "ENCRYPT_SYNCED_TIERS=false" in capsys.readouterr().out


def test_cli_plain_is_refused_for_the_server(v5: tuple[Path, Path], tmp_path: Path) -> None:
    ledger, config = v5
    argv = ["--ledger", str(ledger), "--config", str(config), "--out", str(tmp_path / "a.sqlite")]
    assert upload_db.main([*argv, "--plain"]) == 2
