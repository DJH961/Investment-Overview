import { useMemo, useState, type FormEvent } from "react";
import { Button } from "../../components/Button";
import { Chart, type ChartMarker, type ChartSeries } from "../../components/Chart";
import { formatStamp } from "../../components/Freshness";
import { Input } from "../../components/Input";
import { Percent } from "../../components/Percent";
import { formatDate, formatMoney, formatPercent, formatPp } from "../../lib/format";
import { type HoldingTwinDto, TWIN_RANGES, type TwinRange, useHoldingTwin } from "../../lib/queries/holding-detail";
import type { HoldingRowDto } from "../../lib/queries/holdings";
import { instrumentErrors, useUpdateInstrument } from "../../lib/queries/instruments";
import { toNum } from "../../lib/queries/portfolio";
import { axisFormat, chartSessions, chartXMode, rangeLabel, tooltipFormat } from "./holdingFormat";

const REASON: Record<HoldingTwinDto["twin_reason"], string> = {
  same_index: "tracks the same index",
  close_index: "tracks a close index",
  manual: "chosen by you",
};

const BIAS: Record<HoldingTwinDto["stats"]["bias_label"], string> = {
  runs_high: "the twin runs high",
  runs_low: "the twin runs low",
  none: "no lean either way",
};

/** Gaps arrive in percentage points ("0.03" = 0.03 pp). */
const pp = (v: string | null | undefined): string => {
  const n = toNum(v ?? null);
  return n === null ? "–" : formatPp(n / 100);
};

interface Built {
  series: ChartSeries[];
  markers: ChartMarker[];
  /** Right-axis labels in the fund's currency (1d / 1w: the fund sits on the twin's scale). */
  right?: (v: number) => string;
  value: (v: number) => string;
  extra?: (t: number) => string | null;
}

function build(d: HoldingTwinDto, fundSymbol: string, ccy: string): Built {
  const money = (v: number) => formatMoney(v, ccy, { unmasked: true });
  if (d.rebased) {
    const gaps = new Map(d.rebased.map((r) => [Date.parse(r.t), r.gap_pp]));
    return {
      series: [
        { id: "fund", label: `${fundSymbol} NAV`, tone: "primary", points: d.rebased.map((r) => ({ t: r.t, v: toNum(r.fund_pct) })) },
        { id: "twin", label: d.twin_symbol, tone: "benchmark", points: d.rebased.map((r) => ({ t: r.t, v: toNum(r.twin_pct) })) },
      ],
      markers: [],
      value: (v) => formatPercent(v, { signed: true, digits: 1 }),
      extra: (t) => {
        const g = gaps.get(t);
        return g == null ? null : `Gap ${pp(g)}`;
      },
    };
  }
  const twin = d.twin_points.map((p) => ({ t: p.t, v: toNum(p.price_native) }));
  const firstTwin = twin.find((p) => p.v !== null)?.v ?? null;
  // The fund rides on the twin's scale from the first point, so both start together; the
  // right axis and the tooltip show the fund's own prices (Chart `scale`: display only).
  const firstFund = toNum(d.estimate_points[0]?.price_native ?? d.nav_points[0]?.nav_native ?? null);
  const scale = firstTwin && firstFund ? firstFund / firstTwin : 1;
  const series: ChartSeries[] = [{ id: "twin", label: d.twin_symbol, tone: "primary", points: twin }];
  if (d.estimate_points.length) {
    series.push({
      id: "estimate",
      label: `≈ ${fundSymbol} from ${d.twin_symbol}`,
      tone: "estimate",
      scale,
      axis: "right",
      valueFormat: money,
      points: d.estimate_points.map((p) => ({ t: p.t, v: toNum(p.price_native) })),
    });
  }
  const markers: ChartMarker[] = d.nav_points.flatMap((p) => {
    const nav = toNum(p.nav_native);
    return nav === null ? [] : [{ t: p.t, v: nav / scale, shape: "dot" as const, label: `${fundSymbol} NAV ${money(nav)} (${formatDate(p.t)})` }];
  });
  return {
    series,
    markers,
    value: (v) => formatMoney(v, ccy, { unmasked: true }),
    right: d.estimate_points.length ? (v) => money(v) : undefined,
  };
}

function ChangeTwin({ row }: { row: HoldingRowDto }) {
  const [value, setValue] = useState(row.twin?.symbol ?? "");
  const update = useUpdateInstrument();
  const errors = instrumentErrors(update.error);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next = value.trim().toUpperCase();
    update.mutate({ id: row.instrument_id, patch: { intraday_twin: next === "" ? null : next } });
  };
  return (
    <form className="holding-page__twin-form" onSubmit={submit} aria-label="Change twin">
      <span className="holding-page__twin-input">
        <Input
          aria-label="Twin ETF symbol"
          placeholder="ETF symbol, empty for none"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </span>
      <Button type="submit" variant="secondary" loading={update.isPending}>
        Change twin
      </Button>
      {update.isSuccess && <output className="holding-page__note">Saved. The estimate uses it from the next tick.</output>}
      {(errors.intraday_twin ?? errors._form) && (
        <output className="holding-page__note holding-page__note--warn">{errors.intraday_twin ?? errors._form}</output>
      )}
    </form>
  );
}

/** The Twin tab: how the stand-in ETF tracks this NAV fund, and changing it. */
export function TwinTab({ row }: { row: HoldingRowDto }) {
  const [range, setRange] = useState<TwinRange>("1d");
  const q = useHoldingTwin(row.instrument_id, range);
  const d = q.data;
  const ccy = row.native_currency;
  const built = useMemo(() => (d ? build(d, row.symbol, ccy) : null), [d, row.symbol, ccy]);
  const sessions = chartSessions(d?.sessions);
  const twinNow = d?.twin_now;
  return (
    <div className="holding-page__panel">
      <section className="holding-page__section holding-page__chart" aria-label="Twin chart">
        <Chart
          series={built?.series ?? []}
          markers={built?.markers}
          range={range}
          ranges={TWIN_RANGES}
          rangeLabel={rangeLabel}
          onRangeChange={(r) => setRange(r as TwinRange)}
          xMode={chartXMode(d?.x_mode, sessions)}
          sessions={sessions}
          loading={q.isPending}
          busy={q.isFetching && !q.isPending}
          valueFormat={built?.value ?? ((v) => String(v))}
          rightAxisFormat={built?.right}
          tooltipExtra={built?.extra}
          timeFormat={axisFormat(range, d?.x_mode)}
          tooltipTimeFormat={tooltipFormat(range, d?.x_mode)}
          legendExtra={range === "1d" || range === "1w" ? <span className="holding-page__muted">● NAV at the close</span> : undefined}
          height={240}
          ariaLabel={`${row.symbol} against its twin ETF`}
          emptyMessage={q.isError ? "Could not load the twin history." : "No twin prices for this range yet."}
        />
      </section>
      {d && (
        <section className="holding-page__section" aria-labelledby="twin-facts">
          <h2 id="twin-facts" className="holding-page__section-title">
            Twin facts
          </h2>
          <dl className="holding-page__facts">
            <div className="holding-page__fact">
              <dt className="holding-page__fact-key">Stands in</dt>
              <dd className="holding-page__fact-value">
                {d.twin_symbol} <span className="holding-page__muted">· {REASON[d.twin_reason]}</span>
              </dd>
            </div>
            <div className="holding-page__fact">
              <dt className="holding-page__fact-key">Live</dt>
              <dd className="holding-page__fact-value">
                {formatMoney(toNum(twinNow?.price_native ?? null), ccy, { unmasked: true })}{" "}
                <Percent ratio={toNum(twinNow?.day_pct ?? null)} signed colored />
                {twinNow?.captured_at && <span className="holding-page__muted"> · {formatStamp(twinNow.captured_at)}</span>}
              </dd>
            </div>
            <div className="holding-page__fact">
              <dt className="holding-page__fact-key">Typical gap</dt>
              <dd className="holding-page__fact-value">{pp(d.stats.median_gap_pp).replace(/^\+/, "")}</dd>
            </div>
            <div className="holding-page__fact">
              <dt className="holding-page__fact-key">Bias</dt>
              <dd className="holding-page__fact-value">
                {pp(d.stats.bias_pp)} <span className="holding-page__muted">· {BIAS[d.stats.bias_label]}</span>
              </dd>
            </div>
            <div className="holding-page__fact">
              <dt className="holding-page__fact-key">Sessions</dt>
              <dd className="holding-page__fact-value">{d.stats.sessions} counted</dd>
            </div>
          </dl>
          {d.recent.length > 0 && (
            <table className="holding-page__mini-table">
              <caption className="holding-page__mini-caption">Recent sessions: estimate against the NAV</caption>
              <thead>
                <tr>
                  <th scope="col" className="holding-page__mini-th">
                    Session
                  </th>
                  <th scope="col" className="holding-page__mini-th holding-page__mini-th--right">
                    ≈ Estimate
                  </th>
                  <th scope="col" className="holding-page__mini-th holding-page__mini-th--right">
                    NAV
                  </th>
                  <th scope="col" className="holding-page__mini-th holding-page__mini-th--right">
                    Gap
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.recent.map((r) => (
                  <tr key={r.session_date}>
                    <td className="holding-page__mini-td">{formatDate(r.session_date)}</td>
                    <td className="holding-page__mini-td holding-page__mini-td--right">
                      <Percent ratio={toNum(r.estimate_pct)} signed />
                    </td>
                    <td className="holding-page__mini-td holding-page__mini-td--right">
                      <Percent ratio={toNum(r.nav_pct)} signed />
                    </td>
                    <td className="holding-page__mini-td holding-page__mini-td--right">{pp(r.gap_pp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
      <section className="holding-page__section" aria-labelledby="twin-change">
        <h2 id="twin-change" className="holding-page__section-title">
          Change twin
        </h2>
        <ChangeTwin row={row} />
      </section>
    </div>
  );
}
