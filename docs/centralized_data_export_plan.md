# Action Plan — Centralized data export (Python desktop → web blob)

> **Status:** Proposed. This is the **Python-only** companion to
> `docs/centralized_data_pull_plan.md` (the web plan). It defines the **schema-v3
> `live_graphs` enrichment** that lets the web companion render a **much richer 1W
> graph** from the blob — every day at intraday resolution — without spending the
> web's scarce provider credits. The desktop uses yfinance (no rate limit), so it
> can afford to ship what the web cannot afford to pull.
>
> The web plan is written to **degrade gracefully** on today's schema-v2 blob and
> only *light up* the multi-source merge when this v3 export ships. The two plans
> are independent and can land in either order.

**Working directory:** `C:\Users\t-dhenke\OneDrive - Microsoft\Documents\VS Code\Investment-Overview`
**Scope:** `src/investment_dashboard/` (Python desktop) only.
**Tests:** existing pytest suite under `tests/`. No new frameworks. Verify green
before and after.

---

## Why this plan exists

The web 1W graph is **coarse by necessity**: every bar costs a provider credit, so
the web emits only ~2 points/day for days it didn't watch live. The desktop has no
such constraint — yet today's export ships the 1W curve as **pre-folded
whole-book values** (`value_eur`/`value_usd`), computed against the *desktop's*
holdings/base at capture time. That representation:

- **Can't be cleanly merged** with the web's own *current-base* reconstruction —
  comparing a desktop-base value line against a current-base line shows steps that
  are **base changes, not data errors** (e.g. a symbol bought since capture).
- **Can't repair per-symbol granularity** — it has no per-symbol prices.

The fix is to **change the representation at the source**: ship **per-symbol
native price bars on a shared time axis**, and let the web reconstruct value
itself against the current anchor. Every source then becomes homogeneous
(`(symbol, time, native price)`), so they **merge without spikes** and become
**directly cross-checkable**.

---

## Verified current state (code-cited)

| Fact | Location | Implication |
|---|---|---|
| `live_graphs` emits **whole-book values** per point: `{t, value_eur, value_usd}` | `readmodels/live_graphs.py:138-147` (`_zip_points`) | Base-dependent → not mergeable with web's current-base line |
| Both curves capped to **≤80 points** via `_downsample()` | `readmodels/live_graphs.py:61, 163-169` | Coarse by design |
| Desktop stores only **whole-book** intraday samples (`market_value_eur`, `fx_eur_usd`) | `models/intraday_value.py:37-62` | **No** persisted per-symbol bar store |
| Whole-book samples retained **5 trading sessions**, pruned thereafter | `services/intraday_snapshots_service.py:160-161, 422-430` | Rolling ~1W window already maintained |
| Per-symbol bars fetched **transiently** for week repricing, not persisted | `services/intraday_snapshots_service.py:1049-1075` (`_build_week_day_samples`) | Per-symbol data is *available* mid-build but thrown away |
| **Ready adapter:** `fetch_intraday_closes_range(symbols, start_day, end_day, interval="30m") -> {symbol:{datetime:close}}` | `adapters/yfinance_client.py:359-417` | **The export-time backfill path** — token-free |
| yfinance serves intraday for **~60 days** back | `adapters/yfinance_client.py:351-354` | 1W window is comfortably in range |
| **No** desktop breadcrumb/tips buffer; dense whole-book samples spaced ~20s | `intraday_snapshots_service.py` (`record_if_market_open`, `MIN_CAPTURE_GAP_SECONDS`) | These dense samples *are* the desktop's "breadcrumbs" |
| Export built in `build_mobile_export()`; sealed in `build_envelope()` | `readmodels/mobile_export.py:447-449`, `services/publish_service.py:141-157` | Single integration point |

**Key conclusion:** we do **not** need a new persistence layer. The rich
per-symbol week is produced by **one export-time `fetch_intraday_closes_range`
call** over the trailing 1W window. No rate-limit cost; uses an adapter that
already exists and is already exercised by the week-curve reconstruction.

---

## The v3 `live_graphs` schema

Two layers, mirroring the web's model: a **per-symbol bar backbone** (rigorous,
mergeable, cross-checkable) and an optional **whole-book trail** (display-only).

```jsonc
"live_graphs": {
  "schema_version": 3,                      // readers absent-tolerant for v1/v2
  "captured_at": "2026-06-25T17:30:00Z",
  "grid": "30m",                            // target cadence + comparison bucket, NOT a snap
  "session_dates": ["2026-06-19","2026-06-22","2026-06-23","2026-06-24","2026-06-25"],

  // ── Backbone: per-symbol native price bars, full 1W window ──────────────
  "bars": {
    "times": ["2026-06-19T13:30:00Z", "2026-06-19T14:00:00Z", ...],  // shared axis, true instants
    "native": {
      "AAPL": ["198.40", null, "199.10", ...],   // aligned to times[]; null = no bar in slot
      "VTI":  ["...", ...]
    }
  },

  // ── Authoritative settled endpoints (cheap, ~5×N numbers) ───────────────
  "daily_close_native": {
    "AAPL": [["2026-06-22","200.10"], ["2026-06-23","201.42"], ...]
  },

  // ── Optional display-only trail: desktop whole-book live samples ────────
  "trail": {
    "display_only": true,                   // NEVER merged or cross-checked
    "points": [ {"t":"2026-06-25T14:03:11Z","value_eur":"...","value_usd":"..."}, ... ]
  }
}
```

### Design choices and rationale

- **Per-symbol native price** (not whole-book value) → the web reprices against its
  **current** anchor (holdings + FX), so a symbol bought since capture adds
  *coverage*, never a base-change step. This is the single change that makes merge
  spike-free.
- **Shared `times[]` axis + parallel arrays** → compact columnar form; `null` marks
  gaps. Far smaller than repeating a timestamp per point.
- **True instants, not snapped.** Backbone bars from yfinance land on clean 30-min
  marks; the **trail** carries real irregular capture instants (14:03, not 14:00).
  The grid is a **bucketing rule for comparison only** — the web never moves a
  point to render it.
- **`daily_close_native`** stays as the **authoritative settled close** per day:
  the anchor the web fits finer bars to (affine-fit within tolerance), and a
  cross-check reference. Cheap (~5×N numbers).
- **Trail is `display_only`.** The desktop's dense whole-book samples are
  base-dependent, so — like the web's own `session.tips` — the web rebases them on
  import and splices them *after* the freshest real bar. They thicken the line but
  are **never** cross-checked (no per-symbol price). Capped (reuse the existing
  ≤80-point downsample) so "fun extra richness" never bloats the blob.
- **Today fine, prior days fine too.** Unlike the v2 "today only" richness, the
  backbone spans the **whole window** at intraday resolution — the explicit goal.

### Size budget ("a tad larger" — sanctioned)

- Backbone: ~13 slots/day × 5 days × ~12 symbols ≈ **780 cells**, columnar decimal
  strings ≈ **15–25 KB** pre-encryption.
- `daily_close_native`: ~60 numbers.
- Trail: ≤80 points × 2 currencies ≈ negligible.
- **Total a few tens of KB** pre-encryption. Acceptable per the owner's "tad larger,
  tad slower, but richer graphs" ruling.

### Configurable grid + hard cap (the "within reason" guard)

- Default `interval = "30m"` (the desktop's native cadence — zero extra compute for
  today; one range call for prior days).
- Expose grid as a **single export setting** (`"30m"` default, `"15m"` for smoother
  — ~1,560 cells, still fine).
- Enforce a **hard cell cap (~2,000)**: if a large book would exceed it, **coarsen
  older days first** (older days drop to daily closes) so the payload stays bounded.

---

## Export-time backfill (the desktop's privilege)

For every day in the trailing 1W window, assemble the backbone from the best
available source, **preferring already-captured data and backfilling the rest for
free**:

1. **Today (live session):** reuse the per-symbol bars the week-curve path already
   fetches in `_build_week_day_samples()` (`intraday_snapshots_service.py:1049`) —
   no new network.
2. **Prior days with a cached session:** same — reuse what the rolling-week cache
   holds.
3. **Prior days with a gap** (desktop was closed that day): **backfill at export
   time** via `fetch_intraday_closes_range(market_symbols, gap_start, gap_end,
   interval=grid)` (`yfinance_client.py:359`). Token-free; fills days **neither app
   ever had open**, delivering the maximal-data outcome.

> Only **market** symbols get intraday bars. **NAV/cash** price once daily and are
> constant intraday; they stay implicit in `holdings[]` (`last_known_price_native`
> / `previous_close_native`) exactly as today.

---

## Integration points

| Change | Location |
|---|---|
| Build the v3 `bars` backbone + `daily_close_native` + optional `trail`; bump `schema_version` to 3 | `readmodels/live_graphs.py` (extend `build()`; add a per-symbol assembler beside `_zip_points`) |
| Reuse cached per-symbol session bars; backfill gaps via the range adapter | `services/intraday_snapshots_service.py` (expose the per-symbol bars `_build_week_day_samples` already computes; add a window-gap backfill helper) |
| Range fetch (already exists — just call it) | `adapters/yfinance_client.py:359` (`fetch_intraday_closes_range`) |
| Schema-version note + absent-tolerance contract | `docs/mobile_export_schema.md` (document v3; readers tolerate v1/v2/v3) |
| No change to encryption/seal/upload path | `services/publish_service.py:141-157` (`build_envelope`) — payload grows, mechanism unchanged |

---

## Web-side consumption (cross-reference — implemented under the web plan)

This export feeds Pillar 3 of `docs/centralized_data_pull_plan.md`. For
completeness, the web will: parse v3 `bars` into the same per-symbol shape its own
fetchers produce; **merge per nominal slot, per symbol** (keep all sources
agreeing within **τ ≤ 0.25%**; on disagreement keep the authoritative source and
**emit a reconciliation flag** `(symbol, slot, web_price, blob_price, Δ%)`); fit
finer bars to `daily_close_native` endpoints; and splice the rebased
`trail` as a display-only thickening. v3 is **absent-tolerant** — a v1/v2 blob
simply yields fewer sources and behaves as today.

---

## Workstreams (priority order)

1. **Per-symbol assembler** — produce `{symbol: {instant: close}}` for the live
   session from data the week path already fetches; emit the columnar `bars`
   backbone + `daily_close_native`. Bump `schema_version` to 3.
2. **Window-gap backfill** — detect 1W-window days with no cached session; fill via
   `fetch_intraday_closes_range`. Token-free, behind the grid setting.
3. **Display-only trail** — ship the dense whole-book intraday samples as
   `trail.points` (reuse the ≤80 downsample), flagged `display_only`.
4. **Grid setting + hard cell cap** — `"30m"` default, `"15m"` option, ~2,000-cell
   cap that coarsens older days first.
5. **Schema doc + absent-tolerance** — update `docs/mobile_export_schema.md`;
   ensure older readers ignore unknown sections.
6. **Parity/precision** — keep the existing money/rate tolerances
   (`1e-6` money, `1e-8` rates) for any value the web reconstructs from the
   backbone vs the desktop's own curve.

---

## Verification

- **Unit (`tests/`):** assembler emits aligned `times[]`/`native[]` with correct
  `null` gaps; backfill fills only genuine gaps and never re-fetches a cached day;
  cell cap coarsens oldest-first and stays ≤ cap; `daily_close_native` matches the
  settled closes; `trail` is downsampled and flagged `display_only`; v3 payload is
  absent-tolerant (a reader ignoring `bars` still works).
- **Round-trip:** build v3 export → reconstruct value from the backbone against a
  known holdings/FX anchor → assert it matches the desktop's own 1W curve within
  precision targets.
- **Manual:** publish from a desktop that was closed for one mid-week day; confirm
  the web shows that day at intraday resolution (backfilled) and that a deliberately
  divergent price raises a reconciliation flag rather than a spike.

---

## Explicit assumptions (flag if any is wrong)

1. The rich 1W backbone is sourced **at export time** (cached session bars +
   yfinance gap backfill), **not** by adding a new persistent per-symbol store.
2. Only **market** symbols carry intraday bars; NAV/cash stay daily/implicit.
3. Default grid **30-min**, optional 15-min, hard cap ~2,000 cells coarsening
   oldest days first.
4. The desktop's dense whole-book samples are shipped as a **display-only** trail,
   never merged or cross-checked.
5. Reconciliation tolerance **τ = 0.25%** (matches the web plan).
6. Encryption/seal/upload (`publish_service.build_envelope`) is unchanged; only the
   payload grows.
7. The web consumes v3 under `docs/centralized_data_pull_plan.md`; this plan does
   not modify `web/`.
