"""Golden tests for the pure mapping in ``scripts/test_changed.py``."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "test_changed.py"
spec = importlib.util.spec_from_file_location("test_changed_script", SCRIPT)
assert spec is not None
assert spec.loader is not None
mod = importlib.util.module_from_spec(spec)
sys.modules["test_changed_script"] = mod
spec.loader.exec_module(mod)

P = "backend/src/investment_dashboard/"
TESTS = [
    "backend/tests/readmodels/test_overview.py",
    "backend/tests/readmodels/test_overview_query.py",
    "backend/tests/services/test_fx_service.py",
    "backend/tests/api/test_currency.py",
]
EXISTING = set(TESTS) | {"backend/tests/adapters/yahoo"}


def run(*files: str, base: str = "main") -> object:
    return mod.plan(files, base=base, exists=lambda p: p in EXISTING, tests=TESTS)


def cmds(result: object) -> list[str]:
    return [str(c) for c in result.commands]  # type: ignore[attr-defined]


def test_domain_maps_to_domain_tests() -> None:
    assert cmds(run(P + "domain/xirr.py")) == ["(cd backend && uv run pytest tests/domain)"]


def test_readmodel_and_service_match_by_module_name() -> None:
    got = cmds(run(P + "readmodels/overview.py", P + "services/fx_service.py"))
    assert got == [
        "(cd backend && uv run pytest tests/readmodels/test_overview.py "
        "tests/readmodels/test_overview_query.py tests/services/test_fx_service.py)"
    ]


def test_unmatched_module_falls_back_to_folder() -> None:
    assert cmds(run(P + "services/brand_new.py")) == [
        "(cd backend && uv run pytest tests/services)"
    ]


def test_api_maps_to_its_test_and_notes_contract() -> None:
    result = run(P + "api/currency.py")
    assert cmds(result) == ["(cd backend && uv run pytest tests/api/test_currency.py)"]
    assert any("openapi" in n for n in result.notes)  # type: ignore[attr-defined]


def test_models_run_the_migration_tests() -> None:
    assert cmds(run(P + "models/ledger.py")) == [
        "(cd backend && uv run pytest tests/test_migration_roundtrip.py "
        "tests/test_added_columns_guard.py)"
    ]


def test_frontend_uses_vitest_changed_and_typecheck() -> None:
    assert cmds(run("frontend/src/pages/Overview/Overview.tsx", base="origin/main")) == [
        "(cd frontend && npm run typecheck)",
        "(cd frontend && npx vitest run --changed origin/main)",
    ]


def test_web_runs_typecheck_and_tests() -> None:
    assert cmds(run("web/src/compute.ts")) == [
        "(cd web && npm run typecheck)",
        "(cd web && npm run test)",
    ]


def test_docs_only_changes_need_nothing() -> None:
    assert cmds(run("AGENTS.md", "CHANGELOG.md")) == []


def test_changed_test_file_runs_itself_beside_other_targets() -> None:
    got = cmds(run("backend/tests/api/test_currency.py", P + "domain/clock.py"))
    assert got == ["(cd backend && uv run pytest tests/domain tests/api/test_currency.py)"]
