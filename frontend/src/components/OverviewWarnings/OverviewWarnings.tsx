import { AlertTriangle } from "lucide-react";
import { Link } from "react-router";
import type { OverviewDto } from "../../lib/queries/portfolio";
import "./OverviewWarnings.scss";

export interface OverviewWarningsProps {
  warnings: OverviewDto["warnings"];
}

/** Data-quality banner above the Overview KPIs (renders nothing when all is well). */
export function OverviewWarnings({ warnings }: OverviewWarningsProps) {
  // `tab` is the Health & Repair tab that holds the fix for each kind of warning.
  const items: { text: string; tab: "health" | "repair" | "market" }[] = [];
  if (warnings.zero_value.length) items.push({ text: `No value for ${warnings.zero_value.join(", ")}`, tab: "health" });
  if (warnings.bad_history.length)
    items.push({ text: `Suspect price history for ${warnings.bad_history.join(", ")}`, tab: "market" });
  if (warnings.missing_fx.length)
    items.push({ text: `Missing FX rate for ${warnings.missing_fx.join(", ")}`, tab: "repair" });
  if (items.length === 0) return null;
  return (
    <div className="overview-warnings" role="alert">
      <AlertTriangle aria-hidden className="overview-warnings__icon" />
      <ul className="overview-warnings__list">
        {items.map((i) => (
          <li key={i.text} className="overview-warnings__item">
            <span className="overview-warnings__text">{i.text}</span>
            <Link className="overview-warnings__fix" to={`/diagnostics?tab=${i.tab}`}>
              Fix in Health &amp; Repair
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
