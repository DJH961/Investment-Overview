import { DeltaBadge } from "../DeltaBadge";
import { KpiTile } from "../KpiTile";
import { Money } from "../Money";
import { Percent } from "../Percent";
import { formatDate, formatMoney, formatPercent } from "../../lib/format";
import { toNum, type OverviewDto } from "../../lib/queries/portfolio";
import type { ReportingCurrency } from "../../lib/prefs";
import "./KpiGrid.scss";

export interface KpiGridProps {
  /** Undefined while loading. */
  data: OverviewDto | undefined;
  /** Reporting currency. */
  currency: ReportingCurrency;
  loading: boolean;
}

/** The Overview headline tiles: value, today, gains, XIRR, currency effect. */
export function KpiGrid({ data, currency, loading }: KpiGridProps) {
  const k = data?.kpis;
  const split = data?.currency.return_split;
  return (
    <div className="kpi-grid">
      <KpiTile
        label="Portfolio value"
        loading={loading}
        value={<Money amount={toNum(k?.total_value)} currency={currency} />}
      />
      <KpiTile
        label="Today"
        loading={loading}
        value={<Money amount={toNum(k?.daily_move)} currency={currency} signed colored />}
        delta={<DeltaBadge value={toNum(k?.daily_growth_pct)} />}
        hint={k?.daily_growth_as_of ? `as of ${formatDate(k.daily_growth_as_of)}` : undefined}
      />
      <KpiTile
        label="Capital gain (excl. dividends)"
        loading={loading}
        value={<Money amount={toNum(k?.capital_gain)} currency={currency} signed colored />}
        hint={
          k?.total_invested ? `of ${formatMoney(toNum(k.total_invested), currency, { compact: true })} invested` : undefined
        }
      />
      <KpiTile
        label="Total return (incl. dividends)"
        loading={loading}
        value={<Money amount={toNum(k?.total_return)} currency={currency} signed colored />}
        delta={<DeltaBadge value={toNum(k?.total_growth_compounded)} />}
      />
      <KpiTile
        label="XIRR"
        loading={loading}
        value={<Percent ratio={toNum(k?.xirr)} signed colored />}
        hint={k?.ytd_xirr ? `YTD ${formatPercent(toNum(k.ytd_xirr), { signed: true })}` : undefined}
      />
      <KpiTile
        label="Currency effect"
        loading={loading}
        value={<Percent ratio={toNum(split?.currency_effect_pp)} signed colored />}
        hint={
          split?.investment_return == null
            ? undefined
            : `Investment ${formatPercent(toNum(split.investment_return), { signed: true })}`
        }
      />
    </div>
  );
}
