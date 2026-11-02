/* The bar chart is a decorative graphic with a text alternative. */
/* oxlint-disable jsx-a11y/prefer-tag-over-role */
import { Inbox } from "lucide-react";
import { useCallback } from "react";
import { Link } from "react-router";
import { Card } from "../../components/Card";
import { type Column, DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { Money } from "../../components/Money";
import { PageHeader } from "../../components/PageHeader";
import { Percent } from "../../components/Percent";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Skeleton } from "../../components/Skeleton";
import { type ReportingCurrency, usePrefs } from "../../lib/prefs";
import { type PeriodRowOut, toNum, usePeriods } from "../../lib/queries/reports";
import { useShellStatus } from "../../lib/shell";
import { usePersistentState, type Validator } from "../../lib/usePersistentState";
import { groupByYear, yearOf } from "./groupByYear";
import { Maybe } from "./Maybe";
import "./Periods.scss";

export type View = "year" | "monthly" | "yearly";

const VIEWS = [
  { value: "year", label: "By year" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
] as const;

const isView: Validator<View> = (v): v is View => v === "year" || v === "monthly" || v === "yearly";

const otherCcy = (c: ReportingCurrency): ReportingCurrency => (c === "EUR" ? "USD" : "EUR");

function buildColumns(
  currency: ReportingCurrency,
  other: Map<string, PeriodRowOut>,
  opts: { yearly: boolean; withLabel: boolean },
): Column<PeriodRowOut>[] {
  const second = otherCcy(currency);
  const money = (v: string | null) => (
    <Maybe present={toNum(v) !== null} ccy={currency}>
      <Money amount={toNum(v)} currency={currency} />
    </Maybe>
  );
  const pct = (v: string | null, signed = true) => (
    <Maybe present={toNum(v) !== null} ccy={currency}>
      <Percent ratio={toNum(v)} signed={signed} colored={signed} />
    </Maybe>
  );
  const cols: Column<PeriodRowOut>[] = [
    {
      key: "label",
      header: "Period",
      primary: true,
      sortValue: (r) => r.label,
      cell: (r) => (
        <>
          {r.label}
          {r.is_current && <span className="periods-page__pill"> live</span>}
        </>
      ),
    },
    {
      key: "closing",
      header: "Value",
      align: "right",
      sortValue: (r) => toNum(r.closing_value),
      cell: (r) => {
        const o = toNum(other.get(r.label)?.closing_value);
        return (
          <>
            {money(r.closing_value)}
            {o !== null && (
              <span className="periods-page__second">
                <Money amount={o} currency={second} />
              </span>
            )}
          </>
        );
      },
    },
    {
      key: "growth",
      header: opts.yearly ? "Growth (TWR)" : "Growth",
      align: "right",
      sortValue: (r) => toNum(r.growth_pct),
      cell: (r) => pct(r.growth_pct),
    },
  ];
  if (opts.yearly) {
    cols.push({
      key: "xirr",
      header: "XIRR (period)",
      align: "right",
      sortValue: (r) => toNum(r.period_growth_xirr),
      cell: (r) => pct(r.period_growth_xirr),
    });
  }
  cols.push(
    {
      key: "total",
      header: "Total growth",
      align: "right",
      sortValue: (r) => toNum(r.total_growth_compounded),
      cell: (r) => pct(r.total_growth_compounded),
    },
    { key: "flow", header: "Net flow", align: "right", sortValue: (r) => toNum(r.net_flow), cell: (r) => money(r.net_flow) },
    {
      key: "contrib",
      header: "Contrib",
      align: "right",
      sortValue: (r) => toNum(r.contributions),
      cell: (r) => money(r.contributions),
    },
    {
      key: "div",
      header: "Div",
      align: "right",
      phone: "hide",
      sortValue: (r) => toNum(r.dividends),
      cell: (r) => money(r.dividends),
    },
    {
      key: "int",
      header: "Int",
      align: "right",
      phone: "hide",
      sortValue: (r) => toNum(r.interest),
      cell: (r) => money(r.interest),
    },
  );
  return opts.withLabel ? cols : cols.filter((c) => c.key !== "label");
}

function index(rows: PeriodRowOut[] | undefined): Map<string, PeriodRowOut> {
  return new Map((rows ?? []).map((r) => [r.label, r]));
}

export function Periods() {
  const { currency } = usePrefs();
  const [view, setView] = usePersistentState<View>("periods.view", "year", isView);
  const second = otherCcy(currency);
  const needMonthly = view !== "yearly";
  const needYearly = view !== "monthly";
  const monthly = usePeriods("monthly", currency);
  const yearly = usePeriods("yearly", currency);
  const monthly2 = usePeriods("monthly", second);
  const yearly2 = usePeriods("yearly", second);
  const active = [needMonthly && monthly, needYearly && yearly].filter((x) => x !== false);
  const pending = active.some((q) => q.isPending);
  const failed = active.find((q) => q.isError);
  const fetching = active.some((q) => q.isFetching);
  const asOf = (needYearly ? yearly : monthly).data?.as_of;
  const { refetch: refetchM } = monthly;
  const { refetch: refetchY } = yearly;
  const refetch = useCallback(() => {
    void refetchM();
    void refetchY();
  }, [refetchM, refetchY]);
  useShellStatus(failed ? "stale" : pending ? "loading" : "closed", asOf ? `As of ${asOf}` : "Loading", refetch, fetching);

  const mRows = monthly.data?.rows ?? [];
  const yRows = yearly.data?.rows ?? [];
  const flat = view === "monthly" ? mRows : yRows;
  const groups = groupByYear(mRows, yRows);
  const mOther = index(monthly2.data?.rows);
  const yOther = index(yearly2.data?.rows);
  const empty = view === "year" ? mRows.length === 0 && yRows.length === 0 : flat.length === 0;

  const growths = flat.map((r) => toNum(r.growth_pct));
  const maxAbs = Math.max(0, ...growths.map((g) => Math.abs(g ?? 0)));

  return (
    <div className="periods-page">
      <PageHeader
        title="Periods"
        subtitle="Monthly and yearly performance."
        actions={
          <>
            <Link className="periods-page__link" to="/activity">
              See contributions
            </Link>
            <Link className="periods-page__link" to="/projection">
              Project forward
            </Link>
            <SegmentedControl<View> ariaLabel="Period view" options={[...VIEWS]} value={view} onChange={setView} />
          </>
        }
      />
      {failed?.isError ? (
        <ErrorState title="Could not load periods" message={failed.error.message} onRetry={refetch} />
      ) : pending ? (
        <Skeleton height="16rem" />
      ) : empty ? (
        <EmptyState icon={<Inbox aria-hidden />} title="No periods yet" description="Import transactions to see returns." />
      ) : (
        <div className="periods-page__grid">
          {view === "year" ? (
            groups.map((g) => (
              <Card
                key={g.year}
                collapsibleId={`periods.year.${g.year}`}
                defaultOpen={g.isCurrent}
                title={
                  <>
                    {g.year}
                    {g.isCurrent && <span className="periods-page__pill"> current</span>}
                  </>
                }
                subtitle={g.summary && <YearSummary row={g.summary} currency={currency} other={yOther.get(g.summary.label)} />}
                flush
              >
                <DataTable
                  caption={`${g.year} months`}
                  columns={buildColumns(currency, mOther, { yearly: false, withLabel: true })}
                  rows={g.months}
                  rowKey={(r) => r.label}
                />
              </Card>
            ))
          ) : (
            <>
              <Card title="Return per period">
                <div className="periods-page__bars" role="img" aria-label={`${view} growth bar chart`}>
                  {flat.map((r, i) => {
                    const g = growths[i];
                    const h = g === null || maxAbs === 0 ? 0 : (Math.abs(g) / maxAbs) * 100;
                    return (
                      <div key={r.label} className="periods-page__bar-slot" title={r.label}>
                        <div
                          className={`periods-page__bar periods-page__bar--${(g ?? 0) < 0 ? "neg" : "pos"}`}
                          style={{ height: `${h}%` }}
                        />
                      </div>
                    );
                  })}
                </div>
              </Card>
              <Card title={view === "monthly" ? "Monthly" : "Yearly"} flush>
                <DataTable
                  caption={`${view} periods`}
                  columns={buildColumns(currency, view === "monthly" ? mOther : yOther, {
                    yearly: view === "yearly",
                    withLabel: true,
                  })}
                  rows={[...flat].reverse()}
                  rowKey={(r) => r.label}
                />
              </Card>
            </>
          )}
          <Card title="How these are computed" collapsibleId="periods.method" defaultOpen={false}>
            <p className="periods-page__note">
              Growth is time-weighted (TWR): sub-period returns are chained so deposits and withdrawals do not count as
              performance, falling back to Modified Dietz when a period has no usable valuations. XIRR (period) is the
              money-weighted rate over that year. Total growth is the cumulative compounded growth from the start. The
              current period is recomputed live; completed periods are frozen as of the last close. Months with no
              activity are shown so the history stays contiguous.
            </p>
          </Card>
        </div>
      )}
    </div>
  );
}

function YearSummary({
  row,
  currency,
  other,
}: {
  row: PeriodRowOut;
  currency: ReportingCurrency;
  other: PeriodRowOut | undefined;
}) {
  const second = otherCcy(currency);
  const amt = (v: string | null) => <Money amount={toNum(v)} currency={currency} />;
  const o = toNum(other?.closing_value);
  return (
    <span className="periods-page__summary" data-year={yearOf(row.label)}>
      <span>
        {amt(row.closing_value)}
        {o !== null && (
          <span className="periods-page__second">
            <Money amount={o} currency={second} />
          </span>
        )}
      </span>
      <span>
        <Percent ratio={toNum(row.growth_pct)} signed colored />
        <span className="periods-page__chip-label"> TWR</span>
      </span>
      {toNum(row.period_growth_xirr) !== null && (
        <span>
          <Percent ratio={toNum(row.period_growth_xirr)} signed colored />
          <span className="periods-page__chip-label"> XIRR</span>
        </span>
      )}
      <span className="periods-page__chip">
        Net flow {amt(row.net_flow)}
      </span>
      <span className="periods-page__chip">
        Contrib {amt(row.contributions)}
      </span>
      <span className="periods-page__chip">
        Div {amt(row.dividends)}
      </span>
      <span className="periods-page__chip">
        Int {amt(row.interest)}
      </span>
    </span>
  );
}
