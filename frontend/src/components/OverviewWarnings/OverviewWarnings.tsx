import { AlertTriangle } from "lucide-react";
import type { OverviewDto } from "../../lib/queries/portfolio";
import "./OverviewWarnings.scss";

export interface OverviewWarningsProps {
  warnings: OverviewDto["warnings"];
}

/** Data-quality banner above the Overview KPIs (renders nothing when all is well). */
export function OverviewWarnings({ warnings }: OverviewWarningsProps) {
  const items: string[] = [];
  if (warnings.zero_value.length) items.push(`No value for ${warnings.zero_value.join(", ")}`);
  if (warnings.bad_history.length) items.push(`Suspect price history for ${warnings.bad_history.join(", ")}`);
  if (warnings.missing_fx.length) items.push(`Missing FX rate for ${warnings.missing_fx.join(", ")}`);
  if (items.length === 0) return null;
  return (
    <div className="overview-warnings" role="alert">
      <AlertTriangle aria-hidden size={16} />
      <ul className="overview-warnings__list">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}
