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
