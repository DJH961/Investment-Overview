import { useMemo, useState } from "react";
import { Button } from "../../components/Button";
import { AllocationBar } from "../../components/AllocationBar";
import { Card } from "../../components/Card";
import { Chart, type ChartSeries } from "../../components/Chart";
import { type Column, DataTable } from "../../components/DataTable";
import { ErrorState } from "../../components/ErrorState";
import { Field } from "../../components/Field";
import { Input } from "../../components/Input";
import { Money } from "../../components/Money";
import { PageHeader } from "../../components/PageHeader";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Skeleton } from "../../components/Skeleton";
import { relativeSeries, useHideAmounts } from "../../lib/hideAmounts";
import { MASK, chartMoneyFormat, formatDate, formatNumber, formatPercent } from "../../lib/format";
import { parseDecimal, toApiDecimal } from "../../lib/parseDecimal";
import { usePrefs } from "../../lib/prefs";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { type ProjectionOut, type ProjectionRequest, toNum, useCalculatorInputs, useProjection } from "../../lib/queries/reports";
import { useShellStatus } from "../../lib/shell";
import { usePersistentState, type Validator } from "../../lib/usePersistentState";
import { Maybe } from "../Periods/Maybe";
import "./Projection.scss";

interface Form {
  monthly: boolean;
  real: boolean;
  expected: string;
  band: string;
  contribution: string;
  stepUp: string;
  inflation: string;
  target: string;
  horizon: string;
}

const INITIAL: Form = {
  monthly: false,
  real: false,
  expected: "",
  band: "3",
  contribution: "",
  stepUp: "0",
  inflation: "2",
  target: "0",
  horizon: "",
};

const FORM_KEYS = Object.keys(INITIAL) as (keyof Form)[];

interface Stored {
  /** Money fields (contribution, target) are typed in this currency. */
  ccy: string;
  form: Form;
}

const isStored: Validator<Stored> = (v): v is Stored => {
  if (typeof v !== "object" || v === null) return false;
  const { ccy, form } = v as { ccy?: unknown; form?: unknown };
  if (typeof ccy !== "string" || typeof form !== "object" || form === null) return false;
  return FORM_KEYS.every((k) => typeof (form as Record<string, unknown>)[k] === typeof INITIAL[k]);
};

/** Percent / money from the server, shaped for an input box. */
function fmtInput(v: string | null | undefined, scale = 1): string {
  const n = toNum(v);
  return n === null ? "" : String(parseFloat((n * scale).toFixed(2)));
}

/** The goal list reads like the chart legend, in a fixed order. */
const GOAL_ORDER = ["pessimistic", "expected", "optimistic"] as const;
const GOAL_LABEL: Record<(typeof GOAL_ORDER)[number], string> = {
  pessimistic: "Pessimistic",
  expected: "Expected",
  optimistic: "Optimistic",
};

/** Monthly projections still report `years`; show them as months. */
export function axisLabel(t: number, monthly: boolean): string {
  return monthly ? `Month ${Math.round(t * 12)}` : `Year ${Math.round(t)}`;
}

/** Detail table: monthly mode lists whole years only (every 12th point). */
export function detailRows(out: ProjectionOut): ProjectionOut["points"] {
  if (!out.monthly) return out.points;
  return out.points.filter((p) => {
    const y = toNum(p.years);
    return y !== null && Math.abs(y - Math.round(y)) < 1e-6;
  });
}

/** Blank means "let the server seed it"; anything else is sent as typed. */
function opt(v: string): string | null {
  // A decimal comma is accepted; text that is not a number goes through for the server to refuse.
  return v.trim() === "" ? null : (toApiDecimal(v) ?? v.trim());
}

/** Form shows percent; the API takes fractions (7 -> "0.07"). */
function frac(v: string | null): string | null {
  if (v === null) return null;
  const n = parseDecimal(v);
  return n !== null ? String(parseFloat((n / 100).toFixed(8))) : v;
}

export function toRequest(f: Form): ProjectionRequest {
  const horizon = opt(f.horizon);
  return {
    monthly: f.monthly,
    real: f.real,
    expected_return_pct: frac(opt(f.expected)),
    band_pp: opt(f.band) ?? "3",
    contribution: opt(f.contribution),
    step_up_pct: frac(opt(f.stepUp)) ?? "0",
    inflation_pct: frac(opt(f.inflation)) ?? "0.02",
    target: opt(f.target) ?? "0",
    horizon: horizon === null ? null : parseDecimal(horizon),
  };
}

export function Projection() {
  const { currency } = usePrefs();
  const [stored, setStored] = usePersistentState<Stored>("projection.form", { ccy: currency, form: INITIAL }, isStored);
  // Money typed in another currency would be misread, so it is dropped on a currency switch.
  const form: Form = stored.ccy === currency ? stored.form : { ...stored.form, contribution: "", target: "0" };
  // Hide mode: money inputs show a mask until focused.
  const { hide } = useHideAmounts();
  const [focused, setFocused] = useState<string | null>(null);
  const maskMoney = (key: string, v: string) => (hide && focused !== key && v !== "" ? MASK : v);
  const masked = (key: string) => ({ onFocus: () => setFocused(key), onBlur: () => setFocused(null) });
  /**
   * An auto-filled field: empty means "use the suggestion". While the field has
   * focus it shows exactly what is typed (the suggestion only as a grey
   * placeholder), so clearing it to type a new number never refills it; once
   * focus leaves an empty field, the suggestion shows again.
   */
  const auto = (key: string, typed: string, suggested: string) => {
    const editing = focused === key;
    return {
      ...masked(key),
      value: typed !== "" || editing ? typed : suggested,
      placeholder: editing ? suggested : undefined,
    };
  };
  const inputs = useCalculatorInputs(currency);
  const set = <K extends keyof Form>(k: K, v: Form[K]) =>
    setStored({ ccy: currency, form: { ...form, [k]: v } });

  // Compare by the JSON string so the debounce only restarts on a real change.
  const requestKey = JSON.stringify(toRequest(form));
  const debouncedKey = useDebouncedValue(requestKey, 300);
  const body = useMemo(() => JSON.parse(debouncedKey) as ProjectionRequest, [debouncedKey]);
  const query = useProjection(currency, body);
  const { refetch, isError, isFetching } = query;

  // Keep the previous result on screen (keepPreviousData); error only replaces it when there is none.
  const out = query.data;
  useShellStatus(
    isError ? "stale" : out ? "closed" : "loading",
    out ? `As of ${formatDate(out.as_of)}` : "Loading",
    () => void refetch(),
    isFetching,
  );

  const seed = inputs.data?.projection_defaults[form.monthly ? "month" : "year"];
  const unit = form.monthly ? "month" : "year";
  const unitPlural = form.monthly ? "months" : "years";
  const series = useMemo<ChartSeries[]>(() => {
    if (!out) return [];
    const pick = (name: "pessimistic" | "expected" | "optimistic") =>
      out.points.map((p, i) => ({
        t: toNum(p.years) ?? i,
        v: toNum(out.real ? p[`${name}_real`] : p[name]),
      }));
    const all: ChartSeries[] = [
      { id: "expected", label: "Expected", tone: "primary", points: pick("expected") },
      { id: "optimistic", label: "Optimistic", tone: "benchmark", points: pick("optimistic") },
      { id: "pessimistic", label: "Pessimistic", tone: "muted", points: pick("pessimistic") },
    ];
    // Hide numbers: plot as % of today's value (100% = now).
    return hide ? relativeSeries(all, "expected", "first") : all;
  }, [out, hide]);

  const detailColumns = useMemo<Column<ProjectionOut["points"][number]>[]>(() => {
    const real = out?.real ?? false;
    const m = (v: string | null) => (
      <Maybe present={toNum(v) !== null} ccy={currency}>
        <Money amount={toNum(v)} currency={currency} />
      </Maybe>
    );
    return [
      { key: "label", header: out?.monthly ? "Month" : "Year", primary: true, cell: (p) => p.label },
      { key: "contrib", header: "Contributed", align: "right", cell: (p) => m(p.contributed) },
      { key: "pess", header: "Pessimistic", align: "right", cell: (p) => m(real ? p.pessimistic_real : p.pessimistic) },
      { key: "exp", header: "Expected", align: "right", phone: "headline", cell: (p) => m(real ? p.expected_real : p.expected) },
      { key: "opt", header: "Optimistic", align: "right", cell: (p) => m(real ? p.optimistic_real : p.optimistic) },
    ];
  }, [out?.real, out?.monthly, currency]);

  const endLabel = out?.points.at(-1)?.label;
  const basis = out?.real ? "today's money" : "nominal";

  const money = (v: string | null | undefined) => (
    <Maybe present={toNum(v) !== null} ccy={currency}>
      <Money amount={toNum(v)} currency={currency} />
    </Maybe>
  );

  return (
    <div className="projection-page">
      <PageHeader title="Projection" subtitle="Project your portfolio forward." />
      <div className="projection-page__layout">
        <Card title="Assumptions" collapsibleId="projection.assumptions">
          <form className="projection-page__form" onSubmit={(e) => e.preventDefault()}>
            <div className="projection-page__toggles">
              <SegmentedControl
                ariaLabel="Period"
              options={[
                { value: "year", label: "Yearly" },
                { value: "month", label: "Monthly" },
              ]}
              value={form.monthly ? "month" : "year"}
              onChange={(v) => set("monthly", v === "month")}
            />
            <SegmentedControl
              ariaLabel="Value basis"
              options={[
                { value: "nominal", label: "Nominal" },
                { value: "real", label: "Today's money" },
              ]}
              value={form.real ? "real" : "nominal"}
              onChange={(v) => set("real", v === "real")}
            />
            </div>
            <Field label="Expected return (% p.a.)" hint="Blank: your XIRR">
              {(c) => (
                <Input
                  {...c}
                  inputMode="decimal"
                  {...auto("expected", form.expected, fmtInput(seed?.expected_rate, 100))}
                  onChange={(e) => set("expected", e.target.value)}
                />
              )}
            </Field>
            <Field label="Band (+/- pp)">
              {(c) => <Input {...c} inputMode="decimal" value={form.band} onChange={(e) => set("band", e.target.value)} />}
            </Field>
            <Field
              label={`Contribution per ${unit} (${currency})`}
              hint="Blank: your average since the start"
              className="projection-page__wide"
            >
              {(c) => (
                <Input
                  {...c}
                  inputMode="decimal"
                  {...auto("contribution", form.contribution, fmtInput(seed?.avg_contribution))}
                  value={maskMoney(
                    "contribution",
                    auto("contribution", form.contribution, fmtInput(seed?.avg_contribution)).value,
                  )}
                  onChange={(e) => set("contribution", e.target.value)}
                />
              )}
            </Field>
            <Field label="Annual step-up (%)">
              {(c) => <Input {...c} inputMode="decimal" value={form.stepUp} onChange={(e) => set("stepUp", e.target.value)} />}
            </Field>
            <Field label="Inflation (%)">
              {(c) => (
                <Input {...c} inputMode="decimal" value={form.inflation} onChange={(e) => set("inflation", e.target.value)} />
              )}
            </Field>
            <Field label={`Target value (${currency})`} hint="Shows when you reach it">
              {(c) => (
                <Input
                  {...c}
                  inputMode="decimal"
                  {...masked("target")}
                  value={maskMoney("target", form.target)}
                  onChange={(e) => set("target", e.target.value)}
                />
              )}
            </Field>
            <Field label={`Horizon (${unitPlural})`}>
              {(c) => (
                <Input
                  {...c}
                  type="number"
                  min={1}
                  {...auto("horizon", form.horizon, String(out?.inputs.horizon ?? ""))}
                  onChange={(e) => set("horizon", e.target.value)}
                />
              )}
            </Field>
            <Button className="projection-page__wide" variant="secondary" onClick={() => void refetch()} loading={isFetching}>
              Recalculate
            </Button>
          </form>
        </Card>
        <div className="projection-page__results">
          {isError && !out ? (
            <ErrorState
              title="Could not compute projection"
              message={query.error?.message ?? ""}
              onRetry={() => void refetch()}
            />
          ) : !out ? (
            <Skeleton height="18rem" />
          ) : (
            <>
              {/* One summary instead of five similar tiles: the expected end value,
                  the range around it, then what you add and what it grows by. */}
              <Card className="projection-page__summary">
                <p className="projection-page__eyebrow">Expected {endLabel ? `in ${endLabel}` : ""}</p>
                <p className="projection-page__headline">{money(out.final.expected)}</p>
                <p className="projection-page__range">
                  {money(out.final.pessimistic)} <span className="projection-page__range-sep">to</span>{" "}
                  {money(out.final.optimistic)}
                  <span className="projection-page__range-note">pessimistic to optimistic · {basis}</span>
                </p>
                <dl className="projection-page__facts">
                  <div className="projection-page__fact">
                    <dt className="projection-page__fact-label">You add</dt>
                    <dd className="projection-page__fact-value">{money(out.total_contributed)}</dd>
                  </div>
                  <div className="projection-page__fact">
                    <dt className="projection-page__fact-label">Growth</dt>
                    <dd className="projection-page__fact-value">
                      <Maybe present={toNum(out.final.projected_growth) !== null} ccy={currency}>
                        <Money amount={toNum(out.final.projected_growth)} currency={currency} signed colored />
                      </Maybe>
                    </dd>
                  </div>
                </dl>
              </Card>
              <Card title={`Next ${out.inputs.horizon} ${out.monthly ? "months" : "years"}`}>
                <Chart
                  busy={isFetching}
                  series={hide ? series : series.map((s) => ({ ...s, valueFormat: chartMoneyFormat(currency, "tooltip") }))}
                  valueFormat={(v) => (hide ? formatPercent(v, { digits: 0 }) : chartMoneyFormat(currency, "axis")(v))}
                  timeFormat={(t) => axisLabel(t, out.monthly)}
                  ariaLabel="Projected value scenarios"
                />
              </Card>
              {toNum(out.inputs.target) ? (
                <Card title="Goal">
                    <p className="projection-page__note">
                      Reaching <Money amount={toNum(out.inputs.target)} currency={currency} />
                    </p>
                    <ul className="projection-page__goal">
                      {GOAL_ORDER.filter((name) => name in out.hits).map((name) => [name, out.hits[name]] as const).map(([name, hit]) => (
                        <li key={name}>
                          {GOAL_LABEL[name]}:{" "}
                          {hit
                            ? `${hit.label}${toNum(hit.years) !== null ? ` (${formatNumber(toNum(hit.years), 1)} yr)` : ""}`
                            : "not within horizon"}
                        </li>
                      ))}
                      <li>
                        {out.required_contribution === null ? (
                          "Even large contributions cannot reach this target within the horizon."
                        ) : (
                          <>
                            Needed contribution: {money(out.required_contribution)} / {unit}
                          </>
                        )}
                      </li>
                    </ul>
                </Card>
              ) : null}
              <Card
                title={out.monthly ? "Year-by-year detail (every 12th month)" : "Year-by-year detail"}
                collapsibleId="projection.detail"
                defaultOpen={false}
                flush
              >
                <DataTable
                  caption="Projection detail"
                  columns={detailColumns}
                  rows={detailRows(out)}
                  rowKey={(p) => p.label}
                />
              </Card>
            </>
          )}
          {inputs.data && inputs.data.categories.length > 0 && (
            <Card title="Holdings mix" collapsibleId="projection.mix">
              <AllocationBar
                ariaLabel="Current holdings mix"
                slices={inputs.data.categories.map((c) => ({ id: c.name, label: c.name, actual: toNum(c.current_pct) ?? 0 }))}
              />
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
