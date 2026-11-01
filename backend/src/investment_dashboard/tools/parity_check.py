"""Parity check: does v6 give the same numbers as the v5.3.1 desktop app?

Three steps, all read-only on the real ledger. Run them from ``backend/``::

    # 1. copy the live ledger (SQLite backup API; the desktop app may be open)
    uv run python -m investment_dashboard.tools.parity_check snapshot-ledger \\
        --src <v5 data dir> --out <scratch>/copy

    # 2a. dump the key numbers with the v6 code ...
    uv run python -m investment_dashboard.tools.parity_check dump \\
        --ledger <scratch>/copy --out <scratch>/v6.json --as-of 2026-11-01

    # 2b. ... and with the v5 code: run this same file from a v5 checkout's
    #     environment (its ``investment_dashboard`` package is the one imported)
    cd <v5 checkout> && uv run python \\
        <repo>/backend/src/investment_dashboard/tools/parity_check.py dump \\
        --ledger <scratch>/copy --out <scratch>/v5.json --as-of 2026-11-01

    # 3. compare
    uv run python -m investment_dashboard.tools.parity_check compare \\
        <scratch>/v5.json <scratch>/v6.json --out <scratch>/report.md

The module imports nothing from ``investment_dashboard`` at import time, and
``dump`` uses only functions that exist in both versions (a fallback import maps
v6 ``readmodels.queries.X`` to v5 ``ui.pages._X``). The copies must be plain
(unencrypted) SQLite. Outputs are refused inside the git repository: they hold
real account data.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import sys
import tempfile
from collections.abc import Iterator
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

MONEY_TOL = Decimal("0.01")
RATIO_TOL = Decimal("0.000001")
_TIER_FILES = ("ledger.sqlite", "config.sqlite")
_OPTIONAL_FILES = ("cache.sqlite",)  # prices and FX; without them nothing can be valued
_RATIO_WORDS = ("xirr", "twr", "growth", "pct", "return", "shares")
_CURRENCIES = ("EUR", "USD")


class ParityError(RuntimeError):
    """A usage or safety problem (bad path, output inside the repo, missing file)."""


# --------------------------------------------------------------------------- safety


def _repo_roots() -> list[Path]:
    roots: list[Path] = []
    for start in (Path(__file__).resolve(), Path.cwd().resolve()):
        for parent in (start, *start.parents):
            if (parent / ".git").exists():
                roots.append(parent)
                break
    return roots


def _refuse_inside_repo(path: Path) -> None:
    target = path.resolve()
    for root in _repo_roots():
        if target == root or root in target.parents:
            raise ParityError(f"refusing to write inside the repository ({root}): {path}")


# --------------------------------------------------------------------------- snapshot


def snapshot_ledger(src: Path, out: Path) -> list[Path]:
    """Copy ledger/config (+ cache when present) from ``src`` into ``out``."""
    _refuse_inside_repo(out)
    for name in _TIER_FILES:
        if not (src / name).is_file():
            raise ParityError(f"{name} not found in {src}")
    out.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for name in (*_TIER_FILES, *_OPTIONAL_FILES):
        source = src / name
        if not source.is_file():
            continue
        dest = out / name
        if dest.exists():
            raise ParityError(f"refusing to overwrite {dest}")
        s = sqlite3.connect(f"file:{source.as_posix()}?mode=ro", uri=True)
        d = sqlite3.connect(dest)
        try:
            s.backup(d)
            res = d.execute("PRAGMA integrity_check").fetchone()
        except sqlite3.DatabaseError as exc:
            raise ParityError(f"{name} cannot be read as plain SQLite: {exc}") from exc
        finally:
            d.close()
            s.close()
        if not res or res[0] != "ok":
            raise ParityError(f"integrity_check failed on the copy of {name}: {res!r}")
        written.append(dest)
    return written


# --------------------------------------------------------------------------- dump


def _ser(value: Any) -> Any:
    if value is None or isinstance(value, bool | str):
        return value
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, int | float):
        return format(Decimal(str(value)), "f")
    return str(value)


def _pick(obj: Any, *names: str) -> Any:
    for name in names:
        if hasattr(obj, name):
            return _ser(getattr(obj, name))
    return None


def _guard(fn: Any) -> Any:
    try:
        return fn()
    except Exception as exc:  # recorded, so a failure on one side shows up as a difference
        return {"error": f"{type(exc).__name__}: {exc}"}


def _import_queries() -> tuple[Any, Any, Any]:
    try:
        from investment_dashboard.readmodels.queries import (  # noqa: PLC0415
            analytics_query,
            deposits_query,
            period_query,
        )
    except ImportError:  # v5.3.1 layout
        from investment_dashboard.ui.pages import (  # type: ignore[attr-defined,no-redef]  # noqa: PLC0415
            _analytics_query as analytics_query,
        )
        from investment_dashboard.ui.pages import (  # type: ignore[attr-defined,no-redef]  # noqa: PLC0415
            _deposits_query as deposits_query,
        )
        from investment_dashboard.ui.pages import (  # type: ignore[attr-defined,no-redef]  # noqa: PLC0415
            _period_query as period_query,
        )
    return analytics_query, deposits_query, period_query


def _totals(m: Any, cur: str) -> dict[str, Any]:
    suffix = "eur" if cur == "EUR" else "usd"
    return {
        "value": _pick(m, f"total_value_{suffix}"),
        "invested": _pick(m, f"total_contributions_{suffix}"),
        "gain": _pick(m, f"capital_gain_{suffix}"),
        "dividends": _pick(m, f"total_dividends_cash_{suffix}"),
    }


def _returns(m: Any, bundle: Any, cur: str) -> dict[str, Any]:
    sfx = "" if cur == "EUR" else "_usd"
    out: dict[str, Any] = {
        "xirr": _pick(m, f"xirr{sfx}"),
        "ytd_xirr": _pick(m, f"ytd_xirr{sfx}"),
        "ytd_growth_pct": _pick(m, f"ytd_growth_pct{sfx}"),
        "mtd_growth_pct": _pick(m, f"mtd_growth_pct{sfx}"),
        "total_growth_compounded": _pick(
            m, "total_growth_compounded_eur" if cur == "EUR" else "total_growth_compounded_usd"
        ),
    }
    if isinstance(bundle, dict):
        out["analytics"] = bundle
    else:
        out["twr"] = _pick(bundle, "twr")
        out["analytics_xirr"] = _pick(bundle, "xirr")
    return out


def _instruments(positions: list[Any], cur: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for p in positions:
        key = f"{p.account.broker}/{p.account.account_label}:{p.instrument.symbol}"
        native = p.instrument.native_currency
        value_native = p.current_value_native
        row: dict[str, Any] = {
            "shares": _ser(p.shares),
            "native_currency": native,
            "value_native": _ser(value_native),
            "cost_native": _ser(p.cost_basis_native),
            "gain_native": _ser(value_native - p.cost_basis_native),
        }
        if cur == "EUR":
            row["value"] = _ser(p.current_value_eur)
        else:  # USD: only exact for USD-native holdings; never derived from EUR here
            row["value"] = _ser(value_native) if native == "USD" else None
        out[key] = row
    return out


def _periods(period_query: Any, session: Any, *, monthly: bool, cur: str, as_of: date) -> Any:
    rows = period_query.aggregate(
        session, monthly=monthly, today=as_of, display_currency=cur, with_closing_value=True
    )
    out: dict[str, Any] = {}
    for r in rows:
        if cur == "EUR":
            row = {
                "contributions": _pick(r, "contributions"),
                "dividends": _pick(r, "dividends"),
                "closing_value": _pick(r, "closing_value_eur"),
                "growth_pct": _pick(r, "growth_pct"),
                "total_growth_compounded": _pick(r, "total_growth_compounded_eur"),
                "yearly_growth": _pick(r, "yearly_growth_eur"),
            }
        else:
            row = {
                "contributions": _pick(r, "contributions_display"),
                "dividends": _pick(r, "dividends_display"),
                "closing_value": _pick(r, "closing_value_usd", "closing_value_display"),
                "growth_pct": _pick(r, "growth_pct_display"),
                "total_growth_compounded": _pick(r, "total_growth_compounded_usd"),
                "yearly_growth": _pick(r, "yearly_growth_usd"),
            }
        out[str(r.label)] = row
    return out


def _deposits(deposits_query: Any, session: Any, cur: str, as_of: date) -> dict[str, Any]:
    s = deposits_query.compute_summary(session, today=as_of)
    sfx = "eur" if cur == "EUR" else "usd"
    return {
        "total": _pick(s, f"total_contrib_{sfx}"),
        "ytd": _pick(s, f"ytd_contrib_{sfx}"),
        "mtd": _pick(s, f"mtd_contrib_{sfx}"),
    }


def build_dump(session: Any, as_of: date) -> dict[str, Any]:
    from investment_dashboard.services.metrics_service import (  # noqa: PLC0415
        compute_portfolio_metrics,
    )
    from investment_dashboard.services.positions_service import (  # noqa: PLC0415
        compute_positions,
    )

    analytics_query, deposits_query, period_query = _import_queries()
    metrics = _guard(lambda: compute_portfolio_metrics(session, as_of=as_of))
    positions = _guard(lambda: compute_positions(session, as_of=as_of))
    result: dict[str, Any] = {"as_of": as_of.isoformat(), "currencies": {}}
    for cur in _CURRENCIES:
        bundle = _guard(
            lambda cur=cur: analytics_query.build_bundle(
                session, currency=cur, lookback_days=365, as_of=as_of
            )
        )
        result["currencies"][cur] = {
            "totals": metrics
            if isinstance(metrics, dict)
            else _guard(lambda cur=cur: _totals(metrics, cur)),
            "returns": metrics
            if isinstance(metrics, dict)
            else _guard(lambda cur=cur, bundle=bundle: _returns(metrics, bundle, cur)),
            "instruments": positions
            if isinstance(positions, dict)
            else _guard(lambda cur=cur: _instruments(positions, cur)),
            "yearly": _guard(
                lambda cur=cur: _periods(period_query, session, monthly=False, cur=cur, as_of=as_of)
            ),
            "monthly": _guard(
                lambda cur=cur: _periods(period_query, session, monthly=True, cur=cur, as_of=as_of)
            ),
            "deposits": _guard(lambda cur=cur: _deposits(deposits_query, session, cur, as_of)),
        }
    return result


def run_dump(ledger_dir: Path, as_of: date) -> dict[str, Any]:
    """Open a snapshot folder (v5 tier layout) and return the canonical dump dict."""
    for name in _TIER_FILES:
        if not (ledger_dir / name).is_file():
            raise ParityError(f"{name} not found in {ledger_dir}")
    with tempfile.TemporaryDirectory(prefix="inv-parity-") as tmp_s:
        tmp = Path(tmp_s)  # work on a throwaway copy: the snapshot stays pristine
        for name in (*_TIER_FILES, *_OPTIONAL_FILES):
            if (ledger_dir / name).is_file():
                shutil.copy2(ledger_dir / name, tmp / name)
        paths = {k: tmp / f"{k}.sqlite" for k in ("ledger", "config", "cache")}
        try:  # v6 only (v5 has no such module): build the single-file DB the server uses
            from investment_dashboard.models.base import CacheBase, ConfigBase  # noqa: PLC0415
            from investment_dashboard.tools.upload_db import (  # noqa: PLC0415
                _merge_tier,
                _upgrade_head,
            )
        except ImportError:
            pass
        else:
            _upgrade_head(paths["ledger"])
            _merge_tier(paths["ledger"], paths["config"], ConfigBase.metadata)
            if paths["cache"].is_file():
                _merge_tier(paths["ledger"], paths["cache"], CacheBase.metadata)
            paths = dict.fromkeys(paths, paths["ledger"])

        env = {
            "INV_DASHBOARD_LEDGER_PATH": str(paths["ledger"]),
            "INV_DASHBOARD_CONFIG_PATH": str(paths["config"]),
            "INV_DASHBOARD_CACHE_PATH": str(paths["cache"]),
        }
        saved = {k: os.environ.get(k) for k in env}
        os.environ.update(env)
        from investment_dashboard import config as cfg  # noqa: PLC0415
        from investment_dashboard import db  # noqa: PLC0415

        cfg.get_settings.cache_clear()
        db.dispose_engines()
        try:
            with db.ledger_session_scope() as session:
                return build_dump(session, as_of)
        finally:
            db.dispose_engines()
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
            cfg.get_settings.cache_clear()


# --------------------------------------------------------------------------- compare


def _flatten(node: Any, prefix: str = "") -> Iterator[tuple[str, Any]]:
    if isinstance(node, dict):
        for key in sorted(node):
            yield from _flatten(node[key], f"{prefix}/{key}" if prefix else str(key))
    else:
        yield prefix, node


def _to_decimal(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return Decimal(str(value))
    except InvalidOperation:
        return None


def _is_ratio(path: str) -> bool:
    leaf = path.rsplit("/", 1)[-1].lower()
    return any(w in leaf for w in _RATIO_WORDS)


def _expected_reason(path: str) -> str | None:
    """Tag differences explained by a known v5.3.1 bug (docs/legacy_v5_known_bugs.md)."""
    parts = path.split("/")
    is_usd_returns = len(parts) >= 4 and parts[:3] == ["currencies", "USD", "returns"]
    if is_usd_returns and parts[3] in {"twr", "analytics_xirr"}:
        return "v5 bug 1: analytics USD figures are built from EUR cashflows"
    return None


def compare_dumps(a: dict[str, Any], b: dict[str, Any]) -> list[dict[str, Any]]:
    """Every difference between dump ``a`` (v5) and ``b`` (v6)."""
    fa, fb = dict(_flatten(a)), dict(_flatten(b))
    diffs: list[dict[str, Any]] = []
    for path in sorted(set(fa) | set(fb)):
        va, vb = fa.get(path), fb.get(path)
        if va == vb:
            continue
        da, db_ = _to_decimal(va), _to_decimal(vb)
        delta: Decimal | None = None
        if da is not None and db_ is not None:
            delta = db_ - da
            tol = RATIO_TOL if _is_ratio(path) else MONEY_TOL
            if abs(delta) <= tol:
                continue
        diffs.append(
            {"path": path, "a": va, "b": vb, "delta": delta, "expected": _expected_reason(path)}
        )
    return diffs


def render_report(diffs: list[dict[str, Any]], a_name: str, b_name: str) -> str:
    expected = [d for d in diffs if d["expected"]]
    unexplained = [d for d in diffs if not d["expected"]]

    def table(rows: list[dict[str, Any]], with_reason: bool) -> list[str]:
        head = f"| path | {a_name} | {b_name} | delta |" + (" reason |" if with_reason else "")
        lines = [head, "|" + " --- |" * (5 if with_reason else 4)]
        for d in rows:
            delta = "" if d["delta"] is None else format(d["delta"], "f")
            cells = [d["path"], str(d["a"]), str(d["b"]), delta]
            if with_reason:
                cells.append(d["expected"])
            lines.append("| " + " | ".join(cells) + " |")
        return lines

    out = [
        "# Parity report",
        "",
        f"Tolerance: {MONEY_TOL} for money, {RATIO_TOL} for ratios. "
        f"Left = `{a_name}`, right = `{b_name}`.",
        "",
        f"- Differences: {len(diffs)} ({len(unexplained)} unexplained, {len(expected)} expected)",
        "",
        "## Unexplained differences",
        "",
        *(table(unexplained, False) if unexplained else ["None."]),
        "",
        "## Expected differences (known v5 bugs)",
        "",
        *(table(expected, True) if expected else ["None."]),
        "",
        "Known v5 bugs 2 to 5 (missing EUR leg, missing FX, cross-account dividend "
        "reinvestment, local-date clock) cannot be told apart by path: check unexplained "
        "rows against `docs/legacy_v5_known_bugs.md` on branch `legacy/v5`.",
        "",
    ]
    return "\n".join(out)


# --------------------------------------------------------------------------- CLI


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="parity_check", description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("snapshot-ledger", help="copy the ledger/config files (read-only source)")
    s.add_argument("--src", type=Path, required=True, help="folder with ledger/config.sqlite")
    s.add_argument("--out", type=Path, required=True, help="folder for the copies (not in repo)")
    d = sub.add_parser("dump", help="write the canonical numbers as JSON")
    d.add_argument("--ledger", type=Path, required=True, help="folder made by snapshot-ledger")
    d.add_argument("--out", type=Path, required=True, help="JSON file (not in repo)")
    d.add_argument(
        "--as-of", type=date.fromisoformat, default=None, help="YYYY-MM-DD (default today)"
    )
    c = sub.add_parser("compare", help="diff two dumps (a = v5, b = v6)")
    c.add_argument("a", type=Path)
    c.add_argument("b", type=Path)
    c.add_argument("--out", type=Path, required=True, help="markdown report (not in repo)")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.cmd == "snapshot-ledger":
            written = snapshot_ledger(args.src, args.out)
            print(f"Copied {len(written)} file(s) to {args.out}")
        elif args.cmd == "dump":
            _refuse_inside_repo(args.out)
            result = run_dump(args.ledger, args.as_of or date.today())
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
            print(f"Wrote {args.out}")
        else:
            _refuse_inside_repo(args.out)
            a = json.loads(args.a.read_text(encoding="utf-8"))
            b = json.loads(args.b.read_text(encoding="utf-8"))
            diffs = compare_dumps(a, b)
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(render_report(diffs, args.a.stem, args.b.stem), encoding="utf-8")
            unexplained = sum(1 for d in diffs if not d["expected"])
            print(f"{len(diffs)} difference(s), {unexplained} unexplained -> {args.out}")
    except ParityError as exc:
        print(f"parity_check: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":  # pragma: no cover
    # Running this file directly would put tools/ first on sys.path; drop it so
    # the v5/v6 package being compared is the one imported.
    here = Path(__file__).resolve().parent
    sys.path[:] = [p for p in sys.path if Path(p or ".").resolve() != here]
    sys.exit(main())
