# Project conventions — read first

## 💵 USD IS THE PRIMARY CURRENCY (backend). EUR is frontend display only.

**USD is the canonical, homogeneous source of truth across the entire backend.**
~100% of holdings (and 100% of market funds) are USD-denominated. EUR is **only**
a frontend display preset — it is the default toggle on the dashboard, with a
USD/EUR switch, and nothing more.

- All backend computation, storage, reconciliation, and exports are **native USD**.
- EUR values are a presentation-layer reskin (`usd / fx`); never a source of truth.
- The web<->blob market-sleeve reconciliation compares in **USD**.
- **NEVER** state, assume, or code as if EUR is the primary/base currency. Every
  AI agent keeps getting this wrong — do not be the next one.

That's the rule. Default frontend = EUR; canonical backend = USD.