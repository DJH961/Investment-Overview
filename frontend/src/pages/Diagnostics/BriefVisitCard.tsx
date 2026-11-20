import { useState } from "react";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { ErrorState } from "../../components/ErrorState";
import { Input } from "../../components/Input";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { formatDayTime } from "../../lib/format";
import { useBrief, useClearBriefVisit, useSetBriefVisit, type BriefVisitDto } from "../../lib/queries/brief";
import { errorMessage } from "../../lib/queries/settings";
import { useTimeZone } from "../../lib/timezone";

/** The zone's offset from UTC at `at`, in ms. */
function offsetMs(at: number, timeZone: string | undefined): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const v: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(at))) v[p.type] = Number(p.value);
  return Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second) - Math.floor(at / 1000) * 1000;
}

/** "2026-11-18T22:10" (a wall-clock time in `timeZone`) to the UTC instant, as ISO. Null when unparseable. */
export function wallTimeToIso(local: string, timeZone?: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let at = guess - offsetMs(guess, timeZone);
  at = guess - offsetMs(at, timeZone); // across a DST change the first guess can be an hour off
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

/** An instant as the "YYYY-MM-DDTHH:mm" a datetime-local input takes, in `timeZone`. */
export function isoToWallTime(iso: string, timeZone?: string): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "";
  return new Date(at + offsetMs(at, timeZone)).toISOString().slice(0, 16);
}

function Body({ brief }: { brief: BriefVisitDto }) {
  const timeZone = useTimeZone();
  const set = useSetBriefVisit();
  const clear = useClearBriefVisit();
  const { toast } = useToast();
  const [value, setValue] = useState(() => (brief.visit_from ? isoToWallTime(brief.visit_from, timeZone) : ""));
  const [error, setError] = useState<string | null>(null);
  const when = (iso: string | null | undefined) => (iso ? formatDayTime(iso, timeZone) : "none yet");

  const onSet = () => {
    const iso = wallTimeToIso(value, timeZone);
    if (!iso) {
      setError("Pick a date and time first.");
      return;
    }
    setError(null);
    set.mutate(iso, {
      onSuccess: () => toast({ title: "Last visit set", tone: "success" }),
      onError: (e) => setError(errorMessage(e) ?? "Could not set the last visit."),
    });
  };
  const onClear = () => {
    setError(null);
    clear.mutate(undefined, {
      onSuccess: () => {
        setValue("");
        toast({ title: "Back to automatic", tone: "success" });
      },
      onError: (e) => setError(errorMessage(e) ?? "Could not go back to automatic."),
    });
  };

  return (
    <div className="briefvisit">
      <p className="briefvisit__lead">For testing the Daily Brief: pretend you were last here at this time.</p>
      <dl className="briefvisit__facts">
        <dt className="briefvisit__label">Counting from</dt>
        <dd className="briefvisit__value" data-testid="brief-visit-from">
          {brief.visit_from ? when(brief.visit_from) : "automatic (your real last visit)"}
        </dd>
        <dt className="briefvisit__label">Last seen</dt>
        <dd className="briefvisit__value" data-testid="brief-last-seen">
          {when(brief.last_seen_at)}
        </dd>
      </dl>
      <div className="briefvisit__form">
        <Input
          className="briefvisit__input"
          type="datetime-local"
          aria-label="Pretend last visit"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button loading={set.isPending} onClick={onSet}>
          Set
        </Button>
        <Button variant="ghost" loading={clear.isPending} onClick={onClear}>
          Back to automatic
        </Button>
      </div>
      {error && (
        <p className="briefvisit__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function BriefVisitCard() {
  const q = useBrief();
  return (
    <Card
      title="Daily Brief: last visit"
      subtitle="Set the time the Daily Brief counts changes from (for testing)"
      collapsibleId="diagnostics.brief-visit"
    >
      {q.isError && !q.data ? (
        <ErrorState onRetry={() => void q.refetch()} />
      ) : q.isPending ? (
        <Skeleton height="96px" />
      ) : (
        <Body brief={q.data as BriefVisitDto} />
      )}
    </Card>
  );
}
