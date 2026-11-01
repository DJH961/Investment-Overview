import { Inbox } from "lucide-react";
import { useCallback, useState } from "react";
import { Card } from "../../components/Card";
import { type Column, DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { KpiTile } from "../../components/KpiTile";
import { Money } from "../../components/Money";
import { PageHeader } from "../../components/PageHeader";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Skeleton } from "../../components/Skeleton";
import { formatDate, formatNumber } from "../../lib/format";
import { usePrefs } from "../../lib/prefs";
import { type PeriodRowOut, toNum, useDeposits, usePeriods } from "../../lib/queries/reports";
import { useShellStatus } from "../../lib/shell";
import { Maybe } from "../Periods/Maybe";
import "./Activity.scss";

type Tab = "contributions" | "dividends";
type DepositRow = NonNullable<ReturnType<typeof useDeposits>["data"]>["rows"][number];

export function Activity() {
  const { currency } = usePrefs();
  const [tab, setTab] = useState<Tab>("contributions");
  const deposits = useDeposits(currency);
  const yearly = usePeriods("yearly", currency);
  const active = tab === "contributions" ? deposits : yearly;
  const { refetch: activeRefetch } = active;
  const refetch = useCallback(() => void activeRefetch(), [activeRefetch]);
  useShellStatus(
    active.isError ? "stale" : active.isPending ? "loading" : "closed",
    active.data ? `As of ${active.data.as_of}` : "Loading",
    refetch,
    active.isFetching,
  );

  const money = (v: string | null) => (
    <Maybe present={toNum(v) !== null} ccy={currency}>
      <Money amount={toNum(v)} currency={currency} />
    </Maybe>
  );

  const paidFrom = (r: DepositRow) => {
    if (!r.rate_source) return "";
    const rate = toNum(r.effective_rate);
    const batches = r.conversion_batches ?? [];
    const from = batches.map((b) => formatDate(b.date)).join(", ");
    const ecb = r.rate_source === "conversions" ? "" : r.rate_source === "ecb" ? "ECB rate" : "rest at ECB rate";
    const head = [from && `Conversion ${from}`, ecb].filter(Boolean).join("; ");
    return rate === null ? head : `${head} (${formatNumber(rate, 4)} USD/EUR)`;
  };

  const depositColumns: Column<DepositRow>[] = [
    { key: "date", header: "Date", primary: true, sortValue: (r) => r.date, cell: (r) => formatDate(r.date) },
    { key: "kind", header: "Kind", cell: (r) => r.kind },
    { key: "account", header: "Account", cell: (r) => r.account },
    {
      key: "native",
      header: "Native",
      align: "right",
      cell: (r) => <Money amount={toNum(r.amount_native)} currency={r.currency} />,
    },
    { key: "amount", header: "Amount", align: "right", sortValue: (r) => toNum(r.amount), cell: (r) => money(r.amount) },
    {
      key: "paid",
      header: "Paid from",
      cell: (r) => (r.rate_source ? <span className="activity-page__paid">{paidFrom(r)}</span> : null),
    },
  ];
  const dividendColumns: Column<PeriodRowOut>[] = [
    { key: "label", header: "Year", primary: true, cell: (r) => r.label },
    { key: "div", header: "Dividends", align: "right", sortValue: (r) => toNum(r.dividends), cell: (r) => money(r.dividends) },
    { key: "int", header: "Interest", align: "right", cell: (r) => money(r.interest) },
  ];

  const summary = deposits.data?.summary;
  return (
    <div className="activity-page">
      <PageHeader
        title="Activity"
        subtitle="Contributions and dividends."
        actions={
          <SegmentedControl<Tab>
            ariaLabel="Activity type"
            options={[
              { value: "contributions", label: "Contributions" },
              { value: "dividends", label: "Dividends" },
            ]}
            value={tab}
            onChange={setTab}
          />
        }
      />
      {active.isError ? (
        <ErrorState title="Could not load activity" message={active.error.message} onRetry={() => void active.refetch()} />
      ) : active.isPending ? (
        <Skeleton height="14rem" />
      ) : tab === "contributions" ? (
        <div className="activity-page__stack">
          <div className="activity-page__kpis">
            <KpiTile label="Total" value={money(summary?.total_contrib ?? null)} />
            <KpiTile label="This year" value={money(summary?.ytd_contrib ?? null)} />
            <KpiTile label="This month" value={money(summary?.mtd_contrib ?? null)} />
          </div>
          {deposits.data?.rows.length ? (
            <Card title="Contributions" flush>
              <DataTable
                caption="Contributions"
                columns={depositColumns}
                rows={deposits.data.rows}
                rowKey={(r) => String(r.id ?? `${r.date}-${r.account}-${r.amount_native}`)}
                defaultSort={{ key: "date", direction: "desc" }}
              />
            </Card>
          ) : (
            <EmptyState icon={<Inbox aria-hidden />} title="No contributions yet" />
          )}
        </div>
      ) : yearly.data?.rows.length ? (
        <Card title="Dividends and interest by year" flush>
          <DataTable
            caption="Dividends by year"
            columns={dividendColumns}
            rows={[...yearly.data.rows].reverse()}
            rowKey={(r) => r.label}
          />
        </Card>
      ) : (
        <EmptyState icon={<Inbox aria-hidden />} title="No dividends yet" />
      )}
    </div>
  );
}
