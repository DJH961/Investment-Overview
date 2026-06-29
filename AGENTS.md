# Agent guide — read first

## 💵 USD IS THE PRIMARY CURRENCY (backend). EUR is frontend display only.

**USD is the canonical, homogeneous source of truth across the entire backend.**
~100% of holdings (and 100% of market funds) are USD-denominated. EUR is **only**
a frontend display preset — the default toggle on the dashboard, with a USD/EUR
switch, and nothing more.

- All backend computation, storage, reconciliation, and exports are **native USD**.
- EUR values are presentation-layer (`usd / fx`); never a source of truth.
- web<->blob market-sleeve reconciliation compares in **USD**.
- **NEVER** state, assume, or code as if EUR is the primary/base currency.

Default frontend = EUR; canonical backend = USD.

See `.github/copilot-instructions.md` for the same rule.

## Workflow requirements

- Always add a `CHANGELOG.md` entry that follows repository convention.
- Treat smaller UI updates and patch-sized changes as **Fixed** bug-fix entries.
- On completion, open/update the PR that contains the work.
- At the very end, check whether the branch conflicts with `main` and resolve
  conflicts before final handoff.