"""``make_fixtures``: deterministic, fake-only, covers the nasty cases."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest


def _run(out: Path) -> None:
    result = subprocess.run(
        [sys.executable, "-m", "investment_dashboard.tools.make_fixtures", str(out)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr[-2000:]


@pytest.fixture(scope="module")
def runs(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, Path]:
    first = tmp_path_factory.mktemp("fixtures_a")
    second = tmp_path_factory.mktemp("fixtures_b")
    _run(first)
    _run(second)
    return first, second


def test_fixtures_regenerate_identically(runs: tuple[Path, Path]) -> None:
    first, second = runs
    for name in ("full.json", "empty.json"):
        assert (first / name).read_bytes() == (second / name).read_bytes()


def test_full_set_is_nasty_but_fake(runs: tuple[Path, Path]) -> None:
    data = json.loads((runs[0] / "full.json").read_text(encoding="utf-8"))
    assert data["GET /api/auth/me"]["authenticated"] is True
    holdings = data["GET /api/holdings/both"]["USD"]["holdings"]
    symbols = {h["symbol"] for h in holdings}
    assert symbols >= {"FAKEL", "FAKENX", "FAKEU.DE"}
    assert all(s.startswith("FAKE") for s in symbols)
    assert max(len(h["name"]) for h in holdings) > 100
    assert float(data["GET /api/overview/both"]["USD"]["kpis"]["total_value"]) > 1_000_000
    assert any(h["native_currency"] == "EUR" for h in holdings)
    assert not any("\\Users\\" in json.dumps(v) for v in data.values())


def test_empty_set_has_no_holdings(runs: tuple[Path, Path]) -> None:
    data = json.loads((runs[0] / "empty.json").read_text(encoding="utf-8"))
    assert data["GET /api/holdings/both"]["USD"]["holdings"] == []


def test_provider_state_is_pinned(runs: tuple[Path, Path]) -> None:
    data = json.loads((runs[0] / "full.json").read_text(encoding="utf-8"))
    usage = data["GET /api/maintenance/tiingo"]
    assert usage["configured"] is False
    assert (usage["hour_used"], usage["day_used"]) == (3, 41)
    assert usage["rate_limited_at"] is None
    assert usage["last_status"] == "ok"
    assert usage["last_at"].startswith("2026-06-30T20:30:00")


def test_generator_opens_no_socket_and_is_repeatable_in_one_process(tmp_path: Path) -> None:
    import socket

    from investment_dashboard.tools import make_fixtures as mf

    # The guard itself: a name lookup and a connection to a public host are refused and logged.
    mf.NETWORK_ATTEMPTS.clear()
    with mf._no_network():
        with pytest.raises(OSError, match="hermetic"):
            socket.create_connection(("example.invalid", 80), timeout=1)
        with pytest.raises(OSError, match="hermetic"):
            socket.getaddrinfo("example.invalid", 80)
    assert len(mf.NETWORK_ATTEMPTS) == 2

    # Two builds in this process, each with a fresh database: no network, identical bytes.
    renders = []
    for n in (1, 2):
        work = tmp_path / f"run{n}"
        work.mkdir()
        renders.append(mf.render(mf._build("full", work)))
        assert mf.NETWORK_ATTEMPTS == []
    assert renders[0] == renders[1]
