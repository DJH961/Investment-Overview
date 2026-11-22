import type { ComponentType } from "react";
import type { ReportingCurrency } from "../../lib/prefs";
import type { CurrencyRange } from "./range";
import { Dollar } from "./sections/Dollar";
import { Impact, ImpactHoldings } from "./sections/Impact";
import { WhatIf } from "./sections/WhatIf";

/**
 * The Currency page's section registry (v7.2 contract with 7.3, `docs/v7_contracts.md`).
 * The sticky section bar, load-on-scroll and the `/currency/:sub` sub-page routes all
 * read this list, in this order, under the rate chart and the strip. A new section is
 * one entry here plus its folder under `sections/`; render it with the shell
 * `components/CurrencySection` so every section looks and behaves the same.
 */

/** What every section gets from the page. */
export interface CurrencySectionComponentProps {
  /** The registry id: the section's anchor (`<CurrencySection id={id}>`). */
  id: string;
  /** The registry label: the section's title. */
  label: string;
  currency: ReportingCurrency;
  /** The page range (rate chart picker). A section without a range ignores it. */
  range: CurrencyRange;
}

/** What a sub-page gets: the same, without the anchor. */
export interface CurrencySubPageProps {
  currency: ReportingCurrency;
  range: CurrencyRange;
}

/** A full list behind a section's "Show all →", at `/currency/<id>`. */
export interface CurrencySubPage {
  /** URL segment: `/currency/<id>`. Unique across all sections. */
  id: string;
  /** Page title ("Currency effect per holding"). */
  label: string;
  /** Title in the USD view (the investing side), when it lists something else. */
  usdLabel?: string;
  Component: ComponentType<CurrencySubPageProps>;
  /** Shows the range picker at the top of the sub-page. */
  ranged?: boolean;
}

export interface CurrencySectionDef {
  /** Anchor and section-bar target (`/currency#<id>`). */
  id: string;
  /** Section-bar chip and section title. */
  label: string;
  Component: ComponentType<CurrencySectionComponentProps>;
  subPages?: CurrencySubPage[];
}

export const CURRENCY_SECTIONS: CurrencySectionDef[] = [
  {
    id: "impact",
    label: "Impact",
    Component: Impact,
    subPages: [
      {
        id: "holdings",
        label: "Currency effect per holding",
        usdLabel: "Currency effect per deposit",
        Component: ImpactHoldings,
        ranged: true,
      },
    ],
  },
  // Your dollars as a position: what you hold, the rate you paid, the trend.
  { id: "exposure", label: "Exposure", Component: Dollar },
  // Today's holdings valued at other rates: slider, stress table, cushion.
  { id: "scenarios", label: "Scenarios", Component: WhatIf },
  // 7.3 adds { id: "conversions", label: "Conversions", ... } here.
];

/** The sub-page for `/currency/<sub>`, if any section declares it. */
export function findSubPage(sub: string | undefined): { section: CurrencySectionDef; page: CurrencySubPage } | null {
  if (!sub) return null;
  for (const section of CURRENCY_SECTIONS) {
    const page = section.subPages?.find((p) => p.id === sub);
    if (page) return { section, page };
  }
  return null;
}
