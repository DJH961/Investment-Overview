import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { ErrorState } from "../../components/ErrorState";
import { IconButton } from "../../components/IconButton";
import { Input } from "../../components/Input";
import { Select } from "../../components/Select";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { api } from "../../lib/api";
import type { components } from "../../lib/api-types";
import { useAccounts } from "../../lib/queries/accounts";
import { useInstruments } from "../../lib/queries/instruments";
import { errorMessage } from "../../lib/queries/settings";

type Entry = components["schemas"]["ShareCountEntry"];
type Counts = components["schemas"]["ShareCountsOut"];

const KEY = ["diagnostics", "share-counts"] as const;

export function useShareCounts() {
  return useQuery({ queryKey: KEY, queryFn: ({ signal }) => api<Counts>("/api/diagnostics/share-counts", { signal }) });
}

/** Replaces the whole list; the checks are refetched because the server compares on every read. */
export function useSaveShareCounts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (counts: Entry[]) => api<Counts>("/api/diagnostics/share-counts", { method: "PUT", body: { counts } }),
    onSuccess: (data) => {
      if (data && Array.isArray(data.counts)) qc.setQueryData(KEY, data);
      return qc.invalidateQueries({ queryKey: ["diagnostics"] });
    },
  });
}

export interface Draft {
  key: number;
  account: string;
  instrument: string;
  shares: string;
}

const SHARES = /^\d+(\.\d+)?$/;

/** Why a draft cannot be saved, or null. A blank row is ignored on save, not an error. */
export function draftError(rows: Draft[]): string | null {
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.account && !r.instrument && !r.shares.trim()) continue;
    if (!r.account || !r.instrument) return "Pick an account and a holding on every row.";
    if (!SHARES.test(r.shares.trim())) return "Shares must be a number of zero or more, like 12.5.";
    const pair = `${r.account}:${r.instrument}`;
    if (seen.has(pair)) return "Each account and holding can be listed only once.";
    seen.add(pair);
  }
  return null;
}

let nextKey = 1;
const blank = (): Draft => ({ key: nextKey++, account: "", instrument: "", shares: "" });

function Editor({ counts }: { counts: Entry[] }) {
  const accounts = useAccounts();
  const instruments = useInstruments();
  const save = useSaveShareCounts();
  const { toast } = useToast();
  const [rows, setRows] = useState<Draft[]>(() =>
    counts.map((c) => ({ key: nextKey++, account: String(c.account_id), instrument: String(c.instrument_id), shares: c.shares })),
  );
  const [touched, setTouched] = useState(false);

  const accountOptions = useMemo(
    () => (accounts.data ?? []).map((a) => ({ value: String(a.id), label: a.account_label })),
    [accounts.data],
  );
  const instrumentOptions = useMemo(
    () => (instruments.data ?? []).map((i) => ({ value: String(i.id), label: `${i.symbol}${i.name ? ` · ${i.name}` : ""}` })),
    [instruments.data],
  );

  const error = touched ? draftError(rows) : null;
  const patch = (key: number, p: Partial<Draft>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));

  const submit = (list: Draft[]) => {
    const payload: Entry[] = list
      .filter((r) => r.account && r.instrument)
      .map((r) => ({ account_id: Number(r.account), instrument_id: Number(r.instrument), shares: r.shares.trim() }));
    save.mutate(payload, {
      onSuccess: () => toast({ title: payload.length ? "Share counts saved" : "Share-count check switched off", tone: "success" }),
      onError: (e) => toast({ title: "Could not save the share counts", description: errorMessage(e), tone: "error" }),
    });
  };
  const onSave = () => {
    setTouched(true);
    if (draftError(rows)) return;
    submit(rows);
  };
  const onClear = () => {
    setRows([]);
    setTouched(false);
    submit([]);
  };

  return (
    <div className="sharecounts">
      <p className="sharecounts__lead">
        Optional. Type the number of shares your broker shows for each holding; Health compares them with the ledger and
        lists differences as hints. Nothing is ever changed automatically.
      </p>
      <ul className="sharecounts__rows">
        {rows.map((r, i) => (
          <li key={r.key} className="sharecounts__row">
            <Select
              className="sharecounts__cell"
              ariaLabel={`Account, row ${i + 1}`}
              placeholder="Account"
              options={accountOptions}
              value={r.account}
              onValueChange={(v) => patch(r.key, { account: v })}
            />
            <Select
              className="sharecounts__cell"
              ariaLabel={`Holding, row ${i + 1}`}
              placeholder="Holding"
              options={instrumentOptions}
              value={r.instrument}
              onValueChange={(v) => patch(r.key, { instrument: v })}
            />
            <Input
              className="sharecounts__cell"
              aria-label={`Shares at the broker, row ${i + 1}`}
              inputMode="decimal"
              placeholder="Shares"
              value={r.shares}
              onChange={(e) => patch(r.key, { shares: e.target.value })}
            />
            <IconButton
              className="sharecounts__remove"
              size="sm"
              label={`Remove row ${i + 1}`}
              icon={<Trash2 aria-hidden />}
              onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
            />
          </li>
        ))}
      </ul>
      {error && (
        <p className="sharecounts__error" role="alert">
          {error}
        </p>
      )}
      <div className="sharecounts__actions">
        <Button variant="secondary" leftIcon={<Plus aria-hidden />} onClick={() => setRows((rs) => [...rs, blank()])}>
          Add a holding
        </Button>
        <Button loading={save.isPending} onClick={onSave}>
          Save counts
        </Button>
        {counts.length > 0 && (
          <Button variant="ghost" disabled={save.isPending} onClick={onClear}>
            Switch the check off
          </Button>
        )}
      </div>
    </div>
  );
}

export function ShareCountsCard() {
  const q = useShareCounts();
  return (
    <Card
      title="Broker share counts"
      subtitle="Optional cross-check against your broker"
      collapsibleId="diagnostics.share-counts"
      defaultOpen={false}
    >
      {q.isError && !q.data ? (
        <ErrorState onRetry={() => void q.refetch()} />
      ) : q.isPending ? (
        <Skeleton height="96px" />
      ) : (
        <Editor counts={q.data.counts ?? []} />
      )}
    </Card>
  );
}
