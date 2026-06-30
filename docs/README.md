# Documentation index

This folder holds the design notes, plans, audits, and reference material for the
Investment Dashboard. The authoritative record of *what shipped when* is always
the top-level [`CHANGELOG.md`](../CHANGELOG.md); the docs below capture the
**why** and the **how**.

> 💵 **Currency model:** USD is the canonical backend currency (computation,
> storage, reconciliation, exports are USD-native). EUR is a presentation-layer
> display toggle derived as `usd ÷ fx` — never a source of truth.

## Start here

- [`architecture.md`](architecture.md) — one-page distillation of the system
  design (layers, storage tiers, data flow).
- [`user_guide.md`](user_guide.md) — plain-English, control-by-control guide
  (the same content as the in-app Help page).
- [`../requirements_and_project_overview.md`](../requirements_and_project_overview.md)
  — the full specification the project is built from.

## Reference material (living docs)

These describe current behaviour and are kept up to date.

| Document | What it covers |
| --- | --- |
| [`architecture.md`](architecture.md) | System architecture overview. |
| [`user_guide.md`](user_guide.md) | End-user walkthrough of every page and setting. |
| [`mobile_export_schema.md`](mobile_export_schema.md) | The JSON contract emitted to the live-web/mobile companion. |
| [`spreadsheet_parity_comparison.md`](spreadsheet_parity_comparison.md) | Dashboard ↔ source-spreadsheet parity matrix. |
| [`windows_install_troubleshooting.md`](windows_install_troubleshooting.md) | Diagnosing "installs but never runs" on Windows. |
| [`tiingo_fx_worker_update.md`](tiingo_fx_worker_update.md) | Operational checklist for the Cloudflare Worker backing the Tiingo FX fallback. |
| [`maintenance_audit.md`](maintenance_audit.md) | The single source-of-truth maintenance/performance backlog. |

## Implemented design records

Plans whose work has **shipped**. They are kept in place (rather than archived)
because the source code cites them by path as design context. Each carries a
status banner at the top.

| Document | Shipped |
| --- | --- |
| [`v3.0_live_web_companion_proposal.md`](v3.0_live_web_companion_proposal.md) | The encrypted live-web companion (plan of record, now built out across the v3.x/v4.x line). |
| [`single_brain_pull_plan.md`](single_brain_pull_plan.md) | v4.9.0 single data-orchestrator pull. |
| [`market_open_token_burn_fix_plan.md`](market_open_token_burn_fix_plan.md) | v4.2.0 market-open token-burn fix. |
| [`tiingo_fallback_plan.md`](tiingo_fallback_plan.md) | Tiingo secondary-provider price fallback (desktop + web). |
| [`tiingo_forex_fallback.md`](tiingo_forex_fallback.md) | Tiingo secondary live-FX fallback. |
| [`tiingo_fx_settled_spot_plan.md`](tiingo_fx_settled_spot_plan.md) | v4.16.1/4.16.2 settled-spot FX clamp. |
| [`tiingo_polling_storm_cleanup_plan.md`](tiingo_polling_storm_cleanup_plan.md) | Web companion polling-storm credit-burn cleanup. |
| [`time_alignment_plan.md`](time_alignment_plan.md) | One-clock NYSE exchange-time alignment (desktop + web). |
| [`provider_rate_limit_audit.md`](provider_rate_limit_audit.md) | Provider rate-limit audit (findings, 2026-06-24). |

## Pending / proposed work

Forward-looking designs that are **not assumed implemented**. They capture an
agreed (or proposed) direction; consult the status banner in each before relying
on it.

| Document | State |
| --- | --- |
| [`centralized_data_export_plan.md`](centralized_data_export_plan.md) | Python-side `live_graphs` enrichment (partially landed; see banner). |
| [`centralized_data_pull_plan.md`](centralized_data_pull_plan.md) | Web-side centralized pull (partially landed; see banner). |
| [`python_desktop_parity_plan.md`](python_desktop_parity_plan.md) | Desktop parity / NAV-in-1W action plan. |
| [`graph-unification-plan.md`](graph-unification-plan.md) | Design-frozen single intraday-window graph builder (not yet implemented). |
| [`session_close_completeness_plan.md`](session_close_completeness_plan.md) | Robust multi-provider session-close completeness (ready to implement). |
| [`fx_kpi_cold_start_regeneration_plan.md`](fx_kpi_cold_start_regeneration_plan.md) | FX KPI cold-start regeneration (proposal). |
| [`mobile_android_app_proposal.md`](mobile_android_app_proposal.md) | Native Android client (Phases 1–2 shipped; Phases 3–4 proposed). |

## Archive

Completed plan/design documents whose work has shipped live in
[`history/`](history/) — see [`history/README.md`](history/README.md) for the
index. They are kept for traceability only and no longer describe pending work.

## Comparison fixtures

[`Comparison Files/`](Comparison%20Files/) holds the **anonymized, fabricated**
spreadsheet/export fixtures used to validate parity. They contain no real
positions.
