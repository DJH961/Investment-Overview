/* The bar chart is a decorative graphic with a text alternative. */
/* oxlint-disable jsx-a11y/prefer-tag-over-role */
import { Inbox } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router";
import { Card } from "../../components/Card";
import { type Column, DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { GrowthBars } from "../../components/GrowthBars";
import { Money } from "../../components/Money";
import { PageHeader } from "../../components/PageHeader";
import { RecapCard } from "../../components/RecapCard";
import { Percent } from "../../components/Percent";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Skeleton } from "../../components/Skeleton";
import { formatDate, formatMonth, MISSING } from "../../lib/format";
import { type ReportingCurrency, usePrefs } from "../../lib/prefs";
import { type PeriodRowOut, toNum, usePeriods } from "../../lib/queries/reports";
import { useShellStatus } from "../../lib/shell";
import { useIsPhone } from "../../lib/useMediaQuery";
import { usePersistentState, type Validator } from "../../lib/usePersistentState";
import { groupByYear } from "./groupByYear";
import { Maybe } from "./Maybe";
import { PhoneYears } from "./PhoneYears";
import { YearsTable } from "./YearsTable";
import "./Periods.scss";
import "./PhoneYears.scss";

export type View = "year" | "monthly" | "yearly";

const VIEWS = [
  { value: "year", label: "By year" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
] as const;

const isView: Validator<View> = (v): v is View => v === "year" || v === "monthly" || v === "yearly";

/** "2026-10" -> "Oct 2026"; years and other labels pass through. */
export function periodLabel(label: string): string {
  return formatMonth(label, "short");
}

const otherCcy = (c: ReportingCurrency): ReportingCurrency => (c === "EUR" ? "USD" : "EUR");

type PeriodRowWithCashOut = PeriodRowOut & { cashed_out_eur?: string | null; cashed_out?: string | null };

function hasCashOut(rows: readonly PeriodRowOut[]): boolean {
  return rows.some((r) => {
    const row = r as PeriodRowWithCashOut;
    return (toNum(row.cashed_out) ?? 0) > 0 || (toNum(row.cashed_out_eur) ?? 0) > 0;
  });
}

function buildColumns(
  currency: ReportingCurrency,
  other: Map<string, PeriodRowOut>,
  opts: { yearly: boolean; withLabel: boolean; withCashOut?: boolean },
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
          {periodLabel(r.label)}
          {r.is_current && <span className="periods-page__pill"> live</span>}
        </>
      ),
    },
    {
      key: "closing",
      header: "Value",
      align: "right",
      phone: "sub",
      sortValue: (r) => toNum(r.closing_value),
      cell: (r) => {
        const o = toNum(other.get(r.label)?.closing_value);
        return (
          <>
            <span className="periods-page__value">{money(r.closing_value)}</span>
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
      phone: "headline",
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
      header: "Contributions",
      align: "right",
      sortValue: (r) => toNum(r.contributions),
      cell: (r) => money(r.contributions),
    },
    ...(opts.withCashOut
      ? [
          {
            key: "cashed_out",
            header: "Cashed out",
            align: "right" as const,
            phone: "hide" as const,
            sortValue: (r: PeriodRowOut) => {
              const row = r as PeriodRowWithCashOut;
              return toNum(row.cashed_out ?? row.cashed_out_eur);
            },
            cell: (r: PeriodRowOut) => {
              const row = r as PeriodRowWithCashOut;
              const v = toNum(row.cashed_out);
              if (v !== null && v > 0) return <Money amount={v} currency={currency} />;
              const eur = toNum(row.cashed_out_eur);
              if (eur !== null && eur > 0) return <Money amount={eur} currency="EUR" />;
              return MISSING;
            },
          },
        ]
      : []),
    {
      key: "div",
      header: "Dividends",
      align: "right",
      phone: "hide",
      sortValue: (r) => toNum(r.dividends),
      cell: (r) => money(r.dividends),
    },
  );
  return opts.withLabel ? cols : cols.filter((c) => c.key !== "label");
}

function index(rows: PeriodRowOut[] | undefined): Map<string, PeriodRowOut> {
  return new Map((rows ?? []).map((r) => [r.label, r]));
}

export function Periods() {
  const { currency } = usePrefs();
  const phone = useIsPhone();
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
  const failed = active.find((q) => q.isError && !q.data);
  const fetching = active.some((q) => q.isFetching);
  const asOf = (needYearly ? yearly : monthly).data?.as_of;
  const { refetch: refetchM } = monthly;
  const { refetch: refetchY } = yearly;
  const refetch = useCallback(() => {
    void refetchM();
    void refetchY();
  }, [refetchM, refetchY]);
  useShellStatus(failed ? "stale" : pending ? "loading" : "closed", asOf ? `As of ${formatDate(asOf)}` : "Loading", refetch, fetching);

  const mRows = monthly.data?.rows ?? [];
  const yRows = yearly.data?.rows ?? [];
  const flat = view === "monthly" ? mRows : yRows;
  const groups = groupByYear(mRows, yRows);
  const mOther = index(monthly2.data?.rows);
  const yOther = index(yearly2.data?.rows);
  const empty = view === "year" ? mRows.length === 0 && yRows.length === 0 : flat.length === 0;

  // The recap (7.4): the last finished month by default, stepping through finished periods.
  const [recapPeriod, setRecapPeriod] = useState<string | null>(null);
  const mData = monthly.data;
  const yData = yearly.data;
  const recapPeriods = useMemo(
    () => ({
      month: (mData?.rows ?? []).filter((r) => !r.is_current).map((r) => r.label),
      year: (yData?.rows ?? []).filter((r) => !r.is_current).map((r) => r.label),
    }),
    [mData, yData],
  );

  // By-year view: the last two years of months as a bar strip on top.
  const recent = mRows.slice(-24);

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
          <RecapCard
            currency={currency}
            place="periods"
            period={recapPeriod}
            periods={recapPeriods}
            onPeriod={setRecapPeriod}
          />
          {view === "year" && recent.length > 1 && (
            <div className="periods-page__stage">
              <Card variant="plain" title="Growth per month" meta="Last 24 months" collapsibleId="periods.bars">
                <GrowthBars
                  ariaLabel="Monthly growth, last 24 months"
                  bars={recent.map((r) => ({ id: r.label, label: periodLabel(r.label), value: toNum(r.growth_pct) }))}
                />
              </Card>
            </div>
          )}
          {view === "year" && phone ? (
            <PhoneYears groups={groups} currency={currency} monthsOther={mOther} yearOther={yOther} />
          ) : view === "year" ? (
            <YearsTable groups={groups} currency={currency} monthsOther={mOther} yearOther={yOther} />
          ) : (
            <>
              <div className="periods-page__stage">
                <Card variant="plain" title={view === "monthly" ? "Growth per month" : "Growth per year"}>
                  <GrowthBars
                    ariaLabel={`${view} growth bar chart`}
                    bars={flat.map((r) => ({ id: r.label, label: periodLabel(r.label), value: toNum(r.growth_pct) }))}
                  />
                </Card>
              </div>
              <Card title={view === "monthly" ? "Monthly" : "Yearly"} flush>
                <DataTable
                  className="periods-page__table"
                  caption={`${view} periods`}
                  columns={buildColumns(currency, view === "monthly" ? mOther : yOther, {
                    yearly: view === "yearly",
                    withLabel: true,
                    withCashOut: hasCashOut(flat),
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
