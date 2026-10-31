# Documentation index

Project rules live in [`../AGENTS.md`](../AGENTS.md); what shipped when is in
[`../CHANGELOG.md`](../CHANGELOG.md).

| Document | What it is |
| --- | --- |
| [`v6_one_app_plan.md`](v6_one_app_plan.md) | The v6 "One App" plan: one hosted backend plus a React frontend. |
| [`architecture.md`](architecture.md) | The current (v5) system: layers, storage tiers, data flow. |
| [`user_guide.md`](user_guide.md) | Control-by-control user guide (also shown on the in-app Help page). |
| [`legacy_v5.md`](legacy_v5.md) | The frozen v5.3.1 release: rollback, data rollback, troubleshooting. |
| [`original_spec.md`](original_spec.md) | The original v1 requirements; historical reference, source of the FX-aware return definition. |
| [`Comparison Files/`](Comparison%20Files/README.md) | Anonymized, fabricated import/export fixtures used by tests. |

Component docs: [`../web/README.md`](../web/README.md) (web companion),
[`../web/proxy/README.md`](../web/proxy/README.md) (Cloudflare Worker),
[`../web/devkit/README.md`](../web/devkit/README.md) (web dev kit),
[`../installer/README.md`](../installer/README.md) (Windows installer),
[`../SECURITY.md`](../SECURITY.md).

Older design plans, audits and proposals (the Tiingo fallback, time alignment,
graph unification, mobile export schema, v3.0 web companion, and so on) were removed
to keep this folder current. They remain on branch `legacy/v5` (tag `v5.3.1`) and in
git history under `docs/`.
