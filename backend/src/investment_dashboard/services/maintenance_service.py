"""In-app repair jobs: the catalogue the Health & Repair page renders and runs.

Each :class:`JobSpec` wraps an existing service function (no new maths). Jobs run
through :mod:`job_runner` (single flight, shared heavy mutex). Danger levels are
enforced here, server side:

* ``none``    — runs straight away;
* ``confirm`` — the request must carry ``confirm="yes"`` (the UI asks first);
* ``typed``   — the request must carry the job's ``confirm_word`` (e.g. ``RESET``).

Destructive jobs (``backup_first``) take a sealed snapshot first and report its
name. Factory reset and "delete all transactions" are deliberately not offered
in the hosted app (CLI only).

The API also requires a cookie session (not the API token) for every job, and
a fresh session for typed jobs once ``security.require_fresh_session`` exists.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any, Literal

from investment_dashboard.errors import NotFoundError, ValidationError
from investment_dashboard.services import job_runner

log = logging.getLogger(__name__)

Danger = Literal["none", "confirm", "typed"]
ParamType = Literal["bool", "int", "date", "enum", "string"]
CONFIRM_YES = "yes"


class JobParamsError(ValidationError):
    """Bad job parameters or a missing confirmation -> 422 (``errors`` per field)."""

    def __init__(self, errors: dict[str, str]) -> None:
        super().__init__("; ".join(f"{k}: {v}" for k, v in errors.items()))
        self.errors = errors


@dataclass(frozen=True)
class ParamSpec:
    name: str
    type: ParamType
    label: str
    required: bool = False
    default: Any = None
    choices: tuple[str, ...] = ()
    help: str = ""


@dataclass(frozen=True)
class JobSpec:
    id: str
    label: str
    group: str
    description: str
    run: Callable[[dict[str, Any]], dict[str, Any] | None]
    danger: Danger = "none"
    confirm_word: str | None = None
    heavy: bool = False
    backup_first: bool = False
    params: tuple[ParamSpec, ...] = field(default_factory=tuple)


GROUPS: dict[str, str] = {
    "prices": "Prices",
    "fx": "FX",
    "graphs": "Graphs & history",
    "cache": "Cache",
    "providers": "Providers",
    "backups": "Backups & database",
}


# -- job bodies (thin wrappers) ----------------------------------------------------


def _refresh_prices(params: dict[str, Any]) -> dict[str, Any]:
    from investment_dashboard.services import auto_refresh  # noqa: PLC0415

    ok = auto_refresh.tick_refresh("Repair: refresh prices", force=bool(params.get("force")))
    return {"refreshed": ok}


def _redownload_prices(params: dict[str, Any]) -> dict[str, Any]:
    from investment_dashboard import boot  # noqa: PLC0415
    from investment_dashboard.db import ledger_session_scope  # noqa: PLC0415
    from investment_dashboard.repositories import instruments_repo  # noqa: PLC0415
    from investment_dashboard.services import prices_service, snapshots_service  # noqa: PLC0415

    iid = int(params["instrument_id"])
    with ledger_session_scope() as session:
        if instruments_repo.get_instrument(session, iid) is None:
            raise NotFoundError(f"instrument {iid} not found")
        removed = prices_service.invalidate_instrument_prices(session, iid, keep_manual=True)
    boot._refresh_prices()
    boot._refresh_splits()
    with ledger_session_scope() as session:
        snapshots_service.invalidate_all(session)
    boot._warm_snapshots()
    return {"removed_rows": removed}


def _boot_step(step: str) -> Callable[[dict[str, Any]], dict[str, Any] | None]:
    def run(_params: dict[str, Any]) -> dict[str, Any] | None:
        from investment_dashboard import boot  # noqa: PLC0415

        getattr(boot, step)()  # each step catches and logs its own failure
        return None

    return run


def _recalc_legs(params: dict[str, Any]) -> dict[str, Any]:
    from investment_dashboard.db import ledger_session_scope  # noqa: PLC0415
    from investment_dashboard.services import transaction_fx_service  # noqa: PLC0415

    with ledger_session_scope() as session:
        res = transaction_fx_service.backfill_missing_legs(session, force=bool(params.get("force")))
    return {"examined": res.examined, "updated": res.updated, "incomplete": res.incomplete}


def _refresh_live_fx_job(_params: dict[str, Any]) -> dict[str, Any]:
    from investment_dashboard.db import ledger_session_scope  # noqa: PLC0415
    from investment_dashboard.services import fx_service  # noqa: PLC0415

    with ledger_session_scope() as session:
        rate = fx_service.backfill_live_spot(session)
        info = fx_service.eur_quote_as_of(session)
    return {
        "rate": None if rate is None else format(rate, "f"),
        "source": None if info is None else info.source,
        "as_of": None if info is None else info.as_of.isoformat(),
        "observed_at": (
            info.observed_at.isoformat()
            if info is not None and info.observed_at is not None
            else None
        ),
    }


def _backfill_intraday_fx_job(_params: dict[str, Any]) -> dict[str, Any]:
    from investment_dashboard.db import ledger_session_scope  # noqa: PLC0415
    from investment_dashboard.services import fx_service  # noqa: PLC0415
    from investment_dashboard.services import intraday_snapshots_service as iss  # noqa: PLC0415

    with ledger_session_scope() as session:
        rate = fx_service.backfill_live_spot(session)
        graphs = dict(iss.reload_graphs(session))
    return {
        "live_rate": None if rate is None else format(rate, "f"),
        **graphs,
    }


def _rebuild_snapshots(params: dict[str, Any]) -> dict[str, Any]:
    from investment_dashboard import boot  # noqa: PLC0415
    from investment_dashboard.db import ledger_session_scope  # noqa: PLC0415
    from investment_dashboard.services import snapshots_service  # noqa: PLC0415

    start: date | None = params.get("from")
    with ledger_session_scope() as session:
        if start is None:
            removed = snapshots_service.invalidate_all(session)
        else:
            removed = snapshots_service.invalidate_from(session, start)
    boot._warm_snapshots()
    return {"invalidated": removed}


def _reload_graphs(params: dict[str, Any]) -> dict[str, Any]:
    from investment_dashboard.db import ledger_session_scope  # noqa: PLC0415
    from investment_dashboard.services import intraday_snapshots_service as iss  # noqa: PLC0415

    which = params.get("which") or "all"
    with ledger_session_scope() as session:
        if which == "day":
            return {"day_points": iss.reload_day_graph(session)}
        if which == "week":
            return {"week_points": iss.reload_week_graph(session)}
        return dict(iss.reload_graphs(session))


def _clear_intraday(params: dict[str, Any]) -> dict[str, Any]:
    from investment_dashboard.db import ledger_session_scope  # noqa: PLC0415
    from investment_dashboard.services import intraday_snapshots_service as iss  # noqa: PLC0415

    which = params.get("which") or "day"
    with ledger_session_scope() as session:
        if which == "week":
            return {"deleted": iss.clear_week_samples(session)}
        return {"deleted": iss.clear_day_samples(session)}


def _reset_cache(_params: dict[str, Any]) -> dict[str, Any]:
    from investment_dashboard import boot  # noqa: PLC0415
    from investment_dashboard.services import database_reset_service as reset  # noqa: PLC0415

    result = reset.reset_database(reset.ResetLevel.CACHE)
    boot.start_full_history_refresh("Repair: reset cached market data", force_progress=True)
    return {"deleted_rows": result.total_deleted}


def _refresh_risk_free(_params: dict[str, Any]) -> dict[str, Any]:
    from investment_dashboard.db import config_session_scope  # noqa: PLC0415
    from investment_dashboard.services import risk_free_service  # noqa: PLC0415

    with config_session_scope() as session:
        snap = risk_free_service.refresh(session)
    return {"rate": None if snap.rate is None else format(snap.rate, "f")}


def _reset_tiingo_state(_params: dict[str, Any]) -> dict[str, Any]:
    from investment_dashboard.db import ledger_session_scope  # noqa: PLC0415
    from investment_dashboard.repositories.tiingo_state_repo import STATE_KEY  # noqa: PLC0415
    from investment_dashboard.services import app_config_service  # noqa: PLC0415

    # The counters live in the ledger tier, where every Tiingo call charges them
    # (this job used to clear the config tier, so the reset changed nothing).
    with ledger_session_scope() as session:
        removed = app_config_service.delete_key(session, STATE_KEY)
    return {"cleared": removed}


def _tiingo_fill_gaps(_params: dict[str, Any]) -> dict[str, Any]:
    from investment_dashboard.db import ledger_session_scope  # noqa: PLC0415
    from investment_dashboard.services import intraday_snapshots_service as iss  # noqa: PLC0415

    with ledger_session_scope() as session:
        # A TiingoGapFillError (no token / not enough budget) fails the run with
        # its plain message, shown on the Repair page.
        return dict(iss.fill_gaps_from_tiingo(session))


def _tiingo_refresh_prices(_params: dict[str, Any]) -> dict[str, Any]:
    from investment_dashboard.db import cache_session_scope, ledger_session_scope  # noqa: PLC0415
    from investment_dashboard.services import prices_service  # noqa: PLC0415

    # No token raises TiingoNotConfiguredError: the run fails with that message.
    with ledger_session_scope() as session, cache_session_scope() as cache:
        rows, switched = prices_service.refresh_via_tiingo(session, cache)
    return {"rows_written": sum(rows.values()), "used_tiingo": switched}


def _twins_refresh(_params: dict[str, Any]) -> dict[str, Any]:
    from investment_dashboard.db import ledger_session_scope  # noqa: PLC0415
    from investment_dashboard.services import intraday_snapshots_service as iss  # noqa: PLC0415

    with ledger_session_scope() as session:
        written = iss.refresh_twin_prices(session)
    return {"rows_written": written}


def _twins_backfill(_params: dict[str, Any]) -> dict[str, Any]:
    from investment_dashboard.db import ledger_session_scope  # noqa: PLC0415
    from investment_dashboard.services import intraday_snapshots_service as iss  # noqa: PLC0415

    with ledger_session_scope() as session:
        result = iss.force_twin_year_backfill(session)
    return result


def _twins_clear(_params: dict[str, Any]) -> dict[str, Any]:
    from investment_dashboard.db import ledger_session_scope  # noqa: PLC0415
    from investment_dashboard.services import intraday_snapshots_service as iss  # noqa: PLC0415

    with ledger_session_scope() as session:
        deleted = iss.clear_twin_prices(session)
    return {"deleted": deleted}


def _backup_now(_params: dict[str, Any]) -> dict[str, Any]:
    from investment_dashboard.services import backup_service  # noqa: PLC0415

    return {"snapshot": backup_service.create_snapshot().name}


def _verify_backup(params: dict[str, Any]) -> dict[str, Any]:
    from investment_dashboard.services import backup_service  # noqa: PLC0415

    return backup_service.verify_snapshot(str(params["name"]))


def _integrity(_params: dict[str, Any]) -> dict[str, Any]:
    from investment_dashboard.services import system_service  # noqa: PLC0415

    return system_service.integrity()


_WHICH = ("day", "week", "all")

JOBS: tuple[JobSpec, ...] = (
    JobSpec(
        "prices.refresh",
        "Refresh prices now",
        "prices",
        "Fetch the latest prices for every holding.",
        _refresh_prices,
        heavy=True,
        params=(ParamSpec("force", "bool", "Ignore the cache age", default=True),),
    ),
    JobSpec(
        "prices.redownload",
        "Re-download one instrument's prices",
        "prices",
        "Drops the cached closes and splits of one instrument (manual fixes stay) and "
        "downloads them again, then rebuilds the valuation history.",
        _redownload_prices,
        danger="confirm",
        heavy=True,
        params=(ParamSpec("instrument_id", "int", "Instrument", required=True),),
    ),
    JobSpec(
        "splits.refresh",
        "Re-fetch splits",
        "prices",
        "Download stock splits for every instrument again.",
        _boot_step("_refresh_splits"),
        heavy=True,
    ),
    JobSpec(
        "fx.refresh_live",
        "Refresh live FX rate now",
        "fx",
        "Fetch the current EUR/USD market rate (or backfill the last forex session's closing "
        "rate when the currency market is closed) from Yahoo Finance / Tiingo so today's "
        "figures do not rely on the ECB end-of-day reference rate.",
        _refresh_live_fx_job,
    ),
    JobSpec(
        "fx.backfill_intraday",
        "Backfill intraday FX rates (1D / 1W)",
        "fx",
        "Re-download the 5-minute EUR/USD bars for the last session and trailing week "
        "(Yahoo Finance primary, Tiingo backup), warm the live/closing FX spot, and reload "
        "the 1D and 1W currency-converted curves.",
        _backfill_intraday_fx_job,
        heavy=True,
    ),
    JobSpec(
        "fx.refresh",
        "Re-download FX history",
        "fx",
        "Fill gaps in the daily EUR rates from the ECB reference rates.",
        _boot_step("_refresh_fx"),
        heavy=True,
    ),
    JobSpec(
        "fx.recalc_legs",
        "Recalculate FX legs",
        "fx",
        "Recompute the stored EUR/USD legs of transactions from the FX history.",
        _recalc_legs,
        danger="confirm",
        heavy=True,
        params=(ParamSpec("force", "bool", "Recompute every row, not only missing ones"),),
    ),
    JobSpec(
        "snapshots.rebuild",
        "Rebuild valuation history",
        "graphs",
        "Recompute the daily portfolio values (from a date, or all).",
        _rebuild_snapshots,
        heavy=True,
        params=(ParamSpec("from", "date", "From date (empty = everything)"),),
    ),
    JobSpec(
        "graphs.reload",
        "Reload 1D / 1W graphs",
        "graphs",
        "Rebuild the intraday graphs from the price provider.",
        _reload_graphs,
        heavy=True,
        params=(ParamSpec("which", "enum", "Which graph", default="all", choices=_WHICH),),
    ),
    JobSpec(
        "graphs.clear_intraday",
        "Clear intraday samples",
        "graphs",
        "Delete the stored 1D or 1W samples; they refill during the next session.",
        _clear_intraday,
        danger="confirm",
        heavy=True,
        params=(ParamSpec("which", "enum", "Which graph", default="day", choices=("day", "week")),),
    ),
    JobSpec(
        "cache.janitor",
        "Clean up cache",
        "cache",
        "Remove cached prices of instruments no longer in the ledger.",
        _boot_step("_run_cache_janitor"),
    ),
    JobSpec(
        "cache.reset",
        "Reset cached market data",
        "cache",
        "Deletes all prices, FX rates, snapshots and graph samples, then downloads them "
        "again. Transactions and settings stay. A backup is taken first.",
        _reset_cache,
        danger="typed",
        confirm_word="RESET",
        heavy=True,
        backup_first=True,
    ),
    JobSpec(
        "benchmark.refresh",
        "Refresh benchmark",
        "providers",
        "Download the benchmark's price history again.",
        _boot_step("_refresh_benchmark"),
    ),
    JobSpec(
        "risk_free.refresh",
        "Refresh risk-free rate",
        "providers",
        "Fetch the current risk-free rate.",
        _refresh_risk_free,
    ),
    JobSpec(
        "tiingo.fill_graph_gaps",
        "Fill graph gaps from Tiingo",
        "providers",
        "Fill holes in the 1 Day / 1 Week graphs where yfinance has no bars, from "
        "Tiingo's 5-minute prices. Costs one Tiingo request per held stock/ETF plus one "
        "for EUR/USD; refuses if the hourly/daily allowance can't cover it. Your own "
        "live points are never replaced.",
        _tiingo_fill_gaps,
    ),
    JobSpec(
        "tiingo.refresh_prices",
        "Re-pull prices from Tiingo",
        "providers",
        "Ask Tiingo for every holding whose price is behind (skips the ones already "
        "current, so it only spends requests where Tiingo can add something).",
        _tiingo_refresh_prices,
    ),
    JobSpec(
        "tiingo.reset_state",
        "Reset Tiingo budget state",
        "providers",
        "Forget the Tiingo request counters and learned NAV timings (caps stay).",
        _reset_tiingo_state,
        danger="confirm",
    ),
    JobSpec(
        "twins.refresh",
        "Refresh ETF twin prices now",
        "providers",
        "Fetch the twins' prices for the current/last session (previous close and the "
        "price now while the market is open), backfill any missing earlier-week bars, "
        "and top up the one-year close history the twin-accuracy figures read.",
        _twins_refresh,
        heavy=True,
    ),
    JobSpec(
        "twins.backfill",
        "Re-download ETF twin history",
        "providers",
        "Force the one-year daily-close backfill to run again for every twin currently "
        "held, even one already done or given up on after repeated failures — use this "
        "after fixing a twin mapping, or to fill a gap downtime left in the history.",
        _twins_backfill,
        heavy=True,
    ),
    JobSpec(
        "twins.clear",
        "Clear stored twin prices",
        "cache",
        "Delete every stored ETF-twin price (intraday bars and session closes) and "
        "reset its backfill markers; the next refresh fills them in again. Use this to "
        "reset a bad twin mapping.",
        _twins_clear,
        danger="confirm",
        heavy=True,
    ),
    JobSpec(
        "backup.now",
        "Back up now",
        "backups",
        "Write a sealed snapshot of the database.",
        _backup_now,
    ),
    JobSpec(
        "backup.verify",
        "Verify a backup",
        "backups",
        "Unseal a snapshot in a temporary folder and run an integrity check.",
        _verify_backup,
        params=(ParamSpec("name", "string", "Snapshot file", required=True),),
    ),
    JobSpec(
        "db.integrity_check",
        "Run integrity check",
        "backups",
        "SQLite integrity check of the live database.",
        _integrity,
    ),
)

BY_ID: dict[str, JobSpec] = {j.id: j for j in JOBS}


def get_spec(job_id: str) -> JobSpec:
    spec = BY_ID.get(job_id)
    if spec is None:
        raise NotFoundError(f"unknown job {job_id!r}")
    return spec


# -- validation --------------------------------------------------------------------


def _param(p: ParamSpec, raw: Any) -> Any:
    if p.type == "bool":
        if isinstance(raw, bool):
            return raw
        raise ValueError("expected true or false")
    if p.type == "int":
        if isinstance(raw, bool) or not isinstance(raw, int | str):
            raise ValueError("expected a whole number")
        return int(raw)
    if p.type == "date":
        if not isinstance(raw, str):
            raise ValueError("expected a date (YYYY-MM-DD)")
        return date.fromisoformat(raw)
    if p.type == "enum":
        if raw not in p.choices:
            raise ValueError(f"must be one of {', '.join(p.choices)}")
        return raw
    if not isinstance(raw, str) or not raw.strip() or len(raw) > 200:
        raise ValueError("expected text")
    return raw.strip()


def validate_params(spec: JobSpec, raw: dict[str, Any] | None) -> dict[str, Any]:
    raw = dict(raw or {})
    errors: dict[str, str] = {}
    out: dict[str, Any] = {}
    known = {p.name for p in spec.params}
    for name in raw:
        if name not in known:
            errors[name] = "unknown parameter"
    for p in spec.params:
        value = raw.get(p.name)
        if value is None or value == "":
            if p.required:
                errors[p.name] = "required"
            elif p.default is not None:
                out[p.name] = p.default
            continue
        try:
            out[p.name] = _param(p, value)
        except ValueError as exc:
            errors[p.name] = str(exc)
    if errors:
        raise JobParamsError(errors)
    return out


def check_confirm(spec: JobSpec, confirm: str | None) -> None:
    if spec.danger == "typed" and (confirm or "").strip() != spec.confirm_word:
        raise JobParamsError({"confirm": f"type {spec.confirm_word} to confirm"})
    if spec.danger == "confirm" and (confirm or "").strip().lower() != CONFIRM_YES:
        raise JobParamsError({"confirm": "this action needs confirmation"})


# -- running -----------------------------------------------------------------------


def _with_backup(
    spec: JobSpec,
) -> Callable[[dict[str, Any]], dict[str, Any] | None]:
    if not spec.backup_first:
        return spec.run

    def run(params: dict[str, Any]) -> dict[str, Any] | None:
        from investment_dashboard.services import backup_service  # noqa: PLC0415

        backup: str | None = None
        if backup_service.is_configured():
            backup = backup_service.create_snapshot().name  # failure aborts the job
        else:
            log.warning("%s: backups are not configured; running without one", spec.id)
        result = dict(spec.run(params) or {})
        result["backup"] = backup
        return result

    return run


def start_job(
    job_id: str,
    params: dict[str, Any] | None,
    *,
    confirm: str | None,
    actor: str,
    wait: bool = False,
) -> job_runner.Run:
    """Validate and start a catalogue job (raises 404/409/422 domain errors)."""
    spec = get_spec(job_id)
    typed = validate_params(spec, params)
    check_confirm(spec, confirm)
    stored = {k: v.isoformat() if isinstance(v, date) else v for k, v in typed.items()}

    def body(_stored: dict[str, Any]) -> dict[str, Any] | None:
        return _with_backup(spec)(typed)

    return job_runner.start(spec.id, body, stored, actor=actor, heavy=spec.heavy, wait=wait)


def catalogue() -> dict[str, Any]:
    """Jobs with their param schema and last stored result."""
    last = job_runner.last_stored_all([j.id for j in JOBS])
    return {
        "groups": [{"id": k, "label": v} for k, v in GROUPS.items()],
        "jobs": [
            {
                "id": j.id,
                "label": j.label,
                "group": j.group,
                "description": j.description,
                "danger": j.danger,
                "confirm_word": j.confirm_word if j.danger == "typed" else None,
                "heavy": j.heavy,
                "backup_first": j.backup_first,
                "params": [
                    {
                        "name": p.name,
                        "type": p.type,
                        "label": p.label,
                        "required": p.required,
                        "default": p.default,
                        "choices": list(p.choices),
                        "help": p.help,
                    }
                    for p in j.params
                ],
                "running": bool(job_runner.running(j.id)),
                "last_run": last.get(j.id),
            }
            for j in JOBS
        ],
        "recent": [job_runner.run_view(r) for r in job_runner.recent()],
        "heavy_job": job_runner.heavy_busy(),
        "generated_at": datetime.now(UTC).isoformat(),
    }
