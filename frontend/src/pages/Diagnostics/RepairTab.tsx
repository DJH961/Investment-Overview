import { useState } from "react";
import { Card } from "../../components/Card";
import { DataTable, type Column } from "../../components/DataTable";
import { ErrorState } from "../../components/ErrorState";
import { Skeleton } from "../../components/Skeleton";
import { formatDateTime } from "../../lib/format";
import { useJobCatalogue, type JobInfo, type JobRun } from "../../lib/queries/maintenance";
import { defaultParams, JobParamsForm, type JobParams } from "./JobParamsForm";
import { RunJob } from "./RunJob";

/** What survives: the one difference people must not miss. */
export const JOB_NOTES: Record<string, string> = {
  "cache.reset":
    "This also deletes your manual fixes (closes, FX rates, splits you entered). To keep them, use “Re-download one instrument's prices” instead.",
  "prices.redownload": "Your manual fixes for this instrument are kept.",
};

function JobRow({ job }: { job: JobInfo }) {
  const [params, setParams] = useState<JobParams>(() => defaultParams(job.params));
  const note = JOB_NOTES[job.id];
  return (
    <li className="repair__job" data-job={job.id}>
      <div className="repair__job-head">
        <strong className="repair__job-title">{job.label}</strong>
        <span className="repair__badges">
          {job.danger === "typed" && <span className="repair__badge repair__badge--danger">Destructive</span>}
          {job.danger === "confirm" && <span className="repair__badge repair__badge--warn">Asks first</span>}
          {job.backup_first && <span className="repair__badge">Backup first</span>}
          {job.heavy && <span className="repair__badge">Heavy</span>}
        </span>
      </div>
      <p className="repair__job-desc">{job.description}</p>
      {note && <p className={`repair__job-note${job.danger === "typed" ? " repair__job-note--danger" : ""}`}>{note}</p>}
      <JobParamsForm jobId={job.id} params={job.params} values={params} onChange={setParams} />
      <RunJob job={job} params={params} label="Run" confirmNote={note} />
      {job.last_run && (
        <p className="repair__muted">
          Last run {formatDateTime(job.last_run.finished_at ?? job.last_run.started_at)}: {job.last_run.status}
          {job.last_run.error ? ` (${job.last_run.error})` : ""}
        </p>
      )}
    </li>
  );
}

export function RepairTab() {
  const q = useJobCatalogue();
  if (q.isError && !q.data) return <ErrorState onRetry={() => void q.refetch()} />;
  if (q.isPending) return <Skeleton height="320px" />;
  const c = q.data;
  const runColumns: Column<JobRun>[] = [
    { key: "job", header: "Job", primary: true, cell: (r) => c.jobs.find((j) => j.id === r.job)?.label ?? r.job },
    { key: "status", header: "Status", cell: (r) => <span className={`repair__status repair__status--${r.status}`}>{r.status}</span> },
    { key: "started", header: "Started", cell: (r) => formatDateTime(r.started_at), sortValue: (r) => r.started_at },
    { key: "actor", header: "By", phone: "hide", cell: (r) => r.actor },
    { key: "error", header: "Error", phone: "hide", cell: (r) => r.error ?? "" },
  ];
  return (
    <div className="diagnostics__tab">
      <p className="diagnostics__muted">
        Fix data problems without touching the server. Destructive jobs ask you to type a word and take a backup first.
        {c.heavy_job && <strong> A heavy job is running now ({c.heavy_job}); others wait.</strong>}
      </p>
      {c.groups.map((g) => {
        const jobs = c.jobs.filter((j) => j.group === g.id);
        if (jobs.length === 0) return null;
        return (
          <Card key={g.id} title={g.label} collapsibleId={`repair.${g.id}`}>
            <ul className="repair__jobs">
              {jobs.map((j) => (
                <JobRow key={j.id} job={j} />
              ))}
            </ul>
          </Card>
        );
      })}
      <Card title="Recent runs" flush collapsibleId="repair.recent">
        <DataTable
          caption="Recent maintenance runs"
          columns={runColumns}
          rows={c.recent}
          rowKey={(r) => r.id}
          defaultSort={{ key: "started", direction: "desc" }}
          emptyMessage="No jobs run since the server started."
        />
      </Card>
    </div>
  );
}
