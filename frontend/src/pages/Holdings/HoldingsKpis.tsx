import { KpiTile } from "../../components/KpiTile";
import { Money } from "../../components/Money";
import { Percent } from "../../components/Percent";
import { formatDate, formatNumber, formatTime } from "../../lib/format";
import type { HoldingsDto } from "../../lib/queries/holdings";
import { toNum } from "../../lib/queries/portfolio";

interface Props {
  /** Undefined while loading. */
  data: HoldingsDto | undefined;
  currency: string;
}

/** "as of 14:05" for a live spot, "EOD · 30 Oct 2026" for a settled fixing. */
function fxStamp(fx: NonNullable<HoldingsDto["fx"]>): string | undefined {
  if (fx.source === "live" && fx.observed_at) return `as of ${formatTime(fx.observed_at)}`;
  if (fx.as_of) return `EOD · ${formatDate(fx.as_of, "short")}`;
  return undefined;
}

/** Headline tiles: returns, income and cost, then the shape of the portfolio. */
export function HoldingsKpis({ data, currency }: Props) {
  const loading = data === undefined;
  const s = data?.summary;
  const fx = data?.fx;
  return (
    <div className="holdings-page__kpis" aria-label="Portfolio summary">
      <div className="holdings-page__kpi-row">
        <KpiTile
          label="Total value"
          loading={loading}
          value={<Money amount={toNum(data?.total_value)} currency={currency} />}
        />
        <KpiTile
          label="Total growth"
          loading={loading}
          value={<Percent ratio={toNum(data?.total_growth)} signed colored />}
          hint="compounded"
        />
        <KpiTile label="XIRR" loading={loading} value={<Percent ratio={toNum(data?.xirr)} signed colored />} />
        <KpiTile
          label="Capital gain"
          loading={loading}
          value={<Money amount={toNum(data?.total_capital_gain)} currency={currency} signed colored />}
          hint="excl. dividends"
        />
        <KpiTile
          label="Total return"
          loading={loading}
          value={<Money amount={toNum(data?.total_return)} currency={currency} signed colored />}
          hint="incl. dividends"
        />
      </div>
      <div className="holdings-page__kpi-row">
        <KpiTile
          label="Dividend return"
          loading={loading}
          value={<Percent ratio={toNum(data?.dividend_yield_pct)} />}
          hint={
            <>
              <Money amount={toNum(data?.dividend_income)} currency={currency} /> lifetime
            </>
          }
        />
        <KpiTile
          label="Dividend yield (TTM)"
          loading={loading}
          value={<Percent ratio={toNum(data?.dividend_yield_ttm_pct)} />}
          hint={
            <>
              <Money amount={toNum(data?.dividends_ttm)} currency={currency} /> last 12 mo
            </>
          }
        />
        <KpiTile
          label="Weighted expense"
          loading={loading}
          value={<Percent ratio={toNum(data?.weighted_expense_ratio)} digits={2} />}
          hint={
            <>
              <Money amount={toNum(data?.annual_expense_cost)} currency={currency} /> / yr
            </>
          }
        />
        {(loading || fx) && (
          <KpiTile
            label={fx ? `Current FX (${fx.pair})` : "Current FX"}
            loading={loading}
            value={formatNumber(toNum(fx?.spot), 4)}
            delta={fx?.move_pct ? <Percent ratio={toNum(fx.move_pct)} signed colored digits={2} /> : undefined}
            hint={fx ? fxStamp(fx) : undefined}
          />
        )}
      </div>
      <div className="holdings-page__kpi-row">
        <KpiTile
          label="In profit / loss"
          loading={loading}
          value={`${s?.in_profit ?? 0} / ${s?.in_loss ?? 0}`}
        />
        <KpiTile label="Up / down today" loading={loading} value={`${s?.gainers ?? 0} / ${s?.losers ?? 0}`} />
        <KpiTile
          label="Best"
          loading={loading}
          value={s?.best_symbol ?? "–"}
          delta={s?.best_symbol ? <Percent ratio={toNum(s.best_growth)} signed colored /> : undefined}
        />
        <KpiTile
          label="Worst"
          loading={loading}
          value={s?.worst_symbol ?? "–"}
          delta={s?.worst_symbol ? <Percent ratio={toNum(s.worst_growth)} signed colored /> : undefined}
        />
        <KpiTile
          label="Most concentrated"
          loading={loading}
          value={s?.most_concentrated_symbol ?? "–"}
          delta={
            s?.most_concentrated_symbol ? <Percent ratio={toNum(s.most_concentrated_weight_pct)} digits={1} /> : undefined
          }
        />
      </div>
    </div>
  );
}
