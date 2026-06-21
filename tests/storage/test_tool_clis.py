"""Tests for repair_sidecar, backup, and split_db encryption CLIs."""

from __future__ import annotations

import json
import logging
import sqlite3
from pathlib import Path

import pytest

from investment_dashboard.tools import backup as backup_cli
from investment_dashboard.tools import repair_sidecar as repair_cli
from investment_dashboard.tools import split_db as split_db_mod
from investment_dashboard.tools._passphrase import ENV_VAR, resolve_passphrase


def _make_sqlite(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
    conn.execute("INSERT INTO t (v) VALUES ('x')")
    conn.commit()
    conn.close()


def test_repair_sidecar_cli_noop(tmp_path: Path) -> None:
    db = tmp_path / "ledger.sqlite"
    _make_sqlite(db)
    rc = repair_cli.main([str(db)])
    assert rc == 0


def test_repair_sidecar_cli_missing_file(tmp_path: Path) -> None:
    rc = repair_cli.main([str(tmp_path / "absent.sqlite")])
    assert rc == 2


def test_repair_sidecar_cli_removes_stray(tmp_path: Path) -> None:
    db = tmp_path / "ledger.sqlite"
    _make_sqlite(db)
    (tmp_path / "ledger.sqlite-wal").touch()
    rc = repair_cli.main([str(db)])
    assert rc == 0
    assert not (tmp_path / "ledger.sqlite-wal").exists()


def test_backup_cli_writes_snapshot(tmp_path: Path) -> None:
    db = tmp_path / "ledger.sqlite"
    _make_sqlite(db)
    rc = backup_cli.main([str(db)])
    assert rc == 0
    assert any((tmp_path / "backups").iterdir())


def test_backup_cli_missing_file(tmp_path: Path) -> None:
    rc = backup_cli.main([str(tmp_path / "absent.sqlite")])
    assert rc == 2


def test_backup_cli_verify_emits_manifest(tmp_path: Path) -> None:
    db = tmp_path / "ledger.sqlite"
    _make_sqlite(db)
    rc = backup_cli.main(["--verify", str(db)])
    assert rc == 0
    manifests = list((tmp_path / "backups").glob("*.manifest.json"))
    assert len(manifests) == 1
    data = json.loads(manifests[0].read_text())
    assert data["counts"] == {"t": 1}


def test_split_db_encrypt_without_driver_fails_cleanly(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from investment_dashboard.storage.encryption import EncryptionUnavailableError

    src = tmp_path / "source.sqlite"
    _make_sqlite(src)
    # Force the importlib lookup to fail.
    monkeypatch.setattr(
        "investment_dashboard.tools.split_db._encrypt_inplace",
        lambda *_a, **_k: (_ for _ in ()).throw(EncryptionUnavailableError("driver missing")),
    )
    with pytest.raises(EncryptionUnavailableError):
        split_db_mod.split_db(
            src,
            ledger=tmp_path / "out" / "ledger.sqlite",
            config=tmp_path / "out" / "config.sqlite",
            cache=tmp_path / "out" / "cache.sqlite",
            encrypt_ledger=True,
            passphrase="hunter2",
        )


def test_split_db_encrypt_requires_passphrase(tmp_path: Path) -> None:
    src = tmp_path / "source.sqlite"
    _make_sqlite(src)
    with pytest.raises(split_db_mod.SplitDbError):
        split_db_mod.split_db(
            src,
            ledger=tmp_path / "out" / "ledger.sqlite",
            config=tmp_path / "out" / "config.sqlite",
            cache=tmp_path / "out" / "cache.sqlite",
            encrypt_ledger=True,
            passphrase=None,
        )


def test_resolve_passphrase_prefers_cli_value_with_warning(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.delenv(ENV_VAR, raising=False)
    # Another test may have run dictConfig(disable_existing_loggers=True), which
    # disables this module's logger and would swallow the warning. Re-enable it
    # so the assertion is order-independent.
    logging.getLogger("investment_dashboard.tools._passphrase").disabled = False
    with caplog.at_level("WARNING"):
        assert resolve_passphrase("hunter2") == "hunter2"
    assert any("--passphrase" in r.getMessage() for r in caplog.records)


def test_resolve_passphrase_falls_back_to_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ENV_VAR, "from-env")
    assert resolve_passphrase(None) == "from-env"


def test_resolve_passphrase_none_when_non_interactive(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(ENV_VAR, raising=False)
    # allow_prompt=False mirrors a non-TTY run; no flag and no env var → None.
    assert resolve_passphrase(None, allow_prompt=False) is None


def test_resolve_passphrase_prompts_when_interactive(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(ENV_VAR, raising=False)
    monkeypatch.setattr("investment_dashboard.tools._passphrase.sys.stdin.isatty", lambda: True)
    monkeypatch.setattr(
        "investment_dashboard.tools._passphrase.getpass.getpass", lambda _prompt: "typed-secret"
    )
    assert resolve_passphrase(None) == "typed-secret"
