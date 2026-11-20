import clsx from "clsx";
import type { ReactNode } from "react";
import { InfoTip } from "../InfoTip";
import { KpiTile } from "../KpiTile";
import { Money } from "../Money";
import { Percent } from "../Percent";
import { formatPp } from "../../lib/format";
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
    "Weighted average yearly fund fee (TER) across your holdings.",
  dividendReturn: "All dividends received since you started, as a share of the money you invested.",
  yield12:
    "Dividends received in the last 12 months as a share of today's portfolio value: your current income yield.",
};

export const KPI_TIPS = {
  dayMove:
    "Change since the previous close: prices and currency together, the same Total as the headline. " +
    "Its ☀ day and ☾ night parts sit under the portfolio value.",
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

  // Total growth in EUR = the investment's own (USD) return + what the currency did, both server figures
  // (`currency.return_split`, never computed here). The currency share is always shown, so the tile explains
  // why EUR growth differs from the dollar figure. The USD view has the same two lines (the EUR growth next to
  // the same currency gap, `eur_minus_usd_pp`), so a currency switch never changes the tile's shape.
  const split = data?.currency?.return_split;
  const usdView = currency === "USD";
  const fxPp = toNum((usdView ? split?.eur_minus_usd_pp : split?.currency_effect_pp) ?? null);
  const firstLine = usdView ? toNum(k2?.total_growth_compounded) : (toNum(split?.investment_return ?? null) ?? toNum(k2?.total_growth_compounded));
  const growthSecondary =
    fxPp !== null && firstLine !== null ? (
      <span className="kpi-grid__growth-split" data-testid="growth-split">
        <span>
          {/* Worded like the other tiles' second line ("+8.10% in EUR"). */}
          {usdView ? (
            <>
              <Percent ratio={firstLine} signed /> in EUR
            </>
          ) : (
            <>
              Investment <Percent ratio={firstLine} signed />
            </>
          )}
        </span>
        <span>Currency {formatPp(fxPp)}</span>
      </span>
    ) : (
      pct2(k2?.total_growth_compounded)
    );

  // The day Total, from the server (`day_split.price_move`; the field name is
  // historical): always the headline change, live while the market is open and
  // frozen at the close afterwards. `currency_move` is the exchange-rate figure:
  // inside the Total while open, tonight's move beside it while shut.
  const ds = data?.day_split ?? null;
  const priceMove = ds ? ds.price_move : k?.daily_move;
  const priceMove2 = ds ? ds.price_move_secondary : k2?.daily_move;
  // No ☀/☾ line here: the hero above shows the split (☀ + ☾ = total) once for the
  // screen, and a tile with an EUR-only line made the panel jump on a currency switch.

  const expense = toNum(k?.weighted_expense_ratio);
  const ttm = toNum(k?.dividends_ttm);
  // The money notes show under the figure from tablet up; on phones the strip is one compact
  // row, so the same note rides in the (i) instead.
  const withNote = (text: string, note: ReactNode) =>
    note ? (
      <span className="kpi-grid__tip">
        <span>{text}</span>
        <span>{note}</span>
      </span>
    ) : (
      text
    );
  const expenseTip = withNote(
    STRIP_TIPS.expense,
    k?.annual_expense_cost != null ? (
      <>
        About <Money amount={toNum(k.annual_expense_cost)} currency={currency} digits={0} /> a year.
      </>
    ) : null,
  );
  const returnTip = withNote(
    STRIP_TIPS.dividendReturn,
    k?.dividend_income != null ? (
      <>
        <Money amount={toNum(k.dividend_income)} currency={currency} digits={0} /> received so far.
      </>
    ) : null,
  );
  const yieldTip = withNote(
    STRIP_TIPS.yield12,
    ttm !== null ? (
      <>
        <Money amount={ttm} currency={currency} digits={0} /> paid in the last 12 months.
      </>
    ) : null,
  );

  return (
    <div className="kpi-grid">
      <div className="kpi-grid__tiles">
        <KpiTile
          label="Day move"
          tooltip={KPI_TIPS.dayMove}
          loading={loading}
          value={money(priceMove, true)}
          secondary={money2(priceMove2, true)}
        />
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
        />
        <KpiTile
          label="Total growth"
          tooltip={KPI_TIPS.totalGrowth}
          loading={loading}
          value={pct(k?.total_growth_compounded)}
          secondary={growthSecondary}
        />
        <KpiTile
          label="Vs market"
          tooltip={KPI_TIPS.vsMarket}
          loading={loading}
          value={<VsMarket verdict={v} />}
          // The second-line slot, like every other tile: the lines align across the row.
          secondary={
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
      </div>
      {!loading && k && (
        <dl className="kpi-grid__strip">
          <div className="kpi-grid__stat">
            <dt className="kpi-grid__stat-label">
              <span className="kpi-grid__stat-long">Expense ratio</span>
              <span className="kpi-grid__stat-short" aria-hidden>
                Expense
              </span>
              <InfoTip label="Expense ratio" content={expenseTip} />
            </dt>
            <dd className="kpi-grid__stat-value">
              <Percent ratio={expense} />
            </dd>
            {k.annual_expense_cost != null && (
              <dd className="kpi-grid__stat-sub">
                ≈ <Money amount={toNum(k.annual_expense_cost)} currency={currency} digits={0} />
                /yr
              </dd>
            )}
          </div>
          <div className="kpi-grid__stat">
            <dt className="kpi-grid__stat-label">
              <span className="kpi-grid__stat-long">Dividend return</span>
              <span className="kpi-grid__stat-short" aria-hidden>
                Div. return
              </span>
              <InfoTip label="Dividend return" content={returnTip} />
            </dt>
            <dd className="kpi-grid__stat-value">
              <Percent ratio={toNum(k.dividend_yield_pct)} />
            </dd>
            {k.dividend_income != null && (
              <dd className="kpi-grid__stat-sub">
                <Money amount={toNum(k.dividend_income)} currency={currency} digits={0} />
              </dd>
            )}
          </div>
          <div className="kpi-grid__stat">
            <dt className="kpi-grid__stat-label">
              <span className="kpi-grid__stat-long">Dividend yield, 12 mo</span>
              <span className="kpi-grid__stat-short" aria-hidden>
                Yield 12 mo
              </span>
              <InfoTip label="Dividend yield, 12 months" content={yieldTip} />
            </dt>
            <dd className="kpi-grid__stat-value">
              <Percent ratio={toNum(k.dividend_yield_ttm_pct)} />
            </dd>
            {ttm !== null && (
              <dd className="kpi-grid__stat-sub">
                <Money amount={ttm} currency={currency} digits={0} />
              </dd>
            )}
          </div>
        </dl>
      )}
    </div>
  );
}
