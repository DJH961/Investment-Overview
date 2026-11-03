import { Download } from "lucide-react";
import { useState } from "react";
import { Card } from "../../components/Card";
import { ErrorState } from "../../components/ErrorState";
import { Field } from "../../components/Field";
import { Input } from "../../components/Input";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Select } from "../../components/Select";
import { Skeleton } from "../../components/Skeleton";
import { formatDateTime } from "../../lib/format";
import { useLogs, type LogQuery } from "../../lib/queries/maintenance";
import { SUPPORT_BUNDLE_URL } from "../../lib/queries/manage";
import { errorMessage } from "../../lib/queries/settings";
import { usePersistentState } from "../../lib/usePersistentState";

const LEVELS: LogQuery["level"][] = ["DEBUG", "INFO", "WARNING", "ERROR"];

export function LogsTab() {
  const [source, setSource] = usePersistentState<string>("diagnostics.logs.source", "main");
  const [level, setLevel] = usePersistentState<LogQuery["level"]>("diagnostics.logs.level", "INFO");
  const [contains, setContains] = useState("");
  const [tracebacks, setTracebacks] = useState(false);
  const q = useLogs({ source, level, limit: 300, contains, tracebacks });
  const sources = q.data?.sources ?? [source];

  return (
    <div className="diagnostics__tab">
      <Card
        title="Server log"
        subtitle="Secrets are redacted before anything leaves the server."
        actions={
          <a className="diagnostics__download" href={SUPPORT_BUNDLE_URL} download>
            <Download aria-hidden size={16} /> Support bundle
          </a>
        }
      >
        <div className="logs__filters">
          <Field label="Log">
            {(c) => (
              <Select
                id={c.id}
                options={sources.map((s) => ({ value: s, label: s === "main" ? "Main server log" : s.replace(/_/g, " ") }))}
                value={source}
                onValueChange={setSource}
              />
            )}
          </Field>
          <Field label="Minimum level">
            <SegmentedControl size="sm" ariaLabel="Minimum level" options={LEVELS.map((l) => ({ value: l, label: l }))} value={level} onChange={setLevel} />
          </Field>
          <Field label="Contains">
            {(c) => <Input {...c} value={contains} maxLength={100} onChange={(e) => setContains(e.target.value)} />}
          </Field>
          <Field label="Tracebacks">
            <SegmentedControl
              size="sm"
              ariaLabel="Tracebacks"
              options={[
                { value: "off", label: "Hide" },
                { value: "on", label: "Show" },
              ]}
              value={tracebacks ? "on" : "off"}
              onChange={(v) => setTracebacks(v === "on")}
            />
          </Field>
        </div>
        {q.isError && !q.data ? (
          <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
        ) : q.isPending ? (
          <Skeleton height="200px" />
        ) : q.data.entries.length === 0 ? (
          <p className="diagnostics__muted">No matching lines.</p>
        ) : (
          <ol className="logs__lines">
            {q.data.entries.map((e, i) => (
              <li key={`${e.ts}-${i}`} className={`logs__line logs__line--${e.level.toLowerCase()}`}>
                <span className="logs__ts">{formatDateTime(e.ts, "")}</span>
                <span className="logs__level">{e.level}</span>
                <span className="logs__logger">{e.logger}</span>
                <span className="logs__msg">{e.message}</span>
                {e.traceback && <pre className="logs__trace">{e.traceback}</pre>}
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
