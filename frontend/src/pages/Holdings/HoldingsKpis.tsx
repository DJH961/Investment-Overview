import type { ReactNode } from "react";
import { Skeleton } from "../../components/Skeleton";
import { Money } from "../../components/Money";
import { Percent } from "../../components/Percent";
import { formatStamp } from "../../components/Freshness";
import { formatNumber } from "../../lib/format";
import type { HoldingsDto } from "../../lib/queries/holdings";
import { toNum } from "../../lib/queries/portfolio";

interface Props {
  /** Undefined while loading. */
  data: HoldingsDto | undefined;
  currency: string;
}

/** "as of today 14:05" for a live spot, "EOD · yesterday" for a settled fixing. */
function fxStamp(fx: NonNullable<HoldingsDto["fx"]>): string | undefined {
  if (fx.source === "live" && fx.observed_at) return `as of ${formatStamp(fx.observed_at)}`;
  if (fx.as_of) return `EOD · ${formatStamp(fx.as_of)}`;
  return undefined;
}

interface Stat {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}

/**
 * The portfolio summary above the table as one compact strip of at most two
 * lines (7 columns x 2 rows; narrower screens scroll it sideways), so the
 * positions start high on the page. Every stat renders in both currencies
 * (the FX stat falls back to EUR/USD), so a currency switch never reflows it.
 */
export function HoldingsKpis({ data, currency }: Props) {
  const loading = data === undefined;
  const s = data?.summary;
  const fx = data?.fx;
  const stats: Stat[] = [
    { label: "Total value", value: <Money amount={toNum(data?.total_value)} currency={currency} /> },
    {
      label: "Total return",
      value: <Money amount={toNum(data?.total_return)} currency={currency} signed colored />,
      hint: "incl. dividends",
    },
    {
      label: "Capital gain",
      value: <Money amount={toNum(data?.total_capital_gain)} currency={currency} signed colored />,
      hint: "excl. dividends",
    },
    { label: "Total growth", value: <Percent ratio={toNum(data?.total_growth)} signed colored />, hint: "compounded" },
    { label: "XIRR", value: <Percent ratio={toNum(data?.xirr)} signed colored />, hint: "per year" },
    { label: "Up / down today", value: `${s?.gainers ?? 0} / ${s?.losers ?? 0}`, hint: "holdings" },
    {
      label: "Dividend return",
      value: <Percent ratio={toNum(data?.dividend_yield_pct)} />,
      hint: (
        <>
          <Money amount={toNum(data?.dividend_income)} currency={currency} digits={0} /> lifetime
        </>
      ),
    },
    {
      label: "Yield (TTM)",
      value: <Percent ratio={toNum(data?.dividend_yield_ttm_pct)} />,
      hint: (
        <>
          <Money amount={toNum(data?.dividends_ttm)} currency={currency} digits={0} /> 12 mo
        </>
      ),
    },
    {
      label: "Weighted fee",
      value: <Percent ratio={toNum(data?.weighted_expense_ratio)} digits={2} />,
      hint: (
        <>
          <Money amount={toNum(data?.annual_expense_cost)} currency={currency} digits={0} /> / yr
        </>
      ),
    },
    fx
      ? {
          label: `FX ${fx.pair}`,
          value: (
            <>
              {formatNumber(toNum(fx.spot), 4)}
              {fx.move_pct && (
                <span className="holdings-page__stat-delta">
                  <Percent ratio={toNum(fx.move_pct)} signed colored digits={2} />
                </span>
              )}
            </>
          ),
          hint: fxStamp(fx),
        }
      : { label: "FX EUR/USD", value: formatNumber(toNum(data?.fx_eur_usd), 4), hint: "all holdings in USD" },
    {
      label: "Best",
      value: s?.best_symbol ?? "–",
      hint: s?.best_symbol ? <Percent ratio={toNum(s.best_growth)} signed colored /> : undefined,
    },
    {
      label: "Worst",
      value: s?.worst_symbol ?? "–",
      hint: s?.worst_symbol ? <Percent ratio={toNum(s.worst_growth)} signed colored /> : undefined,
    },
    {
      label: "Largest",
      value: s?.most_concentrated_symbol ?? "–",
      hint: s?.most_concentrated_symbol ? (
        <>
          <Percent ratio={toNum(s.most_concentrated_weight_pct)} digits={1} /> of value
        </>
      ) : undefined,
    },
    { label: "In profit / loss", value: `${s?.in_profit ?? 0} / ${s?.in_loss ?? 0}`, hint: "since buying" },
  ];
  return (
    <dl className="holdings-page__stats" aria-label="Portfolio summary">
      {stats.map((st) => (
        <div key={st.label} className="holdings-page__stat">
          <dt className="holdings-page__stat-label">{st.label}</dt>
          <dd className="holdings-page__stat-value">{loading ? <Skeleton height="1.1rem" width="70%" /> : st.value}</dd>
          <dd className="holdings-page__stat-hint">{loading ? null : (st.hint ?? " ")}</dd>
        </div>
      ))}
    </dl>
  );
}
