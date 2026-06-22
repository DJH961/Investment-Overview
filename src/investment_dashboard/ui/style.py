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
  #inv-refreshbar.is-active {{ animation: none; }}
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
