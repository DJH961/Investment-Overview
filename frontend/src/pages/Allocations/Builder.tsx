import { useMemo, useState } from "react";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { ErrorState } from "../../components/ErrorState";
import { Field } from "../../components/Field";
import { Input } from "../../components/Input";
import { Percent } from "../../components/Percent";
import { SegmentedControl } from "../../components/SegmentedControl";
import { ApiError } from "../../lib/api";
import { formatNumber } from "../../lib/format";
import type { ReportingCurrency } from "../../lib/prefs";
import { useBuilderPlan, type AllocationsData, type PlanRequest } from "../../lib/queries/allocations";
import type { CalculatorInputsOut } from "../../lib/queries/reports";
import { useSettingsValues } from "../../lib/queries/settings";
import { usePersistentState } from "../../lib/usePersistentState";
import {
  isOff,
  presetClear,
  presetCurrent,
  presetEqual,
  presetSaved,
  savedNoBuy,
  totalWeight,
  type Mode,
  type Split,
  type Weighable,
  type Weights,
} from "./builder";
import { PlanResult } from "./PlanResult";
import { SaveTargetDialog, type SaveItem } from "./SaveTargetDialog";

const isBoolOrNull = (v: unknown): v is boolean | null => v === null || typeof v === "boolean";
const isMode = (v: unknown): v is Mode => v === "fund" || v === "category";
const isCcy = (v: unknown): v is ReportingCurrency => v === "EUR" || v === "USD";

/** A device choice wins; otherwise the server default from Settings; otherwise false. */
function useCalcToggle(key: string, settingKey: string) {
  const settings = useSettingsValues();
  const [stored, setStored] = usePersistentState<boolean | null>(key, null, isBoolOrNull);
  const fallback = settings.data?.[settingKey]?.value;
  return [stored ?? (typeof fallback === "boolean" ? fallback : false), setStored] as const;
}

export interface BuilderProps {
  inputs: CalculatorInputsOut;
  allocations: AllocationsData;
  defaultCcy: ReportingCurrency;
}

export function Builder({ inputs, allocations, defaultCcy }: BuilderProps) {
  const plan = useBuilderPlan();
  const [amount, setAmount] = usePersistentState("calc.amount", "1000");
  const [ccy, setCcy] = usePersistentState<ReportingCurrency>("calc.ccy", defaultCcy, isCcy);
  const [fractional, setFractional] = useCalcToggle("calc.fractional", "chart_pref.calc.allow_fractional");
  const [allowSell, setAllowSell] = useCalcToggle("calc.rebalance", "chart_pref.calc.rebalance");
  const [mode, setMode] = usePersistentState<Mode>("calc.mode", "fund", isMode);
  const [saveOpen, setSaveOpen] = useState(false);

  const funds: Weighable[] = useMemo(
    () => inputs.instruments.map((i) => ({ key: String(i.instrument_id), current_pct: i.current_pct })),
    [inputs.instruments],
  );
  const cats: Weighable[] = useMemo(
    () => inputs.categories.map((c) => ({ key: c.name, current_pct: c.current_pct })),
    [inputs.categories],
  );
  const byId = useMemo(() => new Map(inputs.instruments.map((i) => [i.instrument_id, i])), [inputs.instruments]);
  const active = allocations.targets.find((t) => t.id === allocations.active_target_id);

  const [fundW, setFundW] = useState<Weights>(() => (active ? presetSaved(funds, active) : presetCurrent(funds)));
  const [noBuy, setNoBuy] = useState<Record<string, boolean>>(() => (active ? savedNoBuy(active) : {}));
  const [catW, setCatW] = useState<Weights>(() => presetCurrent(cats));
  const [split, setSplit] = useState<Record<string, Split>>({});
  const [selected, setSelected] = useState<Record<string, number[]>>(() =>
    Object.fromEntries(
      inputs.categories.map((c) => {
        const held = c.members.filter((m) => Number(byId.get(m)?.current_pct ?? 0) > 0);
        return [c.name, held.length ? held : c.members];
      }),
    ),
  );

  const rows = mode === "fund" ? funds : cats;
  const weights = mode === "fund" ? fundW : catW;
  const setWeights = mode === "fund" ? setFundW : setCatW;
  const total = totalWeight(weights);
  const off = isOff(total);

  const request = (): PlanRequest => ({
    amount: amount || "0",
    ccy,
    fractional,
    allow_sell: allowSell,
    mode,
    fund_weights:
      mode === "fund"
        ? funds
            .filter((f) => Number(fundW[f.key]) > 0 || noBuy[f.key])
            .map((f) => ({ instrument_id: Number(f.key), weight: fundW[f.key] || "0", no_buy: Boolean(noBuy[f.key]) }))
        : [],
    category_weights:
      mode === "category"
        ? inputs.categories.map((c) => ({
            name: c.name,
            weight: catW[c.name] || "0",
            split: split[c.name] ?? "value",
            selected: selected[c.name] ?? [],
          }))
        : [],
  });

  const result = plan.data && plan.data.mode === mode ? plan.data : undefined;
  const saveItems: SaveItem[] | null =
    mode === "fund"
      ? funds
          .filter((f) => Number(fundW[f.key]) > 0)
          .map((f) => ({ instrument_id: Number(f.key), weight_pct: fundW[f.key], no_buy: Boolean(noBuy[f.key]) }))
      : result
        ? result.rows
            .filter((r) => !r.held_unticked && Number(r.target_pct) > 0)
            .map((r) => ({ instrument_id: r.instrument_id, weight_pct: String(Number(r.target_pct) * 100), no_buy: r.no_buy }))
        : null;

  const toggleMember = (cat: string, id: number, on: boolean) =>
    setSelected((s) => {
      const cur = s[cat] ?? [];
      return { ...s, [cat]: on ? [...cur, id] : cur.filter((m) => m !== id) };
    });

  return (
    <>
      <Card title="1 · How much are you investing?">
        <div className="allocations__step">
          <Field label={`Cash to invest (${ccy})`}>
            {(c) => <Input {...c} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
          </Field>
          <SegmentedControl
            ariaLabel="Cash currency"
            options={[
              { value: "EUR", label: "EUR" },
              { value: "USD", label: "USD" },
            ]}
            value={ccy}
            onChange={setCcy}
          />
          <label className="allocations__check">
            <input type="checkbox" checked={fractional} onChange={(e) => setFractional(e.target.checked)} />
            Fractional shares
          </label>
          <label className="allocations__check">
            <input type="checkbox" checked={allowSell} onChange={(e) => setAllowSell(e.target.checked)} />
            Allow selling (rebalance)
          </label>
        </div>
      </Card>

      <Card
        title="2 · Target mix"
        subtitle="Totals are normalised to 100 % when the plan is computed, so you can sketch freely."
        actions={
          <SegmentedControl
            ariaLabel="Target mode"
            size="sm"
            options={[
              { value: "category", label: "By category" },
              { value: "fund", label: "By fund" },
            ]}
            value={mode}
            onChange={setMode}
          />
        }
      >
        <div className="allocations__presets">
          <Button size="sm" variant="secondary" onClick={() => setWeights(presetCurrent(rows))}>
            Match current mix
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setWeights(presetEqual(rows))}>
            Equal weight
          </Button>
          {mode === "fund" && active && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setFundW(presetSaved(funds, active));
                setNoBuy(savedNoBuy(active));
              }}
            >
              Load saved target
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setWeights(presetClear(rows))}>
            Clear
          </Button>
        </div>

        <ul className="allocations__rows">
          {mode === "fund"
            ? inputs.instruments.map((i) => {
                const k = String(i.instrument_id);
                return (
                  <li key={k} className="allocations__row">
                    <span className="allocations__row-label" title={i.name}>
                      {i.symbol}
                    </span>
                    <Percent ratio={Number(i.current_pct ?? 0)} digits={1} className="allocations__row-now" />
                    <Input
                      aria-label={`Target % for ${i.symbol}`}
                      inputMode="decimal"
                      value={fundW[k] ?? ""}
                      onChange={(e) => setFundW((w) => ({ ...w, [k]: e.target.value }))}
                    />
                    <label className="allocations__check">
                      <input
                        type="checkbox"
                        checked={Boolean(noBuy[k])}
                        onChange={(e) => setNoBuy((n) => ({ ...n, [k]: e.target.checked }))}
                      />
                      No buy
                    </label>
                  </li>
                );
              })
            : inputs.categories.map((c) => (
                <li key={c.name} className="allocations__row allocations__row--category">
                  <span className="allocations__row-label">{c.name}</span>
                  <Percent ratio={Number(c.current_pct ?? 0)} digits={1} className="allocations__row-now" />
                  <Input
                    aria-label={`Target % for ${c.name}`}
                    inputMode="decimal"
                    value={catW[c.name] ?? ""}
                    onChange={(e) => setCatW((w) => ({ ...w, [c.name]: e.target.value }))}
                  />
                  <details className="allocations__members">
                    <summary className="allocations__members-toggle">
                      Funds in this category ({(selected[c.name] ?? []).length}/{c.members.length})
                    </summary>
                    <SegmentedControl
                      ariaLabel={`Split for ${c.name}`}
                      size="sm"
                      options={[
                        { value: "value", label: "Fair by value" },
                        { value: "even", label: "Even" },
                      ]}
                      value={split[c.name] ?? "value"}
                      onChange={(v) => setSplit((s) => ({ ...s, [c.name]: v }))}
                    />
                    {c.members.map((m) => {
                      const inst = byId.get(m);
                      return (
                        <label key={m} className="allocations__check">
                          <input
                            type="checkbox"
                            checked={(selected[c.name] ?? []).includes(m)}
                            onChange={(e) => toggleMember(c.name, m, e.target.checked)}
                          />
                          {inst?.symbol ?? m}
                          <Percent ratio={Number(inst?.current_pct ?? 0)} digits={1} />
                        </label>
                      );
                    })}
                  </details>
                </li>
              ))}
        </ul>

        <div className="allocations__total-bar" aria-hidden>
          <span
            className={off ? "allocations__total-fill allocations__total-fill--off" : "allocations__total-fill"}
            style={{ width: `${Math.min(total, 100)}%` }}
          />
        </div>
        <p
          className={off ? "allocations__total allocations__total--off" : "allocations__total"}
          aria-live="polite"
          data-testid="weight-total"
        >
          Total: {formatNumber(total, 2)} % {off ? "(will be normalised to 100 %)" : "· sums to 100 %"}
        </p>

        <div className="allocations__actions">
          <Button onClick={() => plan.mutate(request())} loading={plan.isPending}>
            Compute plan
          </Button>
          <Button
            variant="secondary"
            onClick={() => setSaveOpen(true)}
            disabled={!saveItems || saveItems.length === 0}
            title={saveItems ? undefined : "Compute the plan first to save a category mix"}
          >
            Save as target…
          </Button>
        </div>
      </Card>

      {plan.isError && (
        <ErrorState
          message={plan.error instanceof ApiError ? plan.error.message : "Could not compute a plan."}
          onRetry={() => plan.reset()}
        />
      )}
      {result && <PlanResult plan={result} />}

      {saveOpen && (
        <SaveTargetDialog
        open
        onOpenChange={setSaveOpen}
        targets={allocations.targets}
        activeId={allocations.active_target_id ?? null}
        items={saveItems ?? []}
        allowSell={allowSell}
        symbolOf={(id) => byId.get(id)?.symbol ?? String(id)}
        />
      )}
    </>
  );
}
