"""Global CSS + Quasar primary-color setup for the v1.5 "neo-fintech" chrome.

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
.inv-kpi {{
  background: var(--inv-surface) !important;
  border: 1px solid var(--inv-hairline);
  border-radius: var(--inv-radius-lg);
  box-shadow: var(--inv-shadow-soft);
  padding: 1rem 1.125rem;
  min-width: 13rem;
  flex: 1 1 13rem;
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
  font-size: 1.75rem;
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
.ag-theme-alpine, .ag-theme-balham, .ag-theme-quartz {{
  --ag-foreground-color: var(--inv-ink);
  --ag-background-color: var(--inv-surface);
  --ag-header-foreground-color: var(--inv-muted);
  --ag-header-background-color: var(--inv-surface);
  --ag-odd-row-background-color: var(--inv-surface);
  --ag-row-hover-color: var(--inv-surface-alt);
  --ag-border-color: var(--inv-hairline);
  --ag-row-border-color: var(--inv-hairline);
  --ag-header-column-separator-color: transparent;
  --ag-font-family: "Inter", system-ui, sans-serif;
  --ag-font-size: 13px;
  --ag-grid-size: 6px;
  --ag-row-height: 36px;
  --ag-header-height: 40px;
  --ag-cell-horizontal-padding: 12px;
  --ag-selected-row-background-color: var(--inv-accent-soft);
  --ag-range-selection-border-color: var(--inv-accent);
}}
.ag-root-wrapper {{
  border-radius: var(--inv-radius-lg);
  border-color: var(--inv-hairline) !important;
  overflow: hidden;
}}
.ag-header {{
  border-bottom: 1px solid var(--inv-hairline) !important;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  font-size: 11px;
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

/* ------------------------------------------------------------------ */
/* Buttons / inputs                                                    */
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
