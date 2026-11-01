import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Chart, type ChartSeries } from "../../components/Chart";
import { ErrorState } from "../../components/ErrorState";
import { Field } from "../../components/Field";
import { Input } from "../../components/Input";
import { KpiTile } from "../../components/KpiTile";
import { Money } from "../../components/Money";
import { PageHeader } from "../../components/PageHeader";
import { Percent } from "../../components/Percent";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Skeleton } from "../../components/Skeleton";
import { formatMoney, formatPercent } from "../../lib/format";
import { usePrefs } from "../../lib/prefs";
import { type ProjectionRequest, toNum, useCalculatorInputs, useProjectionMutation } from "../../lib/queries/reports";
import { useShellStatus } from "../../lib/shell";
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
  const [form, setForm] = useState<Form>(INITIAL);
  const inputs = useCalculatorInputs(currency);
  const mutation = useProjectionMutation(currency);
  const { mutate } = mutation;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((p) => ({ ...p, [k]: v }));

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

  const money = (v: string | null | undefined) => (
    <Maybe present={toNum(v) !== null} ccy={currency}>
      <Money amount={toNum(v)} currency={currency} />
    </Maybe>
  );

  return (
    <div className="projection-page">
      <PageHeader title="Projection" subtitle="Project your portfolio forward." />
      <div className="projection-page__layout">
        <Card title="Assumptions">
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
                  value={form.expected}
                  placeholder={seed?.expected_rate ? formatPercent(toNum(seed.expected_rate)) : ""}
                  onChange={(e) => set("expected", e.target.value)}
                />
              )}
            </Field>
            <Field label="Band (+/- pp)">
              {(c) => <Input {...c} inputMode="decimal" value={form.band} onChange={(e) => set("band", e.target.value)} />}
            </Field>
            <Field label={`Contribution per ${form.monthly ? "month" : "year"}`}>
              {(c) => (
                <Input
                  {...c}
                  inputMode="decimal"
                  value={form.contribution}
                  placeholder={seed?.avg_contribution ? formatMoney(toNum(seed.avg_contribution), currency) : ""}
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
            <Field label="Target value">
              {(c) => <Input {...c} inputMode="decimal" value={form.target} onChange={(e) => set("target", e.target.value)} />}
            </Field>
            <Field label="Horizon (years)">
              {(c) => (
                <Input {...c} type="number" min={1} value={form.horizon} onChange={(e) => set("horizon", e.target.value)} />
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
                <KpiTile label="Expected" value={money(out.final.expected)} />
                <KpiTile label="Optimistic" value={money(out.final.optimistic)} />
                <KpiTile label="Pessimistic" value={money(out.final.pessimistic)} />
                <KpiTile label="Contributed" value={money(out.total_contributed)} />
                <KpiTile label="Projected growth" value={money(out.final.projected_growth)} />
              </div>
              <Card title={`Next ${out.inputs.horizon} years`}>
                <Chart
                  series={series}
                  valueFormat={(v) => formatMoney(v, currency, { compact: true })}
                  timeFormat={(t) => `Year ${t}`}
                  ariaLabel="Projected value scenarios"
                />
              </Card>
              <Card title="Goal">
                {toNum(out.inputs.target) ? (
                  <ul className="projection-page__goal">
                    {Object.entries(out.hits).map(([name, hit]) => (
                      <li key={name}>
                        {name}: {hit ? hit.label : "not within horizon"}
                      </li>
                    ))}
                    <li>
                      {out.required_contribution === null ? (
                        "Even large contributions cannot reach this target within the horizon."
                      ) : (
                        <>Required contribution to reach it by the end of the horizon: {money(out.required_contribution)}</>
                      )}
                    </li>
                  </ul>
                ) : (
                  <p className="projection-page__note">Set a target value to see when you could reach it.</p>
                )}
              </Card>
            </>
          )}
          {inputs.data && inputs.data.categories.length > 0 && (
            <Card title="Holdings mix">
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
