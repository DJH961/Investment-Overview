import { ArrowDownRight, ArrowUpDown, ArrowUpRight, Minus } from "lucide-react";
import type { ReactNode } from "react";
import { Money } from "../Money";
import type { StatItem } from "../StatStrip";
import { formatNumber, formatPercent, formatPp } from "../../lib/format";
import { toNum } from "../../lib/queries/portfolio";

/**
 * One server figure for a strip (`CurrencyStat` and any section stat of that shape):
 * the value, its unit and currency as the server sent them. The client only formats.
 */
export interface ServerStat {
  key: string;
  value: string;
  unit: "rate" | "fraction" | "money";
  currency?: string | null;
  secondary?: string | null;
  secondary_unit?: "rate" | "fraction" | "money" | null;
  secondary_currency?: string | null;
  kind?: "tailwind" | "headwind" | "neutral" | null;
}

/** The words for a figure: label, one-sentence tip, and a lead for its note ("now"). */
export interface StatMeta {
  label: string;
  tip?: string;
  noteLead?: string;
  fractionFormat?: "percent" | "pp";
}

const KIND_WORD = { tailwind: "Tailwind", headwind: "Headwind", neutral: "Neutral", mixed: "Mixed" } as const;
const KIND_ICON = { tailwind: ArrowUpRight, headwind: ArrowDownRight, neutral: Minus, mixed: ArrowUpDown } as const;

export function statFigure(
  unit: string | null | undefined,
  value: string | null | undefined,
  ccy: string | null | undefined,
  fallbackCcy: string,
  fractionFormat: "percent" | "pp" = "pp",
): ReactNode {
  const n = toNum(value ?? null);
  if (unit === "rate") return formatNumber(n, 4);
  // The Currency page's one rule: percents and points signed, with one digit.
  if (unit === "fraction") return fractionFormat === "percent" ? formatPercent(n, { signed: true, digits: 1 }) : formatPp(n, 1);
  // Whole units: cents on a currency effect are noise (and crowd a phone row).
  return <Money amount={n} currency={ccy ?? fallbackCcy} signed colored digits={0} />;
}

/** Tailwind / headwind as an arrow and a word, never color alone. */
/**
 * Tailwind / headwind / neutral / mixed: an arrow plus the word (never color alone).
 * `compact`: on phones only the arrow shows, the word stays for screen readers and as
 * the hover title.
 */
export function KindTag({ kind, compact = false }: { kind: "tailwind" | "headwind" | "neutral" | "mixed"; compact?: boolean }) {
  const Icon = KIND_ICON[kind];
  return (
    <span
      className={`currency-stat__kind currency-stat__kind--${kind}${compact ? " currency-stat__kind--compact" : ""}`}
      title={compact ? KIND_WORD[kind] : undefined}
    >
      <Icon aria-hidden className="currency-stat__kind-icon" />
      <span className="currency-stat__kind-word">{KIND_WORD[kind]}</span>
    </span>
  );
}

export function serverStatItem(s: ServerStat, meta: StatMeta | undefined, fallbackCcy: string): StatItem {
  const m = meta ?? { label: s.key };
  const kind = s.kind ?? null;
  const secondary = s.secondary
    ? statFigure(s.secondary_unit, s.secondary, s.secondary_currency ?? s.currency, fallbackCcy, m.fractionFormat)
    : null;
  return {
    key: s.key,
    label: m.label,
    tip: m.tip || undefined,
    value: statFigure(s.unit, s.value, s.currency, fallbackCcy, m.fractionFormat),
    note:
      kind || secondary ? (
        <span className="currency-stat__note">
          {kind ? <KindTag kind={kind} /> : null}
          {secondary ? (
            <span>
              {m.noteLead ? `${m.noteLead} ` : ""}
              {secondary}
            </span>
          ) : null}
        </span>
      ) : undefined,
  };
}
