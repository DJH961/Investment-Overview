import { Landmark, TriangleAlert, Wallet } from "lucide-react";
import { formatNumber } from "../../lib/format";
import type { TrailKind, TrailOut } from "../../lib/journey-types";
import { useTrail } from "../../lib/queries/journey";
import { Chip } from "../Chip";
import { ErrorState } from "../ErrorState";
import { Money } from "../Money";
import { Skeleton } from "../Skeleton";
import { TrailView } from "./MoneyTrail";

/** The sheet title for a trail: buys look upstream, everything else downstream. */
export function trailTitle(kind: TrailKind, direction?: "to_usd" | "to_eur"): string {
  if (kind === "buy") return "Where these dollars came from";
  if (kind === "conversion" && direction === "to_eur") return "How these dollars came back";
  if (kind === "sell" || kind === "withdrawal") return "Where these dollars went";
  return "Where these dollars went";
}

/** "Your rate" next to the ECB rate of the same days: icon and word, never colour alone. */
export function RatePair({ trail }: { trail: TrailOut }) {
  if (!trail.your_rate && !trail.ecb_rate) return null;
  return (
    <div className="trail-panel__rates">
      {trail.your_rate && (
        <Chip size="sm" outline icon={<Wallet aria-hidden />}>
          Your rate {formatNumber(Number(trail.your_rate), 4)}
        </Chip>
      )}
      {trail.ecb_rate && (
        <Chip size="sm" outline icon={<Landmark aria-hidden />}>
          ECB {formatNumber(Number(trail.ecb_rate), 4)}
        </Chip>
      )}
      {trail.flagged && (
        <Chip size="sm" tone="warn" icon={<TriangleAlert aria-hidden />}>
          Part at the ECB rate
        </Chip>
      )}
    </div>
  );
}

/** Market / currency / conversion cost, and their sum: the gain (or the realized result) in euros. */
export function TrailSplitRows({ trail }: { trail: TrailOut }) {
  const s = trail.split;
  if (!s) return null;
  const realised = trail.kind === "sell" || trail.kind === "withdrawal" || trail.kind === "conversion";
  const rows: [string, string][] = [
    ["Market", s.market_eur],
    ["Currency", s.currency_eur],
    ["Conversion cost", s.conversion_cost_eur],
  ];
  return (
    <dl className="trail-panel__split" aria-label={realised ? "Realized in euros, by part" : "Your gain in euros, by part"}>
      {rows.map(([label, v]) => (
        <div key={label} className="trail-panel__split-row">
          <dt className="trail-panel__split-label">{label}</dt>
          <dd className="trail-panel__split-value">
            <Money amount={Number(v)} currency="EUR" signed colored />
          </dd>
        </div>
      ))}
      <div className="trail-panel__split-row trail-panel__split-row--total">
        <dt className="trail-panel__split-label">{realised ? "Realized in euros" : "Your gain in euros"}</dt>
        <dd className="trail-panel__split-value">
          <Money amount={Number(s.total_eur)} currency="EUR" signed colored />
        </dd>
      </div>
    </dl>
  );
}

/** A trail fetched by kind and id: rate chips, the trail, then the euro split. */
export function TrailPanel({ kind, id, label }: { kind: TrailKind; id: number; label: string }) {
  const q = useTrail(kind, id);
  if (q.isError) return <ErrorState title="The trail could not be loaded" onRetry={() => void q.refetch()} />;
  if (!q.data) {
    return (
      <div className="trail-panel" aria-busy>
        <Skeleton height="1.5rem" width="40%" />
        <Skeleton height="12rem" />
      </div>
    );
  }
  return (
    <div className="trail-panel">
      <RatePair trail={q.data} />
      <TrailView trail={q.data} label={label} />
      <TrailSplitRows trail={q.data} />
    </div>
  );
}
