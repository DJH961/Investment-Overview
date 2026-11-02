import { Pause, Play, RotateCw } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { ErrorState } from "../../components/ErrorState";
import { Field } from "../../components/Field";
import { Input } from "../../components/Input";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { formatDateTime } from "../../lib/format";
import { useScheduler, useSchedulerPause, useSchedulerRunNow, type SchedulerJobName } from "../../lib/queries/maintenance";
import { errorMessage } from "../../lib/queries/settings";

const JOB_LABEL: Record<SchedulerJobName, string> = {
  tick: "Live prices (market hours)",
  fx: "FX rates",
  eod: "End-of-day closes",
  backup: "Backups",
};

export function SchedulerTab() {
  const q = useScheduler();
  const runNow = useSchedulerRunNow();
  const pause = useSchedulerPause();
  const { toast } = useToast();
  const [hours, setHours] = useState("24");

  if (q.isError) return <ErrorState onRetry={() => void q.refetch()} />;
  if (q.isPending) return <Skeleton height="200px" />;
  const s = q.data;
  const fail = (title: string) => (e: unknown) => toast({ title, description: errorMessage(e), tone: "error" });
  const h = Number(hours);
  const hoursOk = Number.isInteger(h) && h >= 1 && h <= 168;

  return (
    <div className="diagnostics__tab">
      <Card
        title="Scheduler"
        subtitle={
          s.enabled
            ? `Running · market ${s.market_state ?? "unknown"}${s.heavy_job ? ` · waiting for ${s.heavy_job}` : ""}`
            : "Not running in this process (desktop / tests). Jobs still run from Repair."
        }
      >
        <Field label="Pause for (hours)" hint="A pause ends by itself after this time (1–168 h), so updates never stay off by accident.">
          {(c) => <Input {...c} inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} />}
        </Field>
        <ul className="scheduler__jobs">
          {(s.jobs ?? []).map((j) => {
            const paused = j.paused_until !== null && j.paused_until !== undefined;
            return (
              <li key={j.name} className="scheduler__job">
                <div className="scheduler__job-text">
                  <strong>{JOB_LABEL[j.name]}</strong>
                  <span className="diagnostics__muted">
                    Last run {formatDateTime(j.last_run_at)}
                    {j.last_failed ? " · failed" : ""}
                    {j.running ? " · running now" : j.requested ? " · queued" : ""}
                  </span>
                  {paused && (
                    <span className="scheduler__paused">Paused until {formatDateTime(j.paused_until)} (resumes automatically)</span>
                  )}
                </div>
                <div className="scheduler__job-actions">
                  <Button
                    size="sm"
                    leftIcon={<RotateCw aria-hidden />}
                    disabled={!s.enabled || j.running}
                    loading={runNow.isPending && runNow.variables === j.name}
                    onClick={() => runNow.mutate(j.name, { onError: fail("Could not queue the run") })}
                  >
                    Run now
                  </Button>
                  {paused ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      leftIcon={<Play aria-hidden />}
                      onClick={() => pause.mutate({ jobs: [j.name], paused: false }, { onError: fail("Could not resume") })}
                    >
                      Resume
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      leftIcon={<Pause aria-hidden />}
                      disabled={!hoursOk}
                      onClick={() => pause.mutate({ jobs: [j.name], paused: true, hours: h }, { onError: fail("Could not pause") })}
                    >
                      Pause {hoursOk ? `${h} h` : ""}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
