import { CheckCircle2, Loader2, Play, XCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button, type ButtonVariant } from "../../components/Button";
import { ApiError } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { useJobRun, useStartJob, type JobInfo, type JobRun } from "../../lib/queries/maintenance";
import { authBlock, errorMessage, fieldErrors, reauthHref } from "../../lib/queries/settings";
import { ConfirmAction } from "./ConfirmAction";
import { missingParams, type JobParams } from "./JobParamsForm";

/** The minimum a launcher needs (a catalogue job, or a check action enriched from it). */
export type LaunchableJob = Pick<JobInfo, "id" | "label" | "description" | "danger"> &
  Partial<Pick<JobInfo, "confirm_word" | "backup_first" | "params" | "running">>;

function startError(e: unknown): ReactNode {
  const block = authBlock(e);
  if (block === "reauth")
    return (
      <>
        This needs a fresh sign-in. <a href={reauthHref()}>Sign in again</a>, then retry.
      </>
    );
  if (block === "session") return "This needs a signed-in browser session (not the API token).";
  if (e instanceof ApiError && e.status === 409) return "Another heavy job is running. Try again when it has finished.";
  const errs = fieldErrors(e);
  if (Object.keys(errs).length) return Object.values(errs).join(" · ");
  return errorMessage(e) ?? "Could not start the job.";
}

function summarise(result: JobRun["result"]): string {
  if (!result) return "";
  return Object.entries(result)
    .slice(0, 4)
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");
}

/** Live status of one run (SSE `job` events update the cache; polling is the fallback). */
export function JobRunStatus({ runId }: { runId: string }) {
  const q = useJobRun(runId);
  const run = q.data;
  if (!run) return null;
  return (
    <p className={`repair__run repair__run--${run.status}`} aria-live="polite">
      {run.status === "running" ? (
        <Loader2 aria-hidden size={14} className="repair__spin" />
      ) : run.status === "succeeded" ? (
        <CheckCircle2 aria-hidden size={14} />
      ) : (
        <XCircle aria-hidden size={14} />
      )}
      <span>
        {run.status === "running"
          ? `Running since ${formatDateTime(run.started_at)}…`
          : run.status === "succeeded"
            ? `Done ${formatDateTime(run.finished_at)}${run.result ? ` — ${summarise(run.result)}` : ""}`
            : `Failed: ${run.error ?? "unknown error"}`}
      </span>
    </p>
  );
}

export interface RunJobProps {
  job: LaunchableJob;
  params?: JobParams;
  label?: string;
  variant?: ButtonVariant;
  size?: "sm" | "md";
  disabled?: boolean;
  /** Extra text in the confirm dialog (what changes / what stays). */
  confirmNote?: ReactNode;
}

/** A "Run" button that asks first when the job is dangerous and then shows live progress. */
export function RunJob({ job, params = {}, label, variant = "secondary", size = "sm", disabled, confirmNote }: RunJobProps) {
  const start = useStartJob();
  const [confirming, setConfirming] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<ReactNode>(null);
  const missing = missingParams(job.params ?? [], params);

  const go = (confirm?: string) => {
    setError(null);
    start.mutate(
      { id: job.id, params, confirm },
      {
        onSuccess: (run) => {
          setRunId(run.id);
          setConfirming(false);
        },
        onError: (e) => setError(startError(e)),
      },
    );
  };

  return (
    <div className="repair__launch">
      <Button
        variant={job.danger === "typed" ? "danger" : variant}
        size={size}
        leftIcon={<Play aria-hidden />}
        loading={start.isPending && !confirming}
        disabled={disabled || missing.length > 0 || Boolean(job.running)}
        title={missing.length ? `Fill in: ${missing.join(", ")}` : undefined}
        onClick={() => (job.danger === "none" ? go() : setConfirming(true))}
      >
        {label ?? job.label}
      </Button>
      {job.running && !runId && <span className="repair__muted">Running…</span>}
      {runId && <JobRunStatus runId={runId} />}
      {error && !confirming && (
        <p className="repair__error" role="alert">
          {error}
        </p>
      )}
      {job.danger !== "none" && (
        <ConfirmAction
          open={confirming}
          onOpenChange={(o) => {
            setConfirming(o);
            if (!o) setError(null);
          }}
          title={`${job.label}?`}
          description={
            <>
              {job.description}
              {confirmNote && <> {confirmNote}</>}
            </>
          }
          danger={job.danger}
          confirmWord={job.confirm_word}
          backupFirst={job.backup_first}
          loading={start.isPending}
          error={error}
          onConfirm={go}
        />
      )}
    </div>
  );
}
