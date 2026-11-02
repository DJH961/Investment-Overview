import { useCallback, useEffect, useMemo } from "react";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Chart, type ChartSeries } from "../../components/Chart";
import { type Column, DataTable } from "../../components/DataTable";
import { ErrorState } from "../../components/ErrorState";
import { Field } from "../../components/Field";
import { Input } from "../../components/Input";
import { KpiTile } from "../../components/KpiTile";
import { Money } from "../../components/Money";
import { PageHeader } from "../../components/PageHeader";
import { Percent } from "../../components/Percent";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Skeleton } from "../../components/Skeleton";
import { formatMoney, formatNumber } from "../../lib/format";
import { usePrefs } from "../../lib/prefs";
import { type ProjectionOut, type ProjectionRequest, toNum, useCalculatorInputs, useProjectionMutation } from "../../lib/queries/reports";
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

/** Monthly projections still report `years`; show them as months. */
export function axisLabel(t: number, monthly: boolean): string {
  return monthly ? `Month ${Math.round(t * 12)}` : `Year ${parseFloat(t.toFixed(1))}`;
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
  return v.trim() === "" ? null : v.trim();
}

/** Form shows percent; the API takes fractions (7 -> "0.07"). */
function frac(v: string | null): string | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? String(parseFloat((n / 100).toFixed(8))) : v;
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
    horizon: horizon === null ? null : Number(horizon),
  };
}

export function Projection() {
  const { currency } = usePrefs();
  const [stored, setStored] = usePersistentState<Stored>("projection.form", { ccy: currency, form: INITIAL }, isStored);
  // Money typed in another currency would be misread, so it is dropped on a currency switch.
  const form: Form = stored.ccy === currency ? stored.form : { ...stored.form, contribution: "", target: "0" };
  const inputs = useCalculatorInputs(currency);
  const mutation = useProjectionMutation(currency);
  const { mutate } = mutation;
  const set = <K extends keyof Form>(k: K, v: Form[K]) =>
    setStored({ ccy: currency, form: { ...form, [k]: v } });

  const requestKey = JSON.stringify(toRequest(form));
  useEffect(() => {
    const id = setTimeout(() => mutate(JSON.parse(requestKey) as ProjectionRequest), 300);
    return () => clearTimeout(id);
  }, [requestKey, mutate, currency]);

  const out = mutation.data;
  const rerun = useCallback(() => mutate(JSON.parse(requestKey) as ProjectionRequest), [mutate, requestKey]);
  useShellStatus(
    mutation.isError ? "stale" : out ? "closed" : "loading",
    out ? `As of ${out.as_of}` : "Loading",
    rerun,
    mutation.isPending,
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
    return [
      { id: "expected", label: "Expected", tone: "primary", points: pick("expected") },
      { id: "optimistic", label: "Optimistic", tone: "benchmark", points: pick("optimistic") },
      { id: "pessimistic", label: "Pessimistic", tone: "muted", points: pick("pessimistic") },
    ];
  }, [out]);

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
      { key: "exp", header: "Expected", align: "right", cell: (p) => m(real ? p.expected_real : p.expected) },
      { key: "opt", header: "Optimistic", align: "right", cell: (p) => m(real ? p.optimistic_real : p.optimistic) },
    ];
  }, [out?.real, out?.monthly, currency]);

  const endLabel = out?.points.at(-1)?.label;
  const basis = out?.real ? "today's money" : "nominal";
  const endHint = endLabel ? `in ${endLabel} · ${basis}` : basis;

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
            <Field label="Expected return (% p.a.)" hint="Blank uses your measured XIRR.">
              {(c) => (
                <Input
                  {...c}
                  inputMode="decimal"
                  value={form.expected !== "" ? form.expected : fmtInput(seed?.expected_rate, 100)}
                  onChange={(e) => set("expected", e.target.value)}
                />
              )}
            </Field>
            <Field label="Band (+/- pp)">
              {(c) => <Input {...c} inputMode="decimal" value={form.band} onChange={(e) => set("band", e.target.value)} />}
            </Field>
            <Field label={`Contribution per ${unit} (${currency})`}>
              {(c) => (
                <Input
                  {...c}
                  inputMode="decimal"
                  value={form.contribution !== "" ? form.contribution : fmtInput(seed?.avg_contribution)}
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
            <Field label={`Target value (${currency})`}>
              {(c) => <Input {...c} inputMode="decimal" value={form.target} onChange={(e) => set("target", e.target.value)} />}
            </Field>
            <Field label={`Horizon (${unitPlural})`}>
              {(c) => (
                <Input {...c} type="number" min={1} value={form.horizon !== "" ? form.horizon : String(out?.inputs.horizon ?? "")} onChange={(e) => set("horizon", e.target.value)} />
              )}
            </Field>
            <Button variant="secondary" onClick={rerun} loading={mutation.isPending}>
              Recalculate
            </Button>
          </form>
        </Card>
        <div className="projection-page__results">
          {mutation.isError ? (
            <ErrorState
              title="Could not compute projection"
              message={mutation.error.message}
              onRetry={rerun}
            />
          ) : !out ? (
            <Skeleton height="18rem" />
          ) : (
            <>
              <div className="projection-page__kpis">
                <KpiTile label="Expected" value={money(out.final.expected)} hint={endHint} />
                <KpiTile label="Optimistic" value={money(out.final.optimistic)} hint={endHint} />
                <KpiTile label="Pessimistic" value={money(out.final.pessimistic)} hint={endHint} />
                <KpiTile label="Additionally contributed" value={money(out.total_contributed)} hint={endHint} />
                <KpiTile label="Projected growth" value={money(out.final.projected_growth)} hint={basis} />
              </div>
              <Card title={`Next ${out.inputs.horizon} ${out.monthly ? "months" : "years"}`}>
                <Chart
                  series={series}
                  valueFormat={(v) => formatMoney(v, currency, { compact: true })}
                  timeFormat={(t) => axisLabel(t, out.monthly)}
                  ariaLabel="Projected value scenarios"
                />
              </Card>
              <Card title="Goal">
                {toNum(out.inputs.target) ? (
                  <>
                    <p className="projection-page__note">
                      Reaching <Money amount={toNum(out.inputs.target)} currency={currency} />
                    </p>
                    <ul className="projection-page__goal">
                      {Object.entries(out.hits).map(([name, hit]) => (
                        <li key={name}>
                          {name}:{" "}
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
                  </>
                ) : (
                  <p className="projection-page__note">Set a target value to see when you could reach it.</p>
                )}
              </Card>
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
              <ul className="projection-page__mix">
                {inputs.data.categories.map((c) => (
                  <li key={c.name}>
                    {c.name}: <Percent ratio={toNum(c.current_pct)} />
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
