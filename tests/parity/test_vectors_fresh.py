"""Committed parity vectors must match the current Python return functions."""

from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOL_PATH = ROOT / "tools" / "gen_parity_vectors.py"
spec = importlib.util.spec_from_file_location("gen_parity_vectors", TOOL_PATH)
assert spec is not None
gen_parity_vectors = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(gen_parity_vectors)


def test_parity_vectors_are_fresh() -> None:
    assert Path(gen_parity_vectors.VECTORS_PATH).read_bytes() == gen_parity_vectors.render_vectors()
