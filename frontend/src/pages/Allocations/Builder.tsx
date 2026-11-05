import clsx from "clsx";
import { Ban, Check } from "lucide-react";
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
  type CategoryEditor,
  effectiveSelection,
  fromSavedBuilder,
  toSavedBuilder,
  type SavedBuilder,
  isEtfClass,
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

/** A short kind badge for a fund chip ("ETF", "Fund", "Stock"). */
function kindLabel(assetClass: string | null | undefined): string {
  const c = (assetClass ?? "").toLowerCase();
  if (c === "etf") return "ETF";
  if (c === "mutual_fund") return "Fund";
  if (c === "stock" || c === "equity") return "Stock";
  return c ? c.replace(/_/g, " ") : "";
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
  const [etfOnly, setEtfOnly] = usePersistentState<boolean>("calc.etfOnly", false, (v): v is boolean => typeof v === "boolean");
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
  const memberMap = useMemo(
    () => Object.fromEntries(inputs.categories.map((c) => [c.name, c.members])),
    [inputs.categories],
  );
  // The category editor starts from the active target's saved selection when it has one.
  const [initialCats] = useState<CategoryEditor>(() => {
    const fresh: CategoryEditor = {
      weights: presetCurrent(cats),
      split: {},
      selected: Object.fromEntries(
        inputs.categories.map((c) => {
          const held = c.members.filter((m) => Number(byId.get(m)?.current_pct ?? 0) > 0);
          return [c.name, held.length ? held : c.members];
        }),
      ),
    };
    return active?.builder ? fromSavedBuilder(active.builder as SavedBuilder, memberMap, fresh) : fresh;
  });
  const [catW, setCatW] = useState<Weights>(initialCats.weights);
  const [split, setSplit] = useState<Record<string, Split>>(initialCats.split);
  const [selected, setSelected] = useState<Record<string, number[]>>(initialCats.selected);

  /** Load a saved target into the calculator: its fund weights, no-buy flags, rebalance toggle and, when saved, its category selection, mode and ETF-only. */
  const loadTarget = (t: NonNullable<typeof active>) => {
    setFundW(presetSaved(funds, t));
    setNoBuy(savedNoBuy(t));
    setAllowSell(t.allow_sell);
    const b = t.builder as SavedBuilder | null | undefined;
    if (b) {
      const ed = fromSavedBuilder(b, memberMap, { weights: catW, split, selected });
      setCatW(ed.weights);
      setSplit(ed.split);
      setSelected(ed.selected);
      setEtfOnly(b.etf_only);
      setMode(b.mode);
    }
  };

  const isEtfId = (id: number) => isEtfClass(byId.get(id)?.asset_class);
  const memberIds = (cat: string) => inputs.categories.find((c) => c.name === cat)?.members ?? [];
  const effectiveFor = (cat: string) => effectiveSelection(memberIds(cat), selected[cat] ?? [], etfOnly, isEtfId);

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
            selected: effectiveFor(c.name).ids,
          }))
        : [],
  });

  // The request the shown plan was computed for: a category mix is saved from
  // the plan's fund targets, so only while the inputs still match it.
  const [planKey, setPlanKey] = useState<string | null>(null);
  const currentKey = JSON.stringify(request());
  const compute = () => {
    setPlanKey(currentKey);
    plan.mutate(request());
  };

  // A new computation clears `plan.data`; keep showing the last plan (marked as updating).
  const [lastPlan, setLastPlan] = useState(plan.data);
  if (plan.data && plan.data !== lastPlan) setLastPlan(plan.data);
  const shown = plan.data ?? lastPlan;
  const result = shown && shown.mode === mode ? shown : undefined;
  const saveItems: SaveItem[] | null =
    mode === "fund"
      ? funds
          .filter((f) => Number(fundW[f.key]) > 0)
          .map((f) => ({ instrument_id: Number(f.key), weight_pct: fundW[f.key], no_buy: Boolean(noBuy[f.key]) }))
      : result && planKey === currentKey
        ? result.rows
            .filter((r) => !r.held_unticked && Number(r.target_pct) > 0)
            .map((r) => ({ instrument_id: r.instrument_id, weight_pct: String(Number(r.target_pct) * 100), no_buy: r.no_buy }))
        : null;

  /** Tick or untick a fund for new money (with ETF-only on, only the ETF ticks change; the rest are kept for later). */
  const toggleFund = (cat: string, id: number, on: boolean) =>
    setSelected((s) => {
      const eff = effectiveSelection(memberIds(cat), s[cat] ?? [], etfOnly, isEtfId);
      const next = on ? [...eff.ids, id] : eff.ids.filter((m) => m !== id);
      if (!eff.etfOnlyApplies) return { ...s, [cat]: next };
      const kept = (s[cat] ?? []).filter((m) => !isEtfId(m));
      return { ...s, [cat]: [...kept, ...next.filter(isEtfId)] };
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
          {active && (mode === "fund" || active.builder) && (
            <Button
              size="sm"
              variant="secondary"
              title={`Load "${active.name}" (weights, selection and rebalance setting)`}
              onClick={() => loadTarget(active)}
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
          <>
            <div className="allocations__etf-bar">
              <button
                type="button"
                className="allocations__etf-toggle"
                aria-pressed={etfOnly}
                onClick={() => setEtfOnly(!etfOnly)}
              >
                <span className="allocations__etf-box" aria-hidden>
                  {etfOnly ? <Check className="allocations__etf-icon" /> : null}
                </span>
                Invest only in ETFs
              </button>
              <span className="allocations__etf-note">
                {etfOnly
                  ? "Mutual funds and stocks stay held and count toward their category, but get no new money."
                  : "One tap to leave mutual funds and stocks out of the new money."}
              </span>
            </div>
            <ul className="allocations__cats">
              {inputs.categories.map((c) => {
                const now = Number(c.current_pct ?? 0);
                const target = typed(catW[c.name]);
                const eff = effectiveFor(c.name);
                const splitMode = split[c.name] ?? "value";
                const idle = target <= 0;
                return (
                  <li key={c.name} className={clsx("allocations__cat", idle && "allocations__cat--idle")}>
                    <div className="allocations__cat-head">
                      <span className="allocations__row-who">
                        <span className="allocations__row-label">{c.name}</span>
                        <span className="allocations__row-name">
                          {eff.ids.length} of {c.members.length} {c.members.length === 1 ? "fund" : "funds"} get new money
                        </span>
                      </span>
                      <span className="allocations__row-bar">
                        <NowTargetBar now={now} target={target} scale={scale} />
                        <span className="allocations__row-now">
                          now <Percent ratio={now} digits={1} />
                        </span>
                      </span>
                      <PctInput
                        label={`Target % for ${c.name}`}
                        value={catW[c.name] ?? ""}
                        onChange={(v) => setCatW((w) => ({ ...w, [c.name]: v }))}
                      />
                    </div>
                    <fieldset className="allocations__cat-funds">
                      <legend className="allocations__sr">Funds in {c.name}</legend>
                      {c.members.map((m) => {
                        const inst = byId.get(m);
                        const on = eff.ids.includes(m);
                        const locked = eff.etfOnlyApplies && !isEtfId(m);
                        return (
                          <button
                            key={m}
                            type="button"
                            className={clsx("allocations__fund", on && "allocations__fund--on", locked && "allocations__fund--locked")}
                            aria-pressed={on}
                            disabled={locked}
                            title={locked ? "Held, gets no new money (Invest only in ETFs)" : on ? "Gets new money" : "Held only: no new money"}
                            onClick={() => toggleFund(c.name, m, !on)}
                          >
                            <span className="allocations__fund-box" aria-hidden>
                              {on ? <Check className="allocations__fund-icon" /> : null}
                            </span>
                            <span className="allocations__fund-symbol">{inst?.symbol ?? m}</span>
                            <span className="allocations__fund-kind">{kindLabel(inst?.asset_class)}</span>
                            <span className="allocations__fund-pct">
                              <Percent ratio={Number(inst?.current_pct ?? 0)} digits={1} />
                            </span>
                          </button>
                        );
                      })}
                      {eff.ids.length > 1 && (
                        <span className="allocations__cat-split">
                          <SegmentedControl
                            ariaLabel={`Split for ${c.name}`}
                            size="sm"
                            options={[
                              { value: "value", label: "Fair by value" },
                              { value: "even", label: "Even" },
                            ]}
                            value={splitMode}
                            onChange={(v) => setSplit((s) => ({ ...s, [c.name]: v }))}
                          />
                        </span>
                      )}
                    </fieldset>
                  </li>
                );
              })}
            </ul>
          </>
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
              title={saveItems ? undefined : "Compute the plan for this mix first, then save it"}
            >
              Save as target…
            </Button>
            <Button className="allocations__compute" variant="primary" onClick={compute} loading={plan.isPending}>
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
      {result && (
        <div aria-busy={plan.isPending}>
          {plan.isPending && (
            <p className="allocations__plan-note" aria-live="polite">
              Updating plan…
            </p>
          )}
          <PlanResult plan={result} stale={planKey !== currentKey} />
        </div>
      )}

      {saveOpen && (
        <SaveTargetDialog
          open
          onOpenChange={setSaveOpen}
          targets={allocations.targets}
          activeId={allocations.active_target_id ?? null}
          items={saveItems ?? []}
          allowSell={allowSell}
          builder={toSavedBuilder(
            mode,
            etfOnly,
            inputs.categories.map((c) => c.name),
            { weights: catW, split, selected },
          )}
          symbolOf={(id) => byId.get(id)?.symbol ?? String(id)}
        />
      )}
    </>
  );
}
