# Action Plan — Centralized data export (Python desktop → web blob)

> **Status:** Proposed. This is the **Python-only** companion to
> `docs/centralized_data_pull_plan.md` (the web plan). It defines a **schema-v3
> `live_graphs` enrichment** that lets the web companion render a **much richer 1W
> graph** from the blob — every day at intraday resolution — **without spending the
> web's scarce provider credits**. The desktop uses yfinance (no rate limit), so it
> can afford to ship what the web cannot afford to pull.
>
> **Design correction (vs. an earlier draft):** the export ships the desktop's own
> **aggregate market-sleeve series** (value + per-instant FX + NAV prices),
> *un-coarsened and across the whole week* — **not** per-symbol bars. Per-symbol was
> over-built: drawing the *total* 1W curve never needed the parts, and the aggregate
> is **~N× smaller** for an N-symbol book. See "Why aggregate, not per-symbol".
>
> The web plan is written to **degrade gracefully** on today's schema-v2 blob and
> only *light up* the merge when this v3 export ships. The two plans are independent
> and can land in either order.

**Working directory:** `C:\Users\t-dhenke\OneDrive - Microsoft\Documents\VS Code\Investment-Overview`
**Scope:** `src/investment_dashboard/` (Python desktop) only.
**Tests:** existing pytest suite under `tests/`. No new frameworks. Verify green
before and after.

---

## Why this plan exists

The web 1W graph is **coarse**, for **two** reasons — and only one of them is the
provider budget:

1. Every web bar costs a provider credit, so the web emits few points/day for days
   it didn't watch live. (Real, but not the whole story.)
2. **The export itself downsamples to ≤80 points** (`live_graphs.py` `_downsample`)
   and ships **pre-folded whole-book values** computed against the *desktop's*
   holdings/base at capture time.

The desktop has no rate limit, so reason (1) does not apply to it — yet it still
hands the web a coarse, base-locked line. The fix is to **change the representation
at the source**: ship the desktop's *own* clever intraday representation —
**market-sleeve value + per-instant FX + NAV prices** — at full density across the
whole week, and let the web reapply *its* current cash/NAV base. Every source then
speaks one homogeneous quantity (**market-sleeve value over time**), so web and blob
**merge without base-change spikes** and become **directly cross-checkable**.

---

## Why aggregate, not per-symbol (the correction)

The desktop deliberately stores the **aggregate value of the intraday-priced
sleeve** + a **per-instant FX rate**, *not* per-symbol bars
(`models/intraday_value.py:1-23`). That decomposition (cash + NAV base reapplied at
render) is what stops a post-close NAV revaluation from **spiking** the curve. It is
the right design for drawing total value — and re-introducing per-symbol storage
would bring that spiking hazard back.

For the **web's** stated goals, per-symbol earns its keep in **exactly one** place —
*automatically attributing a flagged disagreement to a specific symbol* — and that
is a debugging luxury the owner will pursue manually anyway. Everything else works
on the aggregate:

| Web need | Needs per-symbol? |
|---|---|
| Draw the 1D / 1W total curve | **No** — aggregate value + FX + NAV draws it identically |
| Merge blob with the web's own live data | **No** — the web collapses its own per-symbol pulls to an aggregate sleeve series and merges aggregate-to-aggregate on one basis |
| Cross-check / flag disagreement | **Aggregate-level only** — flags *"these disagree by Δ% at 11:00"*, which is enough to trigger a manual deep-dive |
| Holdings changed since capture | Handled as **actual-historical** (see web Pillar 3); aggregate is correct for how value actually evolved |

So the export ships the aggregate. The only forgone feature — the blob naming
*which symbol* caused a divergence — is not worth **N×** the payload.

---

## Verified current state (code-cited)

| Fact | Location | Implication |
|---|---|---|
| `live_graphs` emits **whole-book values** per point: `{t, value_eur, value_usd}` | `readmodels/live_graphs.py:138-147` (`_zip_points`) | Base-locked at desktop holdings → not cleanly mergeable with the web's current-base line |
| Both curves capped to **≤80 points** via `_downsample()` | `readmodels/live_graphs.py:61, 163-169` | Coarse by design — the *real* root cause of "1W too coarse" |
| Desktop **already stores the right quantity**: `market_value_eur` (intraday-priced sleeve only) + per-instant `fx_eur_usd` | `models/intraday_value.py:37-62` | The aggregate sleeve series + FX needs **no new model** — just ship more of it |
| Sleeve samples retained **5 trading sessions**, pruned thereafter | `services/intraday_snapshots_service.py:160-161, 422-430` | Rolling ~1W window already maintained on device |
| Per-symbol bars fetched **transiently** for week repricing, not persisted | `services/intraday_snapshots_service.py:1049-1075` (`_build_week_day_samples`) | Used to reconstruct the sleeve aggregate, then discarded — exactly the transient use we keep |
| **Ready adapter:** `fetch_intraday_closes_range(symbols, start_day, end_day, interval="30m")` | `adapters/yfinance_client.py:359-417` | Token-free path to reconstruct the **aggregate** for days the desktop never opened |
| yfinance serves intraday for **~60 days** back | `adapters/yfinance_client.py:351-354` | 1W window comfortably in range |
| Dense whole-book samples spaced ~20s (no separate breadcrumb buffer) | `intraday_snapshots_service.py` (`record_if_market_open`, `MIN_CAPTURE_GAP_SECONDS`) | These dense samples *are* the desktop's "breadcrumbs" → optional display-only trail |
| Export built in `build_mobile_export()`; sealed in `build_envelope()` | `readmodels/mobile_export.py:447-449`, `services/publish_service.py:141-157` | Single integration point; encryption path unchanged |

**Key conclusion:** we need **no new persistence layer and no per-symbol store**.
The rich 1W series is the sleeve aggregate the desktop **already keeps** — shipped
**un-downsampled** — plus a **one-call `fetch_intraday_closes_range`** reconstruction
(emitting the aggregate) for any day in the window the desktop never had open.

---

## The v3 `live_graphs` schema

One homogeneous backbone (the aggregate **market-sleeve** series + its FX), the
**NAV/close anchors** the web reapplies as base, and an optional **display-only
trail**.

```jsonc
"live_graphs": {
  "schema_version": 3,                      // readers absent-tolerant for v1/v2
  "captured_at": "2026-06-25T17:30:00Z",
  "grid": "30m",                            // target cadence + comparison bucket, NOT a snap
  "session_dates": ["2026-06-19","2026-06-22","2026-06-23","2026-06-24","2026-06-25"],

  // ── Backbone: aggregate market-SLEEVE value over the full 1W window ──────
  // Intraday-priced holdings only (cash + NAV excluded — the web reapplies them).
  // FX-free native (USD-booked) value + the per-instant rate, so EITHER currency
  // is recoverable at the true per-timestamp rate (mirrors the desktop's contract).
  "market_series": {
    "times":        ["2026-06-19T13:30:00Z", "2026-06-19T14:00:00Z", ...],  // true instants
    "value_native": ["10240.55", "10251.10", ...],   // FX-free booked (USD) sleeve value; null = gap
    "fx_eur_usd":   ["1.07320", "1.07298", ...]       // aligned; null → web falls back to today's rate
  },

  // ── Authoritative settled anchors the web reapplies as base ──────────────
  "daily_close_native": { "2026-06-22":"10310.40", "2026-06-23":"10402.88", ... },  // sleeve close/day
  "nav_prices":         { "FUND_X":[["2026-06-22","102.40"],["2026-06-23","102.55"]], ... },

  // ── Optional display-only trail: desktop dense whole-book live samples ───
  "trail": {
    "display_only": true,                   // NEVER merged or cross-checked
    "points": [ {"t":"2026-06-25T14:03:11Z","value_eur":"...","value_usd":"..."}, ... ]
  }
}
```

### Design choices and rationale

- **Aggregate market-sleeve value, not per-symbol.** One series for the whole book
  (see "Why aggregate, not per-symbol"). The web reapplies its **current** cash+NAV
  base at render — so a holding bought since capture changes the base cleanly, never
  steps the *intraday* line.
- **FX-free native value + per-instant FX.** Ship the booked (USD) sleeve value and
  the rate in force at each instant; the web expresses EUR/USD at the **true
  per-timestamp** rate, exactly as the desktop derives its own two lines
  (`intraday_value.py:47-55`). The desktop computes `value_native` from its stored
  `market_value_eur` + `fx_eur_usd` via the same recovery it already uses.
- **Shared `times[]` + parallel arrays** → compact columnar form; `null` marks gaps.
- **True instants, not snapped.** Backbone marks from yfinance land on clean 30-min
  slots; the **trail** carries real irregular capture instants (14:03, not 14:00).
  The grid is a **bucketing rule for comparison only** — nothing is moved to render.
- **`daily_close_native` + `nav_prices` are the anchors.** Sleeve close/day is the
  authoritative endpoint the web fits finer points to (affine-fit within tolerance)
  and a cross-check reference; NAV prices let the web reapply the NAV base per day.
  Both cheap (~5×N numbers).
- **Trail is `display_only`.** The desktop's dense whole-book samples are
  base-dependent, so — like the web's own `session.tips` — the web rebases them on
  import and splices them *after* the freshest real point. They thicken the line but
  are **never** cross-checked. Capped (reuse the existing ≤80-point downsample) so
  "fun extra richness" never bloats the blob.
- **Whole window, not "today only".** Unlike the v2 coarse line, the backbone spans
  the **whole week** at intraday resolution — the explicit goal.

### Size budget ("a tad larger" — sanctioned, and small)

Because the backbone is **one** series regardless of symbol count:

- `market_series`: ~13 slots/day × 5 days ≈ **65** value cells + **65** FX cells,
  columnar decimal strings ≈ **3–6 KB** pre-encryption.
- `daily_close_native` + `nav_prices`: a few dozen numbers.
- `trail`: ≤80 points × 2 currencies ≈ negligible.
- **Total: a handful of KB** pre-encryption — *far* below the per-symbol draft and
  comfortably inside the owner's "tad larger, tad slower, richer graphs" ruling.

### Configurable grid + hard cap (the "within reason" guard)

- Default `interval = "30m"` (the desktop's native cadence — zero extra compute for
  today; one range call for prior days).
- Expose grid as a **single export setting** (`"30m"` default, `"15m"` for smoother
  — still only ~130 backbone cells, trivial).
- Enforce a **hard cell cap** on the backbone: if an unusually long/dense window
  would exceed it, **coarsen older days first** (older days drop to their daily
  close) so the payload stays bounded.

---

## Export-time backfill (the desktop's privilege)

For every day in the trailing 1W window, assemble the **aggregate sleeve series**
from the best available source, **preferring already-captured data and backfilling
the rest for free**:

1. **Today (live session):** reuse the dense `IntradayValue` sleeve samples already
   captured (`market_value_eur` + `fx_eur_usd`) — no new network.
2. **Prior days with a cached session:** reuse the rolling-week sleeve samples the
   device already holds.
3. **Prior days with a gap** (desktop was closed that day): **reconstruct the
   aggregate at export time** — `fetch_intraday_closes_range(market_symbols,
   gap_start, gap_end, interval=grid)` (`yfinance_client.py:359`) returns per-symbol
   closes which are **summed into the sleeve value** (× that instant's FX) and the
   per-symbol detail **discarded**, exactly as `_build_week_day_samples` already does
   for week repricing. Token-free; fills days **neither app ever had open**,
   delivering the maximal-data outcome.

> Only **market** (intraday-priced) symbols feed the sleeve. **NAV/cash** price once
> daily and are constant intraday; they ride in `nav_prices` + `holdings[]`
> (`last_known_price_native` / `previous_close_native`) exactly as today, and the
> web reapplies them as the render-time base.

---

## Integration points

| Change | Location |
|---|---|
| Build the v3 `market_series` (sleeve value + FX) + `daily_close_native` + `nav_prices` + optional `trail`; bump `schema_version` to 3 | `readmodels/live_graphs.py` (extend `build()`; add a sleeve-series assembler beside `_zip_points`; stop hard-downsampling the backbone) |
| Reuse cached sleeve samples; reconstruct gap-day aggregates via the range adapter | `services/intraday_snapshots_service.py` (expose the sleeve aggregate `_build_week_day_samples` already computes; add a window-gap backfill helper that **sums to sleeve value**, not per-symbol) |
| Range fetch (already exists — just call it) | `adapters/yfinance_client.py:359` (`fetch_intraday_closes_range`) |
| Schema-version note + absent-tolerance contract | `docs/mobile_export_schema.md` (document v3; readers tolerate v1/v2/v3) |
| No change to encryption/seal/upload path | `services/publish_service.py:141-157` (`build_envelope`) — payload grows, mechanism unchanged |

---

## Web-side consumption (cross-reference — implemented under the web plan)

This export feeds **Pillar 3** of `docs/centralized_data_pull_plan.md`. For
completeness, the web will: parse v3 `market_series` into the same **aggregate
sleeve series** its own reconstruction produces; **merge per nominal slot** (keep
agreeing slots within **τ ≤ 0.25%**; on disagreement keep the blob series for the
line and **emit a reconciliation flag** `(slot, web_value, blob_value, Δ%)`); fit
finer points to `daily_close_native`; reapply its **current** cash+NAV base via
`nav_prices` and the per-instant `fx_eur_usd`; and splice the rebased `trail` as a
display-only thickening. v3 is **absent-tolerant** — a v1/v2 blob simply yields the
legacy line and behaves as today.

---

## Workstreams (priority order)

1. **Sleeve-series assembler** — emit the columnar `market_series` (FX-free sleeve
   `value_native` + `fx_eur_usd`) for the live session from the `IntradayValue`
   samples the device already holds; emit `daily_close_native` + `nav_prices`. Bump
   `schema_version` to 3 and **stop downsampling the backbone**.
2. **Window-gap backfill** — detect 1W-window days with no cached session; reconstruct
   their sleeve aggregate via `fetch_intraday_closes_range` (sum per-symbol → sleeve,
   discard per-symbol). Token-free, behind the grid setting.
3. **Display-only trail** — ship the dense whole-book intraday samples as
   `trail.points` (reuse the ≤80 downsample), flagged `display_only`.
4. **Grid setting + hard cell cap** — `"30m"` default, `"15m"` option, backbone cell
   cap that coarsens older days first.
5. **Schema doc + absent-tolerance** — update `docs/mobile_export_schema.md`; ensure
   older readers ignore unknown sections.
6. **Parity/precision** — keep the existing money/rate tolerances (`1e-6` money,
   `1e-8` rates) for any value the web reconstructs from the backbone vs the
   desktop's own curve.

---

## Verification

- **Unit (`tests/`):** assembler emits aligned `times[]`/`value_native[]`/
  `fx_eur_usd[]` with correct `null` gaps and **no hard downsample**; backfill fills
  only genuine gaps and never re-fetches a cached day; gap reconstruction **sums to
  the sleeve value** and discards per-symbol detail; cell cap coarsens oldest-first
  and stays ≤ cap; `daily_close_native` matches settled sleeve closes; `nav_prices`
  present for NAV holdings; `trail` is downsampled and flagged `display_only`; v3
  payload is absent-tolerant (a reader ignoring `market_series` still works).
- **Round-trip:** build v3 export → reconstruct value from the sleeve backbone +
  shipped FX + a known current cash/NAV base → assert it matches the desktop's own
  1W curve within precision targets.
- **Manual:** publish from a desktop that was closed for one mid-week day; confirm
  the web shows that day at intraday resolution (backfilled) and that a deliberately
  divergent sleeve value raises a reconciliation flag rather than a spike.

---

## Explicit assumptions (flag if any is wrong)

1. The export ships the desktop's **aggregate market-sleeve series** (value + FX) +
   NAV/close anchors — **not** per-symbol bars (per the owner's correction).
2. The rich 1W backbone is sourced **at export time** (cached `IntradayValue`
   samples + yfinance gap reconstruction), **not** by adding a new persistent store.
3. Sleeve value is shipped **FX-free native (USD-booked)** with a **per-instant
   `fx_eur_usd`**, so the web recovers either currency at the true per-timestamp rate.
4. Only **market** (intraday-priced) symbols feed the sleeve; NAV/cash stay
   daily/implicit and ride in `nav_prices` + `holdings[]`.
5. Default grid **30-min**, optional 15-min, hard backbone cell cap coarsening
   oldest days first.
6. The dense whole-book samples ship as a **display-only** trail, never merged or
   cross-checked. Reconciliation tolerance **τ = 0.25%** (matches the web plan).
7. Encryption/seal/upload (`publish_service.build_envelope`) is unchanged; only the
   payload grows. The web consumes v3 under `docs/centralized_data_pull_plan.md`;
   this plan does not modify `web/`.
