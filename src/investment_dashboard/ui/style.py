"""Global CSS + Quasar primary-color setup for the "neo-fintech" chrome.

This module is the single source of truth for the visual identity of the
dashboard. It is injected into the document ``<head>`` by
:func:`install` (called once at boot from
:mod:`investment_dashboard.main`).

Design tokens themselves live in :mod:`investment_dashboard.ui.theme`; this
file just emits them as CSS custom properties and adds a handful of
component-level rules (cards, sidebar nav, AG-Grid, scrollbars, focus
rings, toast styling).

Nothing here changes behaviour — it is strictly cosmetic.
"""

from __future__ import annotations

from investment_dashboard.ui.theme import (
    BRAND,
    BRAND_HOVER,
    COLORS_DARK,
    COLORS_LIGHT,
    RADIUS,
    SHADOW_SOFT,
    register_plotly_template,
)


def _css() -> str:
    """Return the global stylesheet as a single string."""
    light = COLORS_LIGHT
    dark = COLORS_DARK
    return f"""
:root {{
  --inv-canvas: {light["canvas"]};
  --inv-surface: {light["surface"]};
  --inv-surface-alt: {light["surface_alt"]};
  --inv-ink: {light["ink"]};
  --inv-muted: {light["muted"]};
  --inv-hairline: {light["hairline"]};
  --inv-accent: {light["accent"]};
  --inv-accent-soft: {light["accent_soft"]};
  --inv-accent-ring: {light["accent_ring"]};
  --inv-gain: #0072B2;
  --inv-loss: #E69F00;
  --inv-radius-md: {RADIUS["md"]};
  --inv-radius-lg: {RADIUS["lg"]};
  --inv-radius-xl: {RADIUS["xl"]};
  --inv-radius-pill: {RADIUS["pill"]};
  --inv-shadow-soft: {SHADOW_SOFT};
}}

.body--dark, html.dark, [data-theme="dark"] {{
  --inv-canvas: {dark["canvas"]};
  --inv-surface: {dark["surface"]};
  --inv-surface-alt: {dark["surface_alt"]};
  --inv-ink: {dark["ink"]};
  --inv-muted: {dark["muted"]};
  --inv-hairline: {dark["hairline"]};
  --inv-accent: {dark["accent"]};
  --inv-accent-soft: {dark["accent_soft"]};
  --inv-accent-ring: {dark["accent_ring"]};
}}

html {{
  /* Bump the root font-size so every rem-based token (body text, KPI tiles,
     section titles, tables, etc.) scales up uniformly. The default browser
     value is 16px; v1.5 bumped to 18px, v2.4 takes it to 20px so the KPI
     numbers and table headers read cleanly on a 1080p panel from across the
     room. Fixed-pixel measurements (table row height, header height, AG-Grid
     paddings) are tuned alongside this in the AG-Grid block below. */
  font-size: 20px;
}}

html, body {{
  background: var(--inv-canvas);
  color: var(--inv-ink);
  font-family: "Inter", system-ui, -apple-system, "Segoe UI", Roboto,
               "Helvetica Neue", Arial, sans-serif;
  font-feature-settings: "cv11", "ss01";
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}}

.body--dark {{ background: var(--inv-canvas); color: var(--inv-ink); }}

/* Tabular numbers for any element marked .inv-tnum (financial values). */
.inv-tnum, .inv-tnum * {{
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1;
}}

/* ------------------------------------------------------------------ */
/* Header (Quasar q-header)                                            */
/* ------------------------------------------------------------------ */
.inv-header {{
  background: color-mix(in srgb, var(--inv-surface) 88%, transparent) !important;
  color: var(--inv-ink) !important;
  border-bottom: 1px solid var(--inv-hairline);
  backdrop-filter: saturate(180%) blur(10px);
  -webkit-backdrop-filter: saturate(180%) blur(10px);
  box-shadow: none !important;
}}
.inv-header .inv-brand-name {{
  font-weight: 600;
  letter-spacing: -0.01em;
}}
.inv-header .inv-brand-mark {{
  width: 28px; height: 28px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 8px;
  background: var(--inv-accent);
  color: #fff;
}}
.inv-version-pill {{
  font-size: 0.6875rem;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: var(--inv-radius-pill);
  background: var(--inv-accent-soft);
  color: var(--inv-accent);
  letter-spacing: 0.02em;
}}

/* Auto-refresh activity chip (header): always-on "Live", spins + reads
   "Updating…" while a background price pull runs (see refresh_indicator). */
.inv-refresh-chip {{
  gap: 4px;
  padding: 2px 10px;
  border-radius: var(--inv-radius-pill);
  background: var(--inv-surface-alt);
  color: var(--inv-muted);
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}}
.inv-refresh-chip .inv-refresh-icon {{
  font-size: 0.95rem;
}}
.inv-refresh-chip.inv-refresh-active {{
  background: var(--inv-accent-soft);
  color: var(--inv-accent);
}}
/* Live feed: market is open and fresh prices are landing. Tinted with the gain
   accent and a gently pulsing icon so it reads as "moving right now" — the
   desktop echo of the web companion's pulsing "market open" badge. */
.inv-refresh-chip.inv-refresh-live {{
  background: color-mix(in srgb, var(--inv-gain) 12%, transparent);
  color: var(--inv-gain);
}}
.inv-refresh-icon.inv-refresh-live {{
  animation: inv-refresh-pulse 2s ease-out infinite;
}}
@keyframes inv-refresh-pulse {{
  0% {{ opacity: 1; }}
  50% {{ opacity: 0.45; }}
  100% {{ opacity: 1; }}
}}
.inv-refresh-icon.inv-refresh-spin {{
  animation: inv-refresh-spin 0.9s linear infinite;
}}
@keyframes inv-refresh-spin {{ to {{ transform: rotate(360deg); }} }}
/* Thin top-of-page bar that pulses while an automatic price refresh runs, so
   the auto-update is visible at the very top, not only in the header chip. */
#inv-refreshbar {{
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg,
    transparent, var(--inv-accent), var(--inv-accent), transparent);
  background-size: 40% 100%;
  background-repeat: no-repeat;
  opacity: 0;
  transition: opacity 0.25s ease;
  pointer-events: none;
  z-index: 100003;
}}
#inv-refreshbar.is-active {{
  opacity: 1;
  animation: inv-refreshbar-slide 1.1s linear infinite;
}}
@keyframes inv-refreshbar-slide {{
  0% {{ background-position: -40% 0; }}
  100% {{ background-position: 140% 0; }}
}}
@media (prefers-reduced-motion: reduce) {{
  .inv-refresh-icon.inv-refresh-spin {{ animation: none; }}
  .inv-refresh-icon.inv-refresh-live {{ animation: none; }}
  #inv-refreshbar.is-active {{ animation: none; }}
  #inv-history-progress-fill {{ transition: none; }}
}}

/* Small bottom-corner determinate progress bar shown while a from-scratch
   historic re-download runs (after a cache reset, or re-opening the app after a
   long absence). Hidden until ``.is-active`` so it never clutters an idle page.
   Sits in the corner, clear of the centred toasts/notifications. */
#inv-history-progress {{
  position: fixed;
  left: max(12px, env(safe-area-inset-left, 0px));
  bottom: max(12px, env(safe-area-inset-bottom, 0px));
  z-index: 100002;
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 220px;
  max-width: 60vw;
  padding: 10px 12px;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--inv-accent);
  background: var(--inv-surface);
  border: 1px solid var(--inv-hairline);
  border-radius: 10px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  opacity: 0;
  transform: translateY(8px);
  transition: opacity 0.2s ease, transform 0.2s ease;
  pointer-events: none;
}}
#inv-history-progress.is-active {{
  opacity: 1;
  transform: translateY(0);
}}
#inv-history-progress-track {{
  width: 100%;
  height: 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--inv-accent) 18%, transparent);
  overflow: hidden;
}}
#inv-history-progress-fill {{
  height: 100%;
  width: 0%;
  border-radius: 999px;
  background: var(--inv-accent);
  transition: width 0.3s ease;
}}

/* ------------------------------------------------------------------ */
/* Sidebar                                                             */
/* ------------------------------------------------------------------ */
.inv-sidebar {{
  background: var(--inv-surface) !important;
  border-right: 1px solid var(--inv-hairline) !important;
  width: 240px !important;
}}
.inv-sidebar .inv-nav-section {{
  font-size: 0.6875rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--inv-muted);
  padding: 1rem 1rem 0.25rem;
}}
.inv-sidebar .q-item.inv-nav-item {{
  border-radius: var(--inv-radius-md);
  margin: 2px 8px;
  min-height: 40px;
  color: var(--inv-ink);
  transition: background 150ms ease-out, color 150ms ease-out;
  position: relative;
}}
.inv-sidebar .q-item.inv-nav-item .q-icon {{
  color: var(--inv-muted);
  transition: color 150ms ease-out;
}}
.inv-sidebar .q-item.inv-nav-item:hover {{
  background: var(--inv-surface-alt);
}}
.inv-sidebar .q-item.inv-nav-item.inv-nav-active {{
  background: var(--inv-accent-soft);
  color: var(--inv-accent);
  font-weight: 600;
}}
.inv-sidebar .q-item.inv-nav-item.inv-nav-active .q-icon {{
  color: var(--inv-accent);
}}
.inv-sidebar .q-item.inv-nav-item.inv-nav-active::before {{
  content: "";
  position: absolute;
  left: 0; top: 8px; bottom: 8px;
  width: 3px; border-radius: 3px;
  background: var(--inv-accent);
}}
.inv-sidebar-footer {{
  padding: 12px 16px;
  color: var(--inv-muted);
  font-size: 0.75rem;
  border-top: 1px solid var(--inv-hairline);
}}

/* ------------------------------------------------------------------ */
/* Page frame / sections                                               */
/* ------------------------------------------------------------------ */
.inv-page {{
  max-width: 1440px;
  margin: 0 auto;
  width: 100%;
}}
.inv-page-header h1 {{
  font-size: 1.5rem;
  font-weight: 600;
  letter-spacing: -0.015em;
  color: var(--inv-ink);
  margin: 0;
}}
.inv-page-header .inv-page-subtitle {{
  color: var(--inv-muted);
  font-size: 0.9375rem;
  margin-top: 2px;
}}

/* Overview header: the page title sits on the left and a prominent Total Value
   "hero" box on the right, the way a neobroker leads with the headline number.
   Wraps to a stacked layout on narrow viewports. */
.inv-overview-header {{
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem 1.5rem;
  flex-wrap: wrap;
}}
.inv-hero-total {{
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  text-align: right;
  margin-left: auto;
}}
@media (max-width: 40rem) {{
  .inv-hero-total {{
    align-items: flex-start;
    text-align: left;
    margin-left: 0;
  }}
}}
.inv-hero-total .inv-hero-label {{
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--inv-muted);
  font-weight: 600;
}}
.inv-hero-total .inv-hero-value {{
  font-size: clamp(1.9rem, 1.4rem + 2.2vw, 2.9rem);
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.05;
  color: var(--inv-ink);
  font-variant-numeric: tabular-nums;
}}
.inv-hero-total .inv-hero-value .inv-kpi-dual-ccy {{
  font-size: 0.5em;
}}
.inv-hero-total .inv-hero-secondary {{
  font-size: clamp(1rem, 0.9rem + 0.6vw, 1.3rem);
  font-weight: 600;
  color: var(--inv-ink);
  opacity: 0.78;
  font-variant-numeric: tabular-nums;
  margin-top: 1px;
}}
.inv-hero-total .inv-hero-change {{
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  margin-top: 0.45rem;
  padding: 0.2rem 0.6rem;
  border-radius: var(--inv-radius-pill);
  font-size: 0.8125rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  background: var(--inv-surface-alt);
}}
/* A touch of breathing room between the hero/header and the KPI band below. */
.inv-kpi-grid--hero {{
  margin-top: 0.5rem;
}}

/* --- Currency · EUR ↔ USD box -------------------------------------------- *
 * A full-width box beneath the KPI grid (mirrors the web companion's currency
 * box, moved out from a cramped caption line under the headline total): the live
 * spot, today's rate move, and the currency effect on the USD-booked book. */
.inv-fx-box {{
  display: grid;
  gap: 0.75rem;
  margin-top: 0.5rem;
  padding: 1rem 1.1rem 1.1rem;
  background: var(--inv-surface);
  border: 1px solid var(--inv-hairline);
  border-radius: var(--inv-radius-lg);
}}
.inv-fx-box-head {{
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.6rem;
}}
.inv-fx-box-title {{
  font-size: 0.6875rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--inv-muted);
}}
.inv-fx-box-stats {{
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.6rem 1rem;
}}
.inv-fx-box-stats-pair {{ grid-template-columns: repeat(2, 1fr); }}
.inv-fx-box-stat {{ display: grid; gap: 0.1rem; align-content: start; }}
.inv-fx-box-stat-label {{
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--inv-muted);
  font-weight: 600;
}}
.inv-fx-box-stat-value {{
  font-size: 1.25rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
}}
.inv-fx-box-stat-value.pos {{ color: var(--inv-gain); }}
.inv-fx-box-stat-value.neg {{ color: var(--inv-loss); }}
.inv-fx-box-stat-value.flat {{ color: var(--inv-muted); }}
.inv-fx-box-stat-sub {{
  font-size: 0.75rem;
  color: var(--inv-muted);
  font-weight: 500;
}}
.inv-fx-box-closed {{
  color: var(--inv-loss);
  background: color-mix(in srgb, var(--inv-loss) 14%, transparent);
  border-radius: 999px;
  padding: 0.05rem 0.5rem;
  font-size: 0.66rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  white-space: nowrap;
}}
.inv-fx-box-reopen {{
  font-size: 0.74rem;
  color: var(--inv-muted);
  font-weight: 500;
}}

/* --- Currency effect since yesterday (net + diverging market-hours/overnight split) - *
 * How much of today's EUR/USD revaluation is real euro P/L, and — once the US
 * session is shut — how much landed *while the market was open* versus
 * *overnight*, since the USD-booked book keeps drifting on FX alone after the
 * close. In USD display the dollar value is untouched, so we say so and surface
 * the EUR-repatriation figure instead. */
.inv-fx-effect {{
  display: grid;
  gap: 0.55rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--inv-hairline);
}}
.inv-fx-effect-head {{
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.6rem;
}}
.inv-fx-effect-title {{
  font-size: 0.6875rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--inv-muted);
}}
.inv-fx-effect-net {{
  font-size: 1.05rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}}
.inv-fx-effect-net.pos {{ color: var(--inv-gain); }}
.inv-fx-effect-net.neg {{ color: var(--inv-loss); }}
.inv-fx-effect-net.flat {{ color: var(--inv-muted); }}
.inv-fx-effect-note {{
  margin: 0;
  font-size: 0.78rem;
  color: var(--inv-muted);
  line-height: 1.45;
}}
/* The diverging bar: each leg grows from a shared centre line — right for a
 * gain, left for a loss — so two legs pulling in opposite directions read
 * clearly instead of being crammed into one stacked bar. The overnight leg is
 * striped so it is told apart from the market-hours leg by shape, not colour
 * alone (colourblind-safe, matching the Wong blue-gain / orange-loss). */
.inv-fx-diverge {{ display: grid; gap: 0.4rem; }}
.inv-fx-diverge-row {{
  display: grid;
  grid-template-columns: 6.75rem 1fr 5rem;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.78rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}}
.inv-fx-diverge-label {{ color: var(--inv-muted); display: flex; align-items: baseline; gap: 0.35rem; }}
.inv-fx-diverge-tag {{
  font-size: 0.6rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--inv-muted);
  opacity: 0.75;
}}
.inv-fx-diverge-track {{
  position: relative;
  height: 0.5rem;
  border-radius: var(--inv-radius-pill);
  background: var(--inv-surface-alt);
}}
.inv-fx-diverge-track::before {{
  content: "";
  position: absolute;
  left: 50%;
  top: -1px;
  bottom: -1px;
  width: 1px;
  background: var(--inv-hairline);
}}
.inv-fx-diverge-fill {{
  position: absolute;
  top: 0;
  bottom: 0;
  min-width: 2px;
  transition: width 0.3s ease;
}}
.inv-fx-diverge-fill.pos {{ left: 50%; border-radius: 0 999px 999px 0; background: var(--inv-gain); }}
.inv-fx-diverge-fill.neg {{ right: 50%; border-radius: 999px 0 0 999px; background: var(--inv-loss); }}
.inv-fx-diverge-fill.flat {{ left: 50%; width: 0; }}
.inv-fx-diverge-overnight.pos {{
  background: repeating-linear-gradient(
    45deg,
    var(--inv-gain),
    var(--inv-gain) 3px,
    color-mix(in srgb, var(--inv-gain) 45%, transparent) 3px,
    color-mix(in srgb, var(--inv-gain) 45%, transparent) 6px
  );
}}
.inv-fx-diverge-overnight.neg {{
  background: repeating-linear-gradient(
    45deg,
    var(--inv-loss),
    var(--inv-loss) 3px,
    color-mix(in srgb, var(--inv-loss) 45%, transparent) 3px,
    color-mix(in srgb, var(--inv-loss) 45%, transparent) 6px
  );
}}
.inv-fx-diverge-value {{ text-align: right; }}
.inv-fx-diverge-value.pos {{ color: var(--inv-gain); }}
.inv-fx-diverge-value.neg {{ color: var(--inv-loss); }}
.inv-fx-diverge-value.flat {{ color: var(--inv-ink); }}

.inv-section {{
  background: var(--inv-surface) !important;
  border: 1px solid var(--inv-hairline);
  border-radius: var(--inv-radius-lg);
  box-shadow: var(--inv-shadow-soft);
  padding: 1.25rem 1.25rem 1rem;
  margin: 0 !important;
  /* Clip oversized children (wide AG-Grid tables, plotly canvases) so they
     scroll internally instead of overhanging the section card / page width.
     ``min-width: 0`` lets the section participate in flex/grid shrinking
     without forcing its parent column to grow. */
  overflow: hidden;
  min-width: 0;
  transition: box-shadow 150ms ease-out, border-color 150ms ease-out;
}}
.inv-section-title {{
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--inv-ink);
  letter-spacing: -0.005em;
  margin: 0 0 0.75rem 0;
}}

/* ------------------------------------------------------------------ */
/* Collapsible settings sections + group headings (Settings tidy-up)   */
/* ------------------------------------------------------------------ */
/* A collapsible section reuses the section card look but is a Quasar
   expansion so advanced/rarely-touched groups can stay tucked away. The
   header carries the same weight as ``.inv-section-title`` so an expanded
   collapsible is indistinguishable from a plain section. */
.inv-collapse {{
  background: var(--inv-surface) !important;
  border: 1px solid var(--inv-hairline);
  border-radius: var(--inv-radius-lg);
  box-shadow: var(--inv-shadow-soft);
  overflow: hidden;
  min-width: 0;
}}
.inv-collapse :deep(.q-expansion-item__container > .q-item) {{
  padding: 0.9rem 1.25rem;
  min-height: unset;
}}
.inv-collapse :deep(.q-expansion-item__content) {{
  padding: 0 1.25rem 1rem;
}}
/* Match the header text weight to a plain section title so an expanded
   collapsible is indistinguishable from a `section`. */
.inv-collapse :deep(.q-item__label),
.inv-collapse :deep(.q-expansion-item__toggle-icon) {{
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--inv-ink);
  letter-spacing: -0.005em;
}}
/* A lightweight, card-less heading that labels a group of sections, so the
   page reads as a few labelled clusters rather than one long flat list. */
.inv-settings-group-heading {{
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--inv-ink-subtle, var(--inv-ink));
  opacity: 0.6;
  margin: 1.25rem 0 0.25rem 0.25rem;
}}
.inv-settings-group-heading:first-child {{
  margin-top: 0;
}}

/* ------------------------------------------------------------------ */
/* KPI / metric cards                                                  */
/* ------------------------------------------------------------------ */
/* v2.8.1 — all Overview KPI tiles share one responsive grid so every
   card is the same width and lines up in tidy columns instead of the
   ragged flex-wrap rows that left odd gaps and mismatched sizes. */
.inv-kpi-grid {{
  display: grid;
  /* v3.6.1 — fit five tiles per row (risk / drawdown / currency bands have
     five metrics each) instead of wrapping the 5th onto a lonely second row.
     ``auto-fit`` collapses unused tracks so smaller bands (the 3-tile hero /
     Returns groups) still stretch to fill the row. */
  grid-template-columns: repeat(auto-fit, minmax(10.5rem, 1fr));
  gap: 1rem;
  align-items: stretch;
}}
/* Small caption that introduces a grouped band of KPI tiles (Analytics risk
   groups). Adds vertical rhythm between the concept groups. */
.inv-kpi-group-title {{
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--inv-muted);
  margin: 1.25rem 0 0.5rem 0;
}}
.inv-kpi-group-title:first-child {{
  margin-top: 0;
}}
/* One-line variant: lay every card in a single shrink-to-fit row (used by the
   Holdings "Portfolio shape" strip so a lone card can't fall to a 2nd row).
   Falls back to wrapping on narrow desktops. */
.inv-kpi-grid--oneline {{
  grid-template-columns: none;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
}}
@media (max-width: 60rem) {{
  .inv-kpi-grid--oneline {{
    grid-auto-flow: row;
    grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
    grid-auto-columns: auto;
  }}
}}
/* Hero variant: the Overview headline band has eight tiles and reads best as a
   tidy 4-by-2 block. ``auto-fit`` would otherwise pack six-plus tiles per row on
   a wide screen and leave everything cramped, so we cap the track count at four
   and step down on narrower viewports. */
.inv-kpi-grid--hero {{
  grid-template-columns: repeat(4, minmax(0, 1fr));
}}
@media (max-width: 64rem) {{
  .inv-kpi-grid--hero {{
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }}
}}
@media (max-width: 48rem) {{
  .inv-kpi-grid--hero {{
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }}
}}
@media (max-width: 30rem) {{
  .inv-kpi-grid--hero {{
    grid-template-columns: 1fr;
  }}
}}
.inv-kpi {{
  background: var(--inv-surface) !important;
  border: 1px solid var(--inv-hairline);
  border-radius: var(--inv-radius-lg);
  box-shadow: var(--inv-shadow-soft);
  padding: 1rem 1.125rem;
  min-width: 0;
  min-height: 7.5rem;
  height: 100%;
  flex: 1 1 13rem;
  display: flex;
  flex-direction: column;
  transition: transform 150ms ease-out, box-shadow 150ms ease-out, border-color 150ms ease-out;
}}
.inv-kpi:hover {{
  border-color: color-mix(in srgb, var(--inv-accent) 40%, var(--inv-hairline));
  box-shadow: 0 4px 12px rgba(11,18,32,.06), 0 1px 2px rgba(11,18,32,.05);
}}
.inv-kpi-label {{
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--inv-muted);
  font-weight: 600;
}}
.inv-kpi-value {{
  /* v3.6.1 — fluid headline so the five-up tiles keep big money figures
     (Portfolio value, Capital gain and the like) on one line in the now
     narrower cards. Scales between a compact and the original size. */
  font-size: clamp(1.2rem, 1.1rem + 0.5vw, 1.6rem);
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--inv-ink);
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1;
}}
.inv-kpi-arrow {{
  font-size: 1.25rem;
  font-weight: 600;
}}
.inv-kpi-sub {{
  font-size: 0.8125rem;
  color: var(--inv-muted);
  margin-top: 4px;
  font-variant-numeric: tabular-nums;
}}
/* v2.5 — dual-currency KPI tiles: stacked EUR and USD equally weighted. */
.inv-kpi-dual-primary {{
  margin-top: 4px;
}}
.inv-kpi-dual-secondary {{
  font-size: clamp(0.95rem, 0.85rem + 0.35vw, 1.15rem);
  font-weight: 600;
  color: var(--inv-ink);
  font-variant-numeric: tabular-nums;
  margin-top: 2px;
  opacity: 0.78;
}}
.inv-kpi-dual-ccy {{
  display: inline-block;
  min-width: 2.4em;
  font-size: 0.72em;
  font-weight: 500;
  color: var(--inv-muted);
  letter-spacing: 0.04em;
}}
.inv-kpi-growth {{
  margin-top: 6px;
  font-size: 0.875rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--inv-muted);
}}

/* ------------------------------------------------------------------ */
/* Calculator plan rows                                                */
/* ------------------------------------------------------------------ */
.inv-plan-amount {{
  display: block;
  font-size: 1.15rem;
  font-weight: 800;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
}}
.inv-plan-amount--member {{
  font-size: 1.02rem;
  font-weight: 700;
}}
.inv-plan-shares {{
  display: block;
  margin-top: 1px;
  font-size: 0.8rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--inv-text, #1f2430);
  opacity: 0.85;
}}
.inv-plan-sub {{
  display: block;
  font-size: 0.74rem;
  font-weight: 500;
  color: var(--inv-muted);
}}

/* ------------------------------------------------------------------ */
/* Chip / pill                                                         */
/* ------------------------------------------------------------------ */
.inv-chip {{
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.75rem;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: var(--inv-radius-pill);
  background: var(--inv-surface-alt);
  color: var(--inv-muted);
  border: 1px solid var(--inv-hairline);
}}
.inv-chip-gain {{ color: var(--inv-gain); background: rgba(0,114,178,.10); border-color: rgba(0,114,178,.20); }}
.inv-chip-loss {{ color: var(--inv-loss); background: rgba(230,159,0,.12); border-color: rgba(230,159,0,.22); }}
.inv-chip-accent {{ color: var(--inv-accent); background: var(--inv-accent-soft); border-color: transparent; }}

/* ------------------------------------------------------------------ */
/* Holding cards (Overview redesign — one web-style box per holding)   */
/* ------------------------------------------------------------------ */
.inv-holding-grid {{
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr));
  gap: 1rem;
  align-items: stretch;
}}
.inv-holding-card {{
  background: var(--inv-surface) !important;
  border: 1px solid var(--inv-hairline);
  border-radius: var(--inv-radius-lg);
  box-shadow: var(--inv-shadow-soft);
  padding: 1rem 1.125rem;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  transition: transform 150ms ease-out, box-shadow 150ms ease-out, border-color 150ms ease-out;
}}
.inv-holding-card:hover {{
  border-color: color-mix(in srgb, var(--inv-accent) 40%, var(--inv-hairline));
  box-shadow: 0 4px 12px rgba(11,18,32,.06), 0 1px 2px rgba(11,18,32,.05);
}}
/* A coloured rail down the left edge, keyed on the holding's total growth. */
.inv-holding-card.inv-holding-gain {{ border-left: 3px solid var(--inv-gain); }}
.inv-holding-card.inv-holding-loss {{ border-left: 3px solid var(--inv-loss); }}
.inv-holding-topline {{
  display: flex; align-items: baseline; flex-wrap: wrap;
  gap: 0.15rem 0.5rem; min-width: 0;
}}
.inv-holding-sym {{
  font-size: 1.05rem; font-weight: 700; letter-spacing: -0.01em;
  color: var(--inv-ink); display: inline-flex; align-items: center;
  flex-wrap: wrap; gap: 6px; min-width: 0;
}}
/* ``margin-left:auto`` keeps the freshness pinned right; ``flex-wrap`` on the
   topline lets it drop to its own right-aligned line on a narrow card instead
   of clipping the longer "… · updated …" string against the symbol/pills. */
.inv-holding-asof {{
  font-size: 0.6875rem; color: var(--inv-muted); text-align: right;
  white-space: nowrap; font-variant-numeric: tabular-nums; margin-left: auto;
}}
.inv-holding-name {{
  font-size: 0.8125rem; color: var(--inv-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}}
.inv-holding-figures {{
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 0.5rem; margin-top: 0.15rem;
}}
.inv-holding-value {{
  font-size: 1.5rem; font-weight: 600; letter-spacing: -0.02em;
  color: var(--inv-ink); font-variant-numeric: tabular-nums; line-height: 1.1;
}}
.inv-holding-value-sub {{
  font-size: 0.8125rem; color: var(--inv-muted);
  font-variant-numeric: tabular-nums; margin-top: 1px;
}}
.inv-holding-change {{
  font-size: 0.95rem; font-weight: 600; font-variant-numeric: tabular-nums;
  white-space: nowrap;
}}
/* The change column stacks the daily % over the daily money move, right-aligned
   so both sit under the headline value's right edge. */
.inv-holding-change-wrap {{
  display: flex; flex-direction: column; align-items: flex-end; gap: 1px;
}}
.inv-holding-change-money {{
  font-size: 0.8125rem; font-weight: 600; font-variant-numeric: tabular-nums;
  white-space: nowrap;
}}
/* A daily move still on an older print than its peers (e.g. a fund yet to strike
   today's NAV) is greyed: it shows last session's move, not today's, so the
   muted colour + softer weight signal "not updated today yet". */
.inv-holding-change-stale {{
  color: var(--inv-muted); font-weight: 500; opacity: 0.7;
}}
/* The detailed statistics grid the user asked to sit below each box. */
.inv-holding-stats {{
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(6.5rem, 1fr));
  gap: 0.5rem 0.75rem;
  margin-top: 0.35rem;
  padding-top: 0.6rem;
  border-top: 1px solid var(--inv-hairline);
}}
.inv-holding-stat {{ display: flex; flex-direction: column; min-width: 0; }}
.inv-holding-stat-label {{
  font-size: 0.625rem; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--inv-muted); font-weight: 600;
}}
.inv-holding-stat-value {{
  font-size: 0.875rem; font-weight: 600; color: var(--inv-ink);
  font-variant-numeric: tabular-nums;
}}
.inv-holding-pill {{
  display: inline-flex; align-items: center; font-size: 0.625rem;
  font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
  padding: 1px 6px; border-radius: var(--inv-radius-pill);
  background: var(--inv-surface-alt); color: var(--inv-muted);
  border: 1px solid var(--inv-hairline);
}}
.inv-holding-pill.inv-holding-pill-warn {{
  color: var(--inv-loss); background: rgba(230,159,0,.12);
  border-color: rgba(230,159,0,.3);
}}

/* ------------------------------------------------------------------ */
/* Today's movers (winners / losers)                                   */
/* ------------------------------------------------------------------ */
/* A distinct "special notice" band that stands apart from the holdings and
   KPI surfaces, laying its winners/losers out as blocks across. */
.inv-movers-band {{
  border-color: color-mix(in srgb, var(--inv-accent) 35%, var(--inv-hairline));
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--inv-accent) 7%, var(--inv-surface)),
      var(--inv-surface));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--inv-accent) 10%, transparent);
}}
.inv-movers-band .inv-section-title::before {{
  content: "\\2605";
  margin-right: 0.4rem;
  color: var(--inv-accent);
}}
.inv-mover-sub {{
  font-size: 0.75rem; color: var(--inv-muted); margin: -0.25rem 0 0.6rem;
}}
.inv-mover-grid {{
  display: grid; grid-template-columns: 1fr; gap: 0.55rem;
}}
@media (min-width: 600px) {{
  .inv-mover-grid {{ grid-template-columns: repeat(2, 1fr); }}
}}
@media (min-width: 1024px) {{
  .inv-mover-grid {{ grid-template-columns: repeat(4, 1fr); }}
}}
.inv-mover-block {{
  display: flex; flex-direction: column; gap: 0.3rem;
  padding: 0.6rem 0.7rem;
  background: var(--inv-surface-alt); border: 1px solid var(--inv-hairline);
  border-left: 3px solid var(--inv-hairline);
  border-radius: var(--inv-radius-md);
  min-width: 0;
}}
.inv-mover-winner {{
  border-left-color: var(--inv-gain);
  background: color-mix(in srgb, var(--inv-gain) 6%, var(--inv-surface-alt));
}}
.inv-mover-loser {{
  border-left-color: var(--inv-loss);
  background: color-mix(in srgb, var(--inv-loss) 6%, var(--inv-surface-alt));
}}
.inv-mover-head {{
  display: flex; align-items: baseline; justify-content: space-between; gap: 0.4rem;
}}
.inv-mover-side {{
  font-size: 0.6875rem; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase;
}}
.inv-mover-winner .inv-mover-side {{ color: var(--inv-gain); }}
.inv-mover-loser .inv-mover-side {{ color: var(--inv-loss); }}
.inv-mover-tag {{
  font-size: 0.625rem; text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--inv-muted);
}}
.inv-mover-id {{ display: flex; flex-direction: column; min-width: 0; }}
.inv-mover-sym {{
  font-weight: 700; font-size: 0.9375rem; color: var(--inv-ink);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}}
.inv-mover-name {{
  font-size: 0.72rem; color: var(--inv-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}}
.inv-mover-figures {{ display: flex; flex-direction: column; }}
/* The stat the block was ranked on leads — large, on top. */
.inv-mover-primary {{
  font-weight: 800; font-size: 1.15rem; line-height: 1.1; font-variant-numeric: tabular-nums;
}}
.inv-mover-secondary {{
  font-size: 0.75rem; color: var(--inv-muted); font-variant-numeric: tabular-nums;
}}
.inv-mover-empty {{ font-size: 0.8125rem; color: var(--inv-muted); padding: 0.2rem 0; }}
/* A compact badge on a holding card that topped today's movers leaderboard.
   It sits on its own right-aligned row (``.inv-holding-badge-row``) just above
   the daily-growth figures, so it never widens the topline and shifts the
   freshness time. */
.inv-holding-badge-row {{
  display: flex; justify-content: flex-end; margin-top: 0.3rem;
}}
.inv-holding-badge {{
  display: inline-block; padding: 0.05rem 0.45rem;
  border-radius: var(--inv-radius-pill);
  font-size: 0.625rem; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase;
  vertical-align: middle;
}}
.inv-holding-badge-gain {{
  color: var(--inv-gain); background: color-mix(in srgb, var(--inv-gain) 14%, transparent);
}}
.inv-holding-badge-loss {{
  color: var(--inv-loss); background: color-mix(in srgb, var(--inv-loss) 14%, transparent);
}}


/* ------------------------------------------------------------------ */
/* Empty state                                                         */
/* ------------------------------------------------------------------ */
.inv-empty {{
  display: flex; flex-direction: column; align-items: center;
  text-align: center;
  padding: 2.5rem 1rem;
  color: var(--inv-muted);
  background: var(--inv-surface-alt);
  border: 1px dashed var(--inv-hairline);
  border-radius: var(--inv-radius-lg);
}}
.inv-empty .q-icon {{
  font-size: 2.5rem;
  color: var(--inv-muted);
  margin-bottom: 0.5rem;
}}
.inv-empty .inv-empty-title {{
  font-size: 1rem;
  font-weight: 600;
  color: var(--inv-ink);
  margin-bottom: 0.25rem;
}}
.inv-empty .inv-empty-hint {{
  font-size: 0.875rem;
  max-width: 32rem;
}}

/* ------------------------------------------------------------------ */
/* AG-Grid overrides — alpine theme, hairline borders, tabular-num     */
/* ------------------------------------------------------------------ */
/* These AG-Grid custom properties must carry ``!important``: NiceGUI loads the
   bundled ``ag-grid.css`` (which declares the same variables on
   ``.ag-theme-alpine`` at equal specificity) *after* this stylesheet, so
   without the flag Alpine's defaults silently win and our font-size / row
   sizing / colours never render. The dark-mode block below relies on the same
   technique. */
.ag-theme-alpine, .ag-theme-balham, .ag-theme-quartz {{
  --ag-foreground-color: var(--inv-ink) !important;
  --ag-data-color: var(--inv-ink) !important;
  --ag-background-color: var(--inv-surface) !important;
  --ag-header-foreground-color: var(--inv-muted) !important;
  /* Distinct, slightly tinted header band so column titles read as a clear
     anchor above the data rather than blending into the first row. */
  --ag-header-background-color: var(--inv-surface-alt) !important;
  /* Zebra striping (v2.8.1): a whisper-soft tint on alternating rows makes
     wide financial tables far easier to scan across without feeling busy. */
  --ag-odd-row-background-color: color-mix(in srgb, var(--inv-surface-alt) 55%, var(--inv-surface)) !important;
  /* Accent-tinted hover so the pointed-at row stands apart from the stripes. */
  --ag-row-hover-color: var(--inv-accent-soft) !important;
  --ag-border-color: var(--inv-hairline) !important;
  --ag-row-border-color: var(--inv-hairline) !important;
  --ag-header-column-separator-color: transparent !important;
  --ag-font-family: "Inter", system-ui, sans-serif !important;
  /* Comfortably large but not oversized table text. The document root is
     20px; v2.8.1 pushed the grid to 18px (with 62px rows) which read far too
     large once the restyle loaded. v2.9.1 brings the data back to a roomy-yet-
     sensible 15px / 44px so a column's numbers and its (wrapping) header both
     fit with breathing room. */
  --ag-font-size: 15px !important;
  --ag-grid-size: 6px !important;
  --ag-row-height: 44px !important;
  --ag-header-height: 46px !important;
  --ag-cell-horizontal-padding: 16px !important;
  --ag-selected-row-background-color: var(--inv-accent-soft) !important;
  --ag-range-selection-border-color: var(--inv-accent);
}}
/* Dark-mode overrides — re-declare AG variables on the dark body so they
   beat any hard-coded light values shipped in the bundled alpine.css. The
   `!important` flag is necessary because Alpine's own selector
   (`.ag-theme-alpine`) has equal specificity to the rule above but is
   loaded after our stylesheet by NiceGUI. */
.body--dark .ag-theme-alpine, html.dark .ag-theme-alpine,
.body--dark .ag-theme-balham, html.dark .ag-theme-balham,
.body--dark .ag-theme-quartz,  html.dark .ag-theme-quartz {{
  --ag-foreground-color: {dark["ink"]} !important;
  --ag-secondary-foreground-color: {dark["muted"]} !important;
  --ag-data-color: {dark["ink"]} !important;
  --ag-background-color: {dark["surface"]} !important;
  --ag-header-foreground-color: {dark["muted"]} !important;
  --ag-header-background-color: {dark["surface_alt"]} !important;
  --ag-odd-row-background-color: {dark["surface_alt"]} !important;
  --ag-row-hover-color: {dark["accent_soft"]} !important;
  --ag-border-color: {dark["hairline"]} !important;
  --ag-row-border-color: {dark["hairline"]} !important;
  --ag-control-panel-background-color: {dark["surface_alt"]} !important;
  --ag-subheader-background-color: {dark["surface_alt"]} !important;
  --ag-input-disabled-background-color: {dark["surface_alt"]} !important;
  --ag-disabled-foreground-color: {dark["muted"]} !important;
  --ag-modal-overlay-background-color: rgba(11,18,32,0.55) !important;
  background: {dark["surface"]} !important;
  color: {dark["ink"]} !important;
}}
.body--dark .ag-root-wrapper, html.dark .ag-root-wrapper {{
  background: {dark["surface"]} !important;
  border-color: {dark["hairline"]} !important;
}}
.body--dark .ag-header, html.dark .ag-header {{
  background: {dark["surface_alt"]} !important;
  color: {dark["muted"]} !important;
  border-bottom-color: {dark["hairline"]} !important;
}}
.body--dark .ag-row, html.dark .ag-row {{
  background: {dark["surface"]} !important;
  color: {dark["ink"]} !important;
  border-color: {dark["hairline"]} !important;
}}
/* Zebra striping in dark mode: AG-Grid's own odd-row variable is shadowed by
   the blanket .ag-row override above, so tint odd rows explicitly. */
.body--dark .ag-row-odd, html.dark .ag-row-odd {{
  background: {dark["surface_alt"]} !important;
}}
.body--dark .ag-row-hover, html.dark .ag-row-hover {{
  background: {dark["accent_soft"]} !important;
}}
.body--dark .ag-pinned-left-cols-container, html.dark .ag-pinned-left-cols-container,
.body--dark .ag-pinned-right-cols-container, html.dark .ag-pinned-right-cols-container,
.body--dark .ag-pinned-left-header, html.dark .ag-pinned-left-header,
.body--dark .ag-pinned-right-header, html.dark .ag-pinned-right-header {{
  background: {dark["surface"]} !important;
}}
.body--dark .ag-paging-panel, html.dark .ag-paging-panel,
.body--dark .ag-status-bar, html.dark .ag-status-bar {{
  background: {dark["surface"]} !important;
  color: {dark["muted"]} !important;
  border-top-color: {dark["hairline"]} !important;
}}
.ag-root-wrapper {{
  border-radius: var(--inv-radius-lg);
  border-color: var(--inv-hairline) !important;
  overflow: hidden;
}}
.ag-header {{
  border-bottom: 2px solid var(--inv-hairline) !important;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  font-size: 12px;
}}
/* The per-row "edit" action cell: a centred pencil that reads as a button. */
.ag-theme-alpine .inv-edit-cell {{
  cursor: pointer;
  text-align: center;
  font-size: 15px;
  user-select: none;
}}
.ag-theme-alpine .inv-edit-cell:hover {{
  background: var(--inv-accent-soft);
}}
/* A touch more breathing room in grid cells so numbers/labels aren't clipped. */
.ag-theme-alpine .ag-cell {{
  padding-left: 14px;
  padding-right: 14px;
}}
/* Let long column titles wrap onto two lines (paired with the grids'
   ``wrapHeaderText`` / ``autoHeaderHeight`` options) instead of being clipped
   with an ellipsis, so headers like "Closing value (EUR)" stay fully readable
   without forcing every column wide (v2.9.1). */
.ag-header-cell-label {{
  width: 100%;
}}
.ag-header-cell-text {{
  white-space: normal;
  line-height: 1.2;
  overflow: visible;
  text-overflow: clip;
}}
/* Vertically centre cell content with comfortable line-height, and give the
   data slightly heavier weight so the taller tables read as crisp, airy and
   modern rather than thin, faint and top-anchored (v2.8.1). */
.ag-theme-alpine .ag-cell {{
  display: flex;
  align-items: center;
  line-height: 1.45;
  font-weight: 500;
}}
.ag-cell[col-id$="_eur"], .ag-cell[col-id$="_usd"], .ag-cell[col-id$="_native"],
.ag-cell[col-id="qty"], .ag-cell[col-id="price"], .ag-cell[col-id="fees"],
.ag-cell[col-id="net"], .ag-cell[col-id="net_eur"], .ag-cell[col-id="net_usd"],
.ag-cell[col-id="shares"], .ag-cell[col-id="avg_price"],
.ag-cell[col-id="current_price"], .ag-cell[col-id="growth_pct"],
.ag-cell[col-id="target_pct"], .ag-cell[col-id="add_shares"] {{
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1;
}}
/* Sign-coloured return cells (colorblind-safe: blue gain / orange loss,
   reinforced by the directional arrow in adjacent KPI cards). Applied via
   AG-Grid ``cellClassRules`` on the overview positions table. */
.ag-cell.inv-cell-pos {{ color: var(--inv-gain); font-weight: 600; }}
.ag-cell.inv-cell-neg {{ color: var(--inv-loss); font-weight: 600; }}
/* Whole-row winner/loser cue: a coloured stripe down the leading edge so the
   overview positions table can be scanned for gainers vs losers at a glance,
   regardless of which column is sorted (paired with AG-Grid ``rowClassRules``
   keyed on total growth in the displayed currency). ``inset`` box-shadow keeps
   the stripe inside the row so it survives horizontal scroll and pinned
   columns. */
.ag-theme-alpine .ag-row.inv-row-gain {{
  box-shadow: inset 4px 0 0 0 var(--inv-gain);
}}
.ag-theme-alpine .ag-row.inv-row-loss {{
  box-shadow: inset 4px 0 0 0 var(--inv-loss);
}}
/* ------------------------------------------------------------------ */
.q-btn {{
  border-radius: var(--inv-radius-md) !important;
  text-transform: none !important;
  font-weight: 500 !important;
  letter-spacing: 0 !important;
  transition: background 150ms ease-out, box-shadow 150ms ease-out, transform 150ms ease-out;
}}
.q-btn.q-btn--flat:hover {{
  background: var(--inv-surface-alt);
}}
.q-btn:focus-visible {{
  outline: 2px solid var(--inv-accent-ring);
  outline-offset: 2px;
}}
.q-field--outlined .q-field__control {{
  border-radius: var(--inv-radius-md);
}}

/* ------------------------------------------------------------------ */
/* Dialogs                                                             */
/* ------------------------------------------------------------------ */
.q-dialog__inner > .q-card {{
  border-radius: var(--inv-radius-xl) !important;
  box-shadow: 0 24px 48px rgba(11,18,32,.18), 0 2px 6px rgba(11,18,32,.10) !important;
  border: 1px solid var(--inv-hairline);
}}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */
.q-notification {{
  border-radius: var(--inv-radius-md) !important;
  box-shadow: var(--inv-shadow-soft) !important;
  font-family: inherit !important;
}}

/* ------------------------------------------------------------------ */
/* Scrollbars                                                          */
/* ------------------------------------------------------------------ */
* {{ scrollbar-width: thin; scrollbar-color: var(--inv-hairline) transparent; }}
*::-webkit-scrollbar {{ width: 10px; height: 10px; }}
*::-webkit-scrollbar-track {{ background: transparent; }}
*::-webkit-scrollbar-thumb {{
  background: var(--inv-hairline);
  border-radius: 8px;
  border: 2px solid transparent;
  background-clip: content-box;
}}
*::-webkit-scrollbar-thumb:hover {{
  background: var(--inv-muted);
  background-clip: content-box;
}}

/* ------------------------------------------------------------------ */
/* Focus rings (a11y)                                                  */
/* ------------------------------------------------------------------ */
a:focus-visible, [tabindex]:focus-visible {{
  outline: 2px solid var(--inv-accent-ring);
  outline-offset: 2px;
  border-radius: 4px;
}}

/* ------------------------------------------------------------------ */
/* Quasar Q-cards inside content — remove default heavy shadow         */
/* ------------------------------------------------------------------ */
.q-card.inv-flat {{
  box-shadow: var(--inv-shadow-soft) !important;
  border: 1px solid var(--inv-hairline);
  border-radius: var(--inv-radius-lg);
  background: var(--inv-surface);
}}

/* Separator hairline */
.q-separator {{
  background: var(--inv-hairline) !important;
}}

/* ------------------------------------------------------------------ */
/* Plotly charts — dark-mode proof axis text                          */
/* ------------------------------------------------------------------ */
/* The figures are rendered server-side with a fixed *light* template
   (``colorblind_modern``), so their ink-coloured axis tick labels,
   titles and legend would vanish against the dark card surface. The
   server can't know the resolved theme at render time (it may be
   "auto" / follow-the-device), so we recolour the SVG text from the
   live theme tokens here instead: ``--inv-muted`` / ``--inv-ink`` /
   ``--inv-hairline`` already flip with ``.body--dark``, making every
   chart legible in light, dark *and* auto modes. Plotly scopes its tick
   classes per axis id (``xtick`` / ``ytick`` only target the primary
   axes), so a coloured secondary axis — e.g. the dual-currency right
   axis whose ``y2tick`` / ``y2title`` text is intentionally pink — keeps
   its own colour. */
.js-plotly-plot .xtick text,
.js-plotly-plot .ytick text {{
  fill: var(--inv-muted) !important;
}}
.js-plotly-plot .gtitle,
.js-plotly-plot .xtitle,
.js-plotly-plot .ytitle,
.js-plotly-plot .infolayer .legendtext {{
  fill: var(--inv-ink) !important;
}}
.js-plotly-plot .gridlayer path,
.js-plotly-plot .zerolinelayer path {{
  stroke: var(--inv-hairline) !important;
}}
"""


#: Inline SVG brand mark used in the header (compact stylised portfolio glyph).
BRAND_SVG: str = """
<svg viewBox="0 0 24 24" width="18" height="18" fill="none"
     xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M3 17l5-5 4 3 8-9" stroke="currentColor" stroke-width="2.2"
        stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="20" cy="6" r="1.6" fill="currentColor"/>
</svg>
""".strip()


def install() -> None:
    """Inject the global CSS and register Plotly templates.

    Idempotent — safe to call once at boot. Adds head HTML that NiceGUI
    will include in every page. Quasar primary colours (which require a
    client context) are applied per-page from
    :func:`investment_dashboard.ui.layout.page_frame`.
    """
    from nicegui import ui  # noqa: PLC0415 - lazy

    # NiceGUI 2.x: ``ui.add_head_html`` defaults to ``shared=False`` which means
    # the snippet is only attached to the auto-index client, *not* to the per-
    # page clients created for ``@ui.page`` routes. Without ``shared=True`` the
    # entire stylesheet below is silently dropped on every real page render,
    # which makes the dashboard fall back to unstyled Quasar defaults (solid
    # blue header, borderless KPI tiles, tiny default fonts, etc.) — i.e. the
    # regression the v1.5 facelift was meant to fix.
    ui.add_head_html(f"<style>{_css()}</style>", shared=True)
    register_plotly_template()


def apply_per_page() -> None:
    """Per-page chrome setup — Quasar primary colours.

    Must be called from within a NiceGUI page handler (it touches the
    active client). Idempotent.
    """
    from nicegui import ui  # noqa: PLC0415 - lazy

    ui.colors(primary=BRAND, secondary=BRAND_HOVER, accent=BRAND)
