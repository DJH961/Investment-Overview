import { CheckCircle2, CircleAlert, Info, RefreshCw, TriangleAlert, X } from "lucide-react";
import { Link } from "react-router";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { DataTable, type Column } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { IconButton } from "../../components/IconButton";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { formatDateTime } from "../../lib/format";
import { useDismissProblem, useJobCatalogue, type CheckAction, type JobInfo } from "../../lib/queries/maintenance";
import { useDiagnostics, useRefreshStatus, useStartRefresh, type DiagnosticsData } from "../../lib/queries/manage";
import { errorMessage } from "../../lib/queries/settings";
import { RunJob } from "./RunJob";

type Check = DiagnosticsData["checks"][number];
type Provider = DiagnosticsData["providers"][number];

const RANK: Record<string, number> = { error: 0, warning: 1, info: 2, ok: 3 };
export const bySeverity = (a: Check, b: Check) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9) || b.count - a.count;

function SevIcon({ severity }: { severity: string }) {
  if (severity === "error") return <CircleAlert aria-hidden size={16} />;
  if (severity === "warning") return <TriangleAlert aria-hidden size={16} />;
  return <Info aria-hidden size={16} />;
}

export function RefreshCard() {
  const status = useRefreshStatus();
  const start = useStartRefresh();
  const { toast } = useToast();
  const s = status.data;
  return (
    <Card
      title="Data refresh"
      subtitle={s?.running ? "Refreshing now" : `Last update: ${formatDateTime(s?.last_update_at)}`}
      actions={
        <Button
          variant="secondary"
          leftIcon={<RefreshCw aria-hidden />}
          loading={start.isPending || Boolean(s?.running)}
          onClick={() => start.mutate(true, { onError: () => toast({ title: "Could not start a refresh", tone: "error" }) })}
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

function FixButton({ action, jobs }: { action: CheckAction; jobs: Map<string, JobInfo> }) {
  if (action.kind === "link") {
    return (
      <Link className="diagnostics__fix-link" to={action.href ?? "/diagnostics"}>
        {action.label} →
      </Link>
    );
  }
  const job = jobs.get(action.id);
  return (
    <RunJob
      label={action.label}
      params={action.params}
      job={{
        id: action.id,
        label: job?.label ?? action.label,
        description: job?.description ?? "",
        danger: action.danger,
        confirm_word: job?.confirm_word ?? null,
        backup_first: job?.backup_first ?? false,
        params: job?.params ?? [],
        running: job?.running ?? false,
      }}
    />
  );
}

export function HealthTab() {
  const q = useDiagnostics();
  const catalogue = useJobCatalogue();
  const dismiss = useDismissProblem();
  const { toast } = useToast();
  const jobs = new Map((catalogue.data?.jobs ?? []).map((j) => [j.id, j]));

  if (q.isError) return <ErrorState onRetry={() => void q.refetch()} />;
  if (q.isPending) return <Skeleton height="240px" />;
  const d = q.data;
  const attention = d.checks.filter((c) => c.count > 0).sort(bySeverity);

  const checkColumns: Column<Check>[] = [
    {
      key: "sev",
      header: "Status",
      cell: (c) => <span className={`diagnostics__sev diagnostics__sev--${c.count ? c.severity : "ok"}`}>{c.count === 0 ? "OK" : c.severity}</span>,
      sortValue: (c) => (c.count ? (RANK[c.severity] ?? 9) : 9),
    },
    { key: "title", header: "Check", primary: true, cell: (c) => c.title, sortValue: (c) => c.title },
    { key: "count", header: "Items", align: "right", cell: (c) => c.count, sortValue: (c) => c.count },
    { key: "detail", header: "Detail", phone: "hide", cell: (c) => c.detail },
  ];
  const providerColumns: Column<Provider>[] = [
    { key: "name", header: "Provider", primary: true, cell: (p) => p.name },
    { key: "status", header: "Status", cell: (p) => p.status ?? "unknown" },
    { key: "fetch", header: "Last fetch", cell: (p) => formatDateTime(p.last_fetch_at) },
    {
      key: "symbols",
      header: "Last symbols",
      phone: "hide",
      cell: (p) => (
        <span className="diagnostics__chips">
          {p.last_fetch_symbols.map((s) => (
            <span key={s} className="diagnostics__chip">
              {s}
            </span>
          ))}
        </span>
      ),
    },
    { key: "msg", header: "Message", phone: "hide", cell: (p) => p.message ?? "" },
  ];

  const onDismiss = (id: number | "all") =>
    dismiss.mutate(id, { onError: (e) => toast({ title: "Could not dismiss", description: errorMessage(e), tone: "error" }) });

  return (
    <div className="diagnostics__tab">
      {attention.length === 0 ? (
        <EmptyState icon={<CheckCircle2 aria-hidden />} title="All clear" description="Every check passed." />
      ) : (
        <Card
          title={
            <span className="diagnostics__attention-title">
              Needs attention <span className="diagnostics__count">{attention.length}</span>
            </span>
          }
        >
          <ul className="diagnostics__attention">
            {attention.map((c) => (
              <li key={c.id} className={`diagnostics__issue diagnostics__issue--${c.severity}`}>
                <div className="diagnostics__issue-head">
                  <SevIcon severity={c.severity} />
                  <strong className="diagnostics__issue-title">{c.title}</strong>
                  <span className="diagnostics__count">{c.count}</span>
                </div>
                <p className="diagnostics__issue-detail">{c.detail}</p>
                {c.examples.length > 0 && (
                  <span className="diagnostics__chips">
                    {c.examples.map((e) => (
                      <span key={e} className="diagnostics__chip">
                        {e}
                      </span>
                    ))}
                  </span>
                )}
                {(c.actions ?? []).length > 0 && (
                  <div className="diagnostics__fixes">
                    {(c.actions ?? []).map((a) => (
                      <FixButton key={`${a.kind}:${a.id}:${a.label}`} action={a} jobs={jobs} />
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {d.problems.length > 0 && (
        <Card
          title={`Recent problems (${d.problems.length})`}
          actions={
            <Button size="sm" variant="ghost" loading={dismiss.isPending && dismiss.variables === "all"} onClick={() => onDismiss("all")}>
              Dismiss all
            </Button>
          }
        >
          <ul className="diagnostics__problems">
            {d.problems.map((p) => (
              <li key={p.id} className="diagnostics__problem">
                <div className="diagnostics__problem-text">
                  <span className="diagnostics__muted">
                    {p.source} · {formatDateTime(p.at)}
                  </span>
                  <span>{p.message}</span>
                </div>
                <IconButton size="sm" label={`Dismiss problem: ${p.message}`} icon={<X aria-hidden />} onClick={() => onDismiss(p.id)} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      <RefreshCard />

      <Card title="All checks" flush collapsibleId="diagnostics.checks">
        <DataTable caption="Health checks" columns={checkColumns} rows={[...d.checks].sort(bySeverity)} rowKey={(c) => c.id} />
      </Card>
      <Card title="Data providers" flush collapsibleId="diagnostics.providers">
        <DataTable caption="Data providers" columns={providerColumns} rows={d.providers} rowKey={(p) => p.name} />
      </Card>
      <Card title={`Provider log (${d.provider_log.length})`} collapsibleId="diagnostics.provider-log" defaultOpen={false}>
        {d.provider_log.length === 0 ? (
          <p className="diagnostics__muted">No provider calls recorded since the server started.</p>
        ) : (
          <ul className="diagnostics__log">
            {d.provider_log.map((e, i) => (
              <li key={`${e.at}-${i}`} className={`diagnostics__log-row diagnostics__log-row--${e.status}`}>
                <span className="diagnostics__muted">{formatDateTime(e.at)}</span>
                <span className="diagnostics__log-provider">{e.provider}</span>
                <span className="diagnostics__log-status">{e.status}</span>
                <span className="diagnostics__log-msg">{e.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
