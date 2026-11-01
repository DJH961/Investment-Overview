/* The bar chart is a decorative graphic with a text alternative. */
/* oxlint-disable jsx-a11y/prefer-tag-over-role */
import { Inbox } from "lucide-react";
import { useCallback, useState } from "react";
import { Card } from "../../components/Card";
import { type Column, DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { Money } from "../../components/Money";
import { PageHeader } from "../../components/PageHeader";
import { Percent } from "../../components/Percent";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Skeleton } from "../../components/Skeleton";
import { usePrefs } from "../../lib/prefs";
import { type PeriodKind, type PeriodRowOut, toNum, usePeriods } from "../../lib/queries/reports";
import { useShellStatus } from "../../lib/shell";
import { Maybe } from "./Maybe";
import "./Periods.scss";

const KINDS = [
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
] as const;

export function Periods() {
  const { currency } = usePrefs();
  const [kind, setKind] = useState<PeriodKind>("monthly");
  const q = usePeriods(kind, currency);
  const { refetch: qRefetch } = q;
  const refetch = useCallback(() => void qRefetch(), [qRefetch]);
  useShellStatus(
    q.isError ? "stale" : q.isPending ? "loading" : "closed",
    q.data ? `As of ${q.data.as_of}` : "Loading",
    refetch,
    q.isFetching,
  );

  const rows = q.data?.rows ?? [];
  const money = (v: string | null) => (
    <Maybe present={toNum(v) !== null} ccy={currency}>
      <Money amount={toNum(v)} currency={currency} />
    </Maybe>
  );
  const columns: Column<PeriodRowOut>[] = [
    {
      key: "label",
      header: "Period",
      primary: true,
      cell: (r) => (
        <>
          {r.label}
          {r.is_current && <span className="periods-page__pill"> live</span>}
        </>
      ),
    },
    { key: "closing", header: "Value", align: "right", cell: (r) => money(r.closing_value) },
    {
      key: "growth",
      header: "Growth",
      align: "right",
      sortValue: (r) => toNum(r.growth_pct),
      cell: (r) => (
        <Maybe present={toNum(r.growth_pct) !== null} ccy={currency}>
          <Percent ratio={toNum(r.growth_pct)} signed colored />
        </Maybe>
      ),
    },
    { key: "flow", header: "Net flow", align: "right", cell: (r) => money(r.net_flow) },
    { key: "contrib", header: "Contrib", align: "right", cell: (r) => money(r.contributions) },
    { key: "div", header: "Div", align: "right", cell: (r) => money(r.dividends) },
    { key: "int", header: "Int", align: "right", cell: (r) => money(r.interest) },
  ];

  const growths = rows.map((r) => toNum(r.growth_pct));
  const maxAbs = Math.max(0, ...growths.map((g) => Math.abs(g ?? 0)));

  return (
    <div className="periods-page">
      <PageHeader
        title="Periods"
        subtitle="Monthly and yearly performance."
        actions={
          <SegmentedControl<PeriodKind>
            ariaLabel="Period granularity"
            options={[...KINDS]}
            value={kind}
            onChange={setKind}
          />
        }
      />
      {q.isError ? (
        <ErrorState title="Could not load periods" message={q.error.message} onRetry={() => void q.refetch()} />
      ) : q.isPending ? (
        <Skeleton height="16rem" />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Inbox aria-hidden />} title="No periods yet" description="Import transactions to see returns." />
      ) : (
        <div className="periods-page__grid">
          <Card title="Return per period">
            <div className="periods-page__bars" role="img" aria-label={`${kind} growth bar chart`}>
              {rows.map((r, i) => {
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
          <Card title={kind === "monthly" ? "Monthly" : "Yearly"} flush>
            <DataTable
              caption={`${kind} periods`}
              columns={columns}
              rows={[...rows].reverse()}
              rowKey={(r) => r.label}
            />
          </Card>
          <p className="periods-page__note">
            The current period is recomputed live; completed periods are frozen as of the last close.
          </p>
        </div>
      )}
    </div>
  );
}
