import clsx from "clsx";
import { InfoTip } from "../InfoTip";
import { KpiTile } from "../KpiTile";
import { Money } from "../Money";
import { Percent } from "../Percent";
import { formatPercent } from "../../lib/format";
import { toNum, type OverviewDto } from "../../lib/queries/portfolio";
import type { ReportingCurrency } from "../../lib/prefs";
import "./KpiGrid.scss";

type Kpis = OverviewDto["kpis"];
type Verdict = OverviewDto["market_verdict"];

export interface KpiGridProps {
  /** Undefined while loading. */
  data: OverviewDto | undefined;
  /** Reporting currency. */
  currency: ReportingCurrency;
  loading: boolean;
}

/** Copy for the info buttons (NiceGUI `ui/copy/tooltips.py` wording, shortened). */
const STRIP_TIPS = {
  expense:
    "Weighted average yearly fund fee (TER) across your holdings, and roughly what that costs per year at today's value.",
  dividendReturn: "All dividends received since you started, as a share of the money you invested.",
  yield12:
    "Dividends received in the last 12 months as a share of today's portfolio value: your current income yield.",
};

export const KPI_TIPS = {
  invested: "Money put in minus money taken out, each at its own day's exchange rate.",
  totalReturn:
    "What the portfolio has earned in money: current value + cash dividends received − net invested. Reinvested dividends are in the value, so every dividend counts once. Holdings splits it into capital gain and dividends.",
  dividendIncome:
    "All dividends and interest received since the start, cash and reinvested. Part of Total return (the rest is the price gain, shown as Capital gain on Holdings).",
  xirr: "Money-weighted annual return: accounts for when each deposit and withdrawal happened.",
  vsMarket: "Your compounded growth versus the benchmark over the same cashflows.",
  totalGrowth: "Compounded growth since the first purchase: (1 + XIRR)^years − 1.",
  ytd: "Growth since 1 January, adjusted for deposits and withdrawals.",
  mtd: "Growth since the first of this month, adjusted for deposits and withdrawals.",
} as const;

function VsMarket({ verdict }: { verdict: Verdict | undefined }) {
  if (!verdict || verdict.beating === null || verdict.beating === undefined) {
    return <span className="kpi-grid__verdict">Need {verdict?.benchmark_symbol ?? "benchmark"} history</span>;
  }
  return (
    <span className={clsx("kpi-grid__verdict", verdict.beating ? "kpi-grid__verdict--pos" : "kpi-grid__verdict--neg")}>
      {verdict.beating ? "Beating" : "Trailing"}
    </span>
  );
}

/**
 * The Overview KPI grid (NiceGUI's set plus v6's total return): every tile shows
 * the reporting currency large and the other currency under it (`kpis_secondary`,
 * computed in that currency, never converted). Today lives in the hero.
 */
export function KpiGrid({ data, currency, loading }: KpiGridProps) {
  const k: Kpis | undefined = data?.kpis;
  const k2: Kpis | undefined = data?.kpis_secondary;
  const ccy2 = data?.secondary_ccy ?? (currency === "EUR" ? "USD" : "EUR");
  const money = (v: string | null | undefined, signed = false) => (
    <Money amount={toNum(v)} currency={currency} signed={signed} colored={signed} />
  );
  const money2 = (v: string | null | undefined, signed = false) =>
    k2 ? <Money amount={toNum(v)} currency={ccy2} signed={signed} /> : undefined;
  const pct = (v: string | null | undefined) => <Percent ratio={toNum(v)} signed colored />;
  const pct2 = (v: string | null | undefined) =>
    k2 ? (
      <span>
        <Percent ratio={toNum(v)} signed /> in {ccy2}
      </span>
    ) : undefined;
  const v = data?.market_verdict;

  const expense = toNum(k?.weighted_expense_ratio);
  const ttm = toNum(k?.dividends_ttm);

  return (
    <div className="kpi-grid">
      <div className="kpi-grid__tiles">
        <KpiTile
          label="Invested"
          tooltip={KPI_TIPS.invested}
          loading={loading}
          value={money(k?.total_invested)}
          secondary={money2(k2?.total_invested)}
        />
        <KpiTile
          label="Total return"
          tooltip={KPI_TIPS.totalReturn}
          loading={loading}
          value={money(k?.total_return, true)}
          secondary={money2(k2?.total_return, true)}
        />
        <KpiTile
          label="XIRR"
          tooltip={KPI_TIPS.xirr}
          loading={loading}
          value={pct(k?.xirr)}
          secondary={pct2(k2?.xirr)}
          hint={k?.ytd_xirr ? `YTD ${formatPercent(toNum(k.ytd_xirr), { signed: true })}` : undefined}
        />
        <KpiTile
          label="Vs market"
          tooltip={KPI_TIPS.vsMarket}
          loading={loading}
          value={<VsMarket verdict={v} />}
          hint={
            v && v.portfolio_return != null && v.benchmark_return != null ? (
              // One comparison per line, aligned: "You +76.86%" over "VT +79.06%".
              <span className="kpi-grid__vs">
                <span className="kpi-grid__vs-row">
                  <span className="kpi-grid__vs-who">You</span>
                  <Percent ratio={toNum(v.portfolio_return)} signed />
                </span>
                <span className="kpi-grid__vs-row">
                  <span className="kpi-grid__vs-who">{v.benchmark_symbol}</span>
                  <Percent ratio={toNum(v.benchmark_return)} signed />
                </span>
              </span>
            ) : undefined
          }
        />
        <KpiTile
          label="Total growth"
          tooltip={KPI_TIPS.totalGrowth}
          loading={loading}
          value={pct(k?.total_growth_compounded)}
          secondary={pct2(k2?.total_growth_compounded)}
        />
        <KpiTile
          label="YTD"
          tooltip={KPI_TIPS.ytd}
          loading={loading}
          value={pct(k?.ytd_growth)}
          secondary={pct2(k2?.ytd_growth)}
        />
        <KpiTile
          label="MTD"
          tooltip={KPI_TIPS.mtd}
          loading={loading}
          value={pct(k?.mtd_growth)}
          secondary={pct2(k2?.mtd_growth)}
        />
        <KpiTile
          label="Dividend income"
          tooltip={KPI_TIPS.dividendIncome}
          loading={loading}
          value={money(k?.dividend_income)}
          secondary={money2(k2?.dividend_income)}
        />
      </div>
      {!loading && k && (
        <dl className="kpi-grid__strip">
          <div className="kpi-grid__stat">
            <dt className="kpi-grid__stat-label">
              Expense ratio
              <InfoTip label="Expense ratio" content={STRIP_TIPS.expense} />
            </dt>
            <dd className="kpi-grid__stat-value">
              <Percent ratio={expense} />
              {k.annual_expense_cost != null && (
                <span className="kpi-grid__stat-sub">
                  ≈ <Money amount={toNum(k.annual_expense_cost)} currency={currency} digits={0} />
                  /yr
                </span>
              )}
            </dd>
          </div>
          <div className="kpi-grid__stat">
            <dt className="kpi-grid__stat-label">
              Dividend return
              <InfoTip label="Dividend return" content={STRIP_TIPS.dividendReturn} />
            </dt>
            <dd className="kpi-grid__stat-value">
              <Percent ratio={toNum(k.dividend_yield_pct)} />
              {k.dividend_income != null && (
                <span className="kpi-grid__stat-sub">
                  <Money amount={toNum(k.dividend_income)} currency={currency} digits={0} /> received
                </span>
              )}
            </dd>
          </div>
          <div className="kpi-grid__stat">
            <dt className="kpi-grid__stat-label">
              Dividend yield, 12 mo
              <InfoTip label="Dividend yield, 12 months" content={STRIP_TIPS.yield12} />
            </dt>
            <dd className="kpi-grid__stat-value">
              <Percent ratio={toNum(k.dividend_yield_ttm_pct)} />
              {ttm !== null && (
                <span className="kpi-grid__stat-sub">
                  <Money amount={ttm} currency={currency} digits={0} /> paid
                </span>
              )}
            </dd>
          </div>
        </dl>
      )}
    </div>
  );
}
