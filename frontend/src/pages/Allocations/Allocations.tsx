import { PieChart } from "lucide-react";
import { useMemo, useState } from "react";
import { AllocationBar } from "../../components/AllocationBar";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { DataTable, type Column } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { Field } from "../../components/Field";
import { Input } from "../../components/Input";
import { Money } from "../../components/Money";
import { PageHeader } from "../../components/PageHeader";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { ApiError } from "../../lib/api";
import { formatNumber, formatPercent } from "../../lib/format";
import { usePrefs } from "../../lib/prefs";
import {
  useAllocations,
  useRebalance,
  useSaveTarget,
  type AllocationsData,
  type RebalancePlan,
} from "../../lib/queries/manage";
import "./Allocations.scss";

type DriftRow = AllocationsData["drift"][number];
type PlanRow = RebalancePlan["rows"][number];

interface EditorRow {
  instrumentId: number;
  label: string;
  weight: string;
  noBuy: boolean;
}

/** Live total of the typed weights (display only; the server normalises). */
export function totalWeight(rows: Pick<EditorRow, "weight">[]): number {
  return rows.reduce((a, r) => a + (Number(r.weight) || 0), 0);
}

function Editor({ data }: { data: AllocationsData }) {
  const save = useSaveTarget();
  const { toast } = useToast();
  const target = data.targets.find((t) => t.id === data.active_target_id) ?? data.targets[0];
  const [name, setName] = useState(target?.name ?? "Target");
  const [rows, setRows] = useState<EditorRow[]>(() =>
    data.drift.map((d) => {
      const item = target?.items.find((i) => i.instrument_id === d.instrument_id);
      return { instrumentId: d.instrument_id, label: d.label, weight: item ? String(Number(item.weight_pct) * 100) : "0", noBuy: item?.no_buy ?? false };
    }),
  );
  const total = totalWeight(rows);
  const off = Math.abs(total - 100) > 0.005;
  const update = (i: number, patch: Partial<EditorRow>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const submit = () =>
    save.mutate(
      {
        id: target?.id ?? null,
        name: name.trim() || "Target",
        active: true,
        allow_sell: target?.allow_sell ?? false,
        items: rows
          .filter((r) => Number(r.weight) > 0)
          .map((r) => ({ instrument_id: r.instrumentId, weight_pct: String(Number(r.weight) / 100), no_buy: r.noBuy })),
      },
      {
        onSuccess: () => toast({ title: "Target saved", tone: "success" }),
        onError: (e) => toast({ title: "Could not save", description: e instanceof ApiError ? e.message : undefined, tone: "error" }),
      },
    );

  return (
    <Card
      title="Target allocation"
      subtitle="Enter a target % per fund. Totals are normalised to 100 % on save, so you can sketch freely."
      actions={
        <Button onClick={submit} loading={save.isPending}>
          Save target
        </Button>
      }
    >
      <div className="allocations__editor">
        <Field label="Target name">{(c) => <Input {...c} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <ul className="allocations__rows">
          {rows.map((r, i) => (
            <li key={r.instrumentId} className="allocations__row">
              <span className="allocations__row-label">{r.label}</span>
              <Input
                aria-label={`Target % for ${r.label}`}
                inputMode="decimal"
                value={r.weight}
                onChange={(e) => update(i, { weight: e.target.value })}
              />
              <label className="allocations__check">
                <input type="checkbox" checked={r.noBuy} onChange={(e) => update(i, { noBuy: e.target.checked })} />
                No buy
              </label>
            </li>
          ))}
        </ul>
        <p
          className={off ? "allocations__total allocations__total--off" : "allocations__total"}
          aria-live="polite"
          data-testid="weight-total"
        >
          Total: {formatNumber(total, 2)} %{off ? " (will be normalised to 100 %)" : ""}
        </p>
      </div>
    </Card>
  );
}

function Rebalance({ ccy, targetId }: { ccy: "EUR" | "USD"; targetId?: number }) {
  const run = useRebalance();
  const [amount, setAmount] = useState("");
  const [fractional, setFractional] = useState(true);
  const [allowSell, setAllowSell] = useState(false);
  const plan = run.data;

  const columns: Column<PlanRow>[] = [
    { key: "symbol", header: "Fund", primary: true, cell: (r) => r.symbol, sortValue: (r) => r.symbol },
    { key: "target", header: "Target", align: "right", cell: (r) => formatPercent(Number(r.target_pct), { digits: 1 }) },
    {
      key: "value",
      header: "Current value",
      align: "right",
      cell: (r) => (r.current_value ? <Money amount={Number(r.current_value)} currency={ccy} /> : "–"),
    },
    {
      key: "add",
      header: "Add",
      align: "right",
      cell: (r) => (r.add_value ? <Money amount={Number(r.add_value)} currency={ccy} signed colored /> : "–"),
      sortValue: (r) => Number(r.add_value ?? 0),
    },
    { key: "shares", header: "Shares", align: "right", cell: (r) => formatNumber(Number(r.add_shares), 3) },
  ];

  return (
    <Card title="Rebalance plan" subtitle="How to split new money so you move toward the target.">
      <form
        className="allocations__plan-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (Number(amount) > 0) run.mutate({ amount, ccy, fractional, allowSell, targetId });
        }}
      >
        <Field label={`Amount to invest (${ccy})`}>
          {(c) => <Input {...c} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <label className="allocations__check">
          <input type="checkbox" checked={fractional} onChange={(e) => setFractional(e.target.checked)} />
          Allow fractional shares
        </label>
        <label className="allocations__check">
          <input type="checkbox" checked={allowSell} onChange={(e) => setAllowSell(e.target.checked)} />
          Allow selling
        </label>
        <Button type="submit" variant="secondary" loading={run.isPending}>
          Compute plan
        </Button>
      </form>
      {run.isError && <ErrorState message="Could not compute a plan." onRetry={() => run.reset()} />}
      {plan && (
        <>
          <DataTable
            caption="Rebalance plan"
            columns={columns}
            rows={plan.rows}
            rowKey={(r) => String(r.instrument_id)}
          />
          {plan.residual_cash && (
            <p className="allocations__total">
              Left over: <Money amount={Number(plan.residual_cash)} currency={plan.ccy} />
            </p>
          )}
        </>
      )}
    </Card>
  );
}

export function Allocations() {
  const { currency } = usePrefs();
  const q = useAllocations(currency);

  const hasDrift = (q.data?.drift.length ?? 0) > 0;
  const slices = useMemo(
    () =>
      hasDrift
        ? (q.data?.drift ?? []).map((d: DriftRow) => ({
            id: d.key,
            label: d.label,
            actual: Number(d.current_pct),
            target: Number(d.target_pct),
          }))
        : (q.data?.current_by_asset_class ?? []).map((b) => ({ id: b.label, label: b.label, actual: Number(b.pct) })),
    [q.data, hasDrift],
  );

  const driftColumns: Column<DriftRow>[] = [
    { key: "label", header: "Fund", primary: true, cell: (r) => r.label, sortValue: (r) => r.label },
    { key: "cur", header: "Current", align: "right", cell: (r) => formatPercent(Number(r.current_pct), { digits: 1 }) },
    { key: "tgt", header: "Target", align: "right", cell: (r) => formatPercent(Number(r.target_pct), { digits: 1 }) },
    {
      key: "drift",
      header: "Drift",
      align: "right",
      cell: (r) => `${Number(r.drift_pp) > 0 ? "+" : ""}${formatNumber(Number(r.drift_pp), 1)} pp`,
      sortValue: (r) => Math.abs(Number(r.drift_pp)),
    },
    {
      key: "delta",
      header: "To reach target",
      align: "right",
      cell: (r) => (r.delta_value ? <Money amount={Number(r.delta_value)} currency={currency} signed colored /> : "–"),
    },
  ];

  return (
    <div className="allocations">
      <PageHeader title="Allocations" subtitle="Targets, drift and a rebalance plan." />
      {q.isError ? (
        <ErrorState onRetry={() => void q.refetch()} />
      ) : q.isPending ? (
        <Skeleton height="260px" />
      ) : q.data.drift.length === 0 && q.data.current_by_asset_class.length === 0 ? (
        <EmptyState
          icon={<PieChart aria-hidden />}
          title="No positions yet"
          description="Import transactions first, then set a target mix here."
        />
      ) : (
        <>
          <Card
            title={hasDrift ? "Current vs target" : "Current allocation"}
            subtitle={
              hasDrift
                ? "Drift: positive means over-allocated, negative under-allocated."
                : "No target set yet. Share of portfolio value by asset class."
            }
          >
            <AllocationBar slices={slices} ariaLabel="Current allocation with target markers" />
            {hasDrift && (
              <DataTable
                caption="Allocation drift"
                columns={driftColumns}
                rows={q.data.drift}
                rowKey={(r) => r.key}
              />
            )}
          </Card>
          {hasDrift && (
            <div className="allocations__split">
              <Editor key={q.data.active_target_id ?? "none"} data={q.data} />
              <Rebalance ccy={currency} targetId={q.data.active_target_id ?? undefined} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
