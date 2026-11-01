import { CheckCircle2, Download, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { DataTable, type Column } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { PageHeader } from "../../components/PageHeader";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { formatDate, formatTime } from "../../lib/format";
import {
  SUPPORT_BUNDLE_URL,
  useDiagnostics,
  useRefreshStatus,
  useStartRefresh,
  type DiagnosticsData,
} from "../../lib/queries/manage";
import "./Diagnostics.scss";

type Check = DiagnosticsData["checks"][number];
type Provider = DiagnosticsData["providers"][number];

const stamp = (iso: string | null | undefined) => (iso ? `${formatDate(iso)} ${formatTime(iso)}` : "never");

export function RefreshCard() {
  const status = useRefreshStatus();
  const start = useStartRefresh();
  const { toast } = useToast();
  const s = status.data;
  return (
    <Card
      title="Data refresh"
      subtitle={s?.running ? "Refreshing now" : `Last update: ${stamp(s?.last_update_at)}`}
      actions={
        <Button
          variant="secondary"
          leftIcon={<RefreshCw aria-hidden />}
          loading={start.isPending || Boolean(s?.running)}
          onClick={() =>
            start.mutate(true, { onError: () => toast({ title: "Could not start a refresh", tone: "error" }) })
          }
        >
          Refresh now
        </Button>
      }
    >
      {s?.running ? (
        <p className="diagnostics__muted" aria-live="polite">
          {s.progress_label ?? "Working"} ({s.progress_done}/{s.progress_total})
        </p>
      ) : (
        <p className="diagnostics__muted">Prices and FX rates are refreshed on a schedule.</p>
      )}
    </Card>
  );
}

export function Diagnostics() {
  const q = useDiagnostics();

  const checkColumns: Column<Check>[] = [
    {
      key: "sev",
      header: "Status",
      cell: (c) => (
        <span className={`diagnostics__sev diagnostics__sev--${c.severity}`}>
          {c.count === 0 ? "OK" : c.severity}
        </span>
      ),
      sortValue: (c) => c.severity,
    },
    { key: "title", header: "Check", primary: true, cell: (c) => c.title, sortValue: (c) => c.title },
    { key: "detail", header: "Detail", cell: (c) => c.detail },
    { key: "examples", header: "Examples", cell: (c) => c.examples.join(", ") },
  ];
  const providerColumns: Column<Provider>[] = [
    { key: "name", header: "Provider", primary: true, cell: (p) => p.name },
    { key: "status", header: "Status", cell: (p) => p.status ?? "unknown" },
    { key: "fetch", header: "Last fetch", cell: (p) => stamp(p.last_fetch_at) },
    { key: "msg", header: "Message", cell: (p) => p.message ?? "" },
  ];

  const d = q.data;
  const allClear = d && d.count === 0;
  return (
    <div className="diagnostics">
      <PageHeader
        title="Diagnostics"
        subtitle="Silent data problems, surfaced in one place."
        actions={
          <a className="diagnostics__download" href={SUPPORT_BUNDLE_URL} download>
            <Download aria-hidden size={16} /> Download support bundle
          </a>
        }
      />
      <RefreshCard />
      {q.isError ? (
        <ErrorState onRetry={() => void q.refetch()} />
      ) : q.isPending || !d ? (
        <Skeleton height="240px" />
      ) : (
        <>
          {allClear ? (
            <EmptyState icon={<CheckCircle2 aria-hidden />} title="All clear" description="Every check passed." />
          ) : (
            <output className="diagnostics__banner">
              <TriangleAlert aria-hidden size={16} /> {d.count} item(s) need attention
            </output>
          )}
          <Card title="All checks" flush>
            <DataTable caption="Health checks" columns={checkColumns} rows={d.checks} rowKey={(c) => c.id} />
          </Card>
          <Card title="Data providers" flush>
            <DataTable caption="Data providers" columns={providerColumns} rows={d.providers} rowKey={(p) => p.name} />
          </Card>
          {d.problems.length > 0 && (
            <Card title={`Recent problems (${d.problems.length})`}>
              <ul className="diagnostics__problems">
                {d.problems.map((p) => (
                  <li key={p.id} className="diagnostics__problem">
                    <span className="diagnostics__muted">
                      {p.source} - {stamp(p.at)}
                    </span>
                    <span>{p.message}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
