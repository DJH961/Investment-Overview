/* The dash must be focusable so keyboard users can reach its explanation. */
/* oxlint-disable jsx-a11y/no-noninteractive-tabindex */
import type { ReactNode } from "react";
import { Tooltip } from "../../components/Tooltip";
import type { ReportingCurrency } from "../../lib/prefs";

export function missingReason(ccy: ReportingCurrency): string {
  return ccy === "USD"
    ? "Not available in USD: this figure is only computed from the EUR cashflow stream."
    : "Not available yet: there is not enough history to compute this figure.";
}

/** Renders `children` when `present`, else an em dash with an explanatory tooltip. */
export function Maybe({ present, ccy, children }: { present: boolean; ccy: ReportingCurrency; children: ReactNode }) {
  if (present) return <>{children}</>;
  return (
    <Tooltip content={missingReason(ccy)}>
      <span tabIndex={0}>
        —
      </span>
    </Tooltip>
  );
}
