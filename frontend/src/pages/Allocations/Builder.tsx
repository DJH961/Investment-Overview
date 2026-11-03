import clsx from "clsx";
import { Ban } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { ErrorState } from "../../components/ErrorState";
import { Field } from "../../components/Field";
import { Input } from "../../components/Input";
import { Percent } from "../../components/Percent";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Switch } from "../../components/Switch";
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
} from "./builderState";
import { NowTargetBar } from "./DriftCard";
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

/** Target % input with the unit inside its right edge. */
function PctInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <span className="allocations__pct">
      <Input aria-label={label} inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} />
      <span className="allocations__pct-unit" aria-hidden>
        %
      </span>
    </span>
  );
}

/** A typed percent as a fraction (junk counts as 0). */
const typed = (v: string | undefined) => (Number(v) || 0) / 100;

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
  // Fund rows grouped under their category, in the categories' order.
  const groups = useMemo(() => {
    const seen = new Set<number>();
    const out = inputs.categories.map((c) => {
      const members = c.members.flatMap((m) => byId.get(m) ?? []);
      members.forEach((m) => seen.add(m.instrument_id));
      return { name: c.name, current: Number(c.current_pct ?? 0), members };
    });
    const rest = inputs.instruments.filter((i) => !seen.has(i.instrument_id));
    if (rest.length) out.push({ name: "Other", current: rest.reduce((a, i) => a + Number(i.current_pct ?? 0), 0), members: rest });
    return out.filter((g) => g.members.length > 0);
  }, [inputs.categories, inputs.instruments, byId]);
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
  // Bars in the editor share one scale: the largest current or typed share.
  const scale = Math.max(...rows.map((r) => Math.max(Number(r.current_pct ?? 0), typed(weights[r.key]))), 0.0001);

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
      <Card title="1 · How much are you investing?" className="allocations__invest">
        <div className="allocations__step">
          <div className="allocations__amount">
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
          </div>
          <div className="allocations__switches">
            <Switch
              label="Fractional shares"
              hint="Buy parts of a share when your broker allows it."
              checked={fractional}
              onCheckedChange={setFractional}
            />
            <Switch
              label="Allow selling (rebalance)"
              hint="Sell what is over target instead of only buying."
              checked={allowSell}
              onCheckedChange={setAllowSell}
            />
          </div>
        </div>
      </Card>

      <Card
        className="allocations__mix"
        title="2 · Target mix"
        subtitle="Bar: today's share. Line: your target."
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

        {mode === "fund" ? (
          <div className="allocations__edit-groups">
            {groups.map((g) => {
              const sum = g.members.reduce((a, i) => a + typed(fundW[String(i.instrument_id)]), 0);
              return (
                <section key={g.name} className="allocations__edit-group" aria-label={g.name}>
                  <header className="allocations__edit-head">
                    <h3 className="allocations__edit-title">{g.name}</h3>
                    <span className="allocations__edit-sum">
                      now <Percent ratio={g.current} digits={1} /> · target{" "}
                      <span className="allocations__edit-sum-value">{formatNumber(sum * 100, 1)} %</span>
                    </span>
                  </header>
                  <ul className="allocations__rows">
                    {g.members.map((i) => {
                      const k = String(i.instrument_id);
                      const now = Number(i.current_pct ?? 0);
                      return (
                        <li key={k} className={clsx("allocations__row", noBuy[k] && "allocations__row--skipped")}>
                          <span className="allocations__row-who">
                            <span className="allocations__row-label">{i.symbol}</span>
                            {i.name && i.name !== i.symbol && (
                              <span className="allocations__row-name" title={i.name}>
                                {i.name}
                              </span>
                            )}
                          </span>
                          <span className="allocations__row-bar">
                            <NowTargetBar now={now} target={typed(fundW[k])} scale={scale} />
                            <span className="allocations__row-now">
                              now <Percent ratio={now} digits={1} />
                            </span>
                          </span>
                          <PctInput
                            label={`Target % for ${i.symbol}`}
                            value={fundW[k] ?? ""}
                            onChange={(v) => setFundW((w) => ({ ...w, [k]: v }))}
                          />
                          <button
                            type="button"
                            className="allocations__nobuy"
                            aria-pressed={Boolean(noBuy[k])}
                            aria-label={`Don't buy ${i.symbol}`}
                            title="Keep its weight but never buy more of it"
                            onClick={() => setNoBuy((n) => ({ ...n, [k]: !n[k] }))}
                          >
                            <Ban className="allocations__nobuy-icon" aria-hidden />
                            <span className="allocations__nobuy-text">No buy</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        ) : (
          <ul className="allocations__rows allocations__rows--categories">
            {inputs.categories.map((c) => {
              const now = Number(c.current_pct ?? 0);
              const picked = selected[c.name] ?? [];
              return (
                <li key={c.name} className="allocations__row allocations__row--category">
                  <span className="allocations__row-who">
                    <span className="allocations__row-label">{c.name}</span>
                    <span className="allocations__row-name">
                      {c.members.length} {c.members.length === 1 ? "fund" : "funds"}
                    </span>
                  </span>
                  <span className="allocations__row-bar">
                    <NowTargetBar now={now} target={typed(catW[c.name])} scale={scale} />
                    <span className="allocations__row-now">
                      now <Percent ratio={now} digits={1} />
                    </span>
                  </span>
                  <PctInput
                    label={`Target % for ${c.name}`}
                    value={catW[c.name] ?? ""}
                    onChange={(v) => setCatW((w) => ({ ...w, [c.name]: v }))}
                  />
                  <details className="allocations__members">
                    <summary className="allocations__members-toggle">
                      Funds in this category ({picked.length}/{c.members.length}) ·{" "}
                      {(split[c.name] ?? "value") === "value" ? "fair by value" : "even split"}
                    </summary>
                    <div className="allocations__members-body">
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
                      <span className="allocations__chips">
                        {c.members.map((m) => {
                          const inst = byId.get(m);
                          return (
                            <label key={m} className="allocations__check">
                              <input
                                type="checkbox"
                                className="allocations__check-box"
                                checked={picked.includes(m)}
                                onChange={(e) => toggleMember(c.name, m, e.target.checked)}
                              />
                              <span className="allocations__check-label">{inst?.symbol ?? m}</span>
                              <Percent ratio={Number(inst?.current_pct ?? 0)} digits={1} />
                            </label>
                          );
                        })}
                      </span>
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        )}

        {/* Sticky: the total and the actions stay in reach while editing a long list. */}
        <div className={clsx("allocations__footer", off && "allocations__footer--off")}>
          <div className="allocations__sum">
            <p className="allocations__sum-line" aria-live="polite" data-testid="weight-total">
              <span className="allocations__sum-label">Total</span>
              <span className="allocations__sum-value">{formatNumber(total, 1)} %</span>
              <span className="allocations__sum-note">{off ? "will be scaled to 100 %" : "sums to 100 %"}</span>
            </p>
            <div className="allocations__total-bar" aria-hidden>
              <span className="allocations__total-fill" style={{ width: `${Math.min(total, 100)}%` }} />
            </div>
          </div>
          <div className="allocations__actions">
            <Button
              variant="secondary"
              onClick={() => setSaveOpen(true)}
              disabled={!saveItems || saveItems.length === 0}
              title={saveItems ? undefined : "Compute the plan first to save a category mix"}
            >
              Save as target…
            </Button>
            <Button className="allocations__compute" variant="primary" onClick={() => plan.mutate(request())} loading={plan.isPending}>
              Compute plan
            </Button>
          </div>
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
