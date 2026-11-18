import { useMemo, type ReactNode } from "react";
import { lastSessionLabel } from "../Freshness";
import { Money } from "../Money";
import { parseInstant } from "../../lib/format";
import type { ReportingCurrency } from "../../lib/prefs";
import { toNum, useGraph, type GraphDto } from "../../lib/queries/portfolio";
import { useTimeZone } from "../../lib/timezone";
import "./HeroIntraday.scss";

export interface HeroIntradayProps {
  currency: ReportingCurrency;
  /** Injected clock (tests). */
  now?: Date;
  /**
   * The market clock (from the hero), in the slot the intraday curve used to fill:
   * under the head, over the facts. It carries the market state, so the head's
   * "Market open" pill steps aside while it is shown.
   */
  clock?: ReactNode;
}

/** viewBox units; the SVG stretches to its box (strokes stay 1.75 px). */
const VB_W = 600;
const VB_H = 100;
const PAD_Y = 6;

export interface IntradayShape {
  line: string;
  area: string;
  /** Previous close in viewBox y, when known. */
  refY: number | null;
  /** Last point as % of the box (for the HTML end dot, which must stay round). */
  end: { left: number; top: number } | null;
  low: number;
  high: number;
  start: number;
  stop: number;
}

/**
 * The 1D curve in viewBox units. x runs over the session (open → close) so a
 * live day fills in from the left; y spans the day's values and the previous
 * close, so the dashed reference is always on the chart.
 */
export function intradayShape(g: Pick<GraphDto, "points" | "reference" | "sessions" | "session_date">): IntradayShape | null {
  const pts = g.points.flatMap((p) => {
    const v = toNum(p.v ?? null);
    const t = parseInstant(p.t).getTime();
    return v === null || Number.isNaN(t) ? [] : [{ t, v }];
  });
  if (pts.length < 2) return null;
  const session = g.sessions?.find((s) => s.date === g.session_date) ?? g.sessions?.[g.sessions.length - 1];
  const t0 = Math.min(pts[0].t, session ? parseInstant(session.open).getTime() : Infinity);
  const t1 = Math.max(pts[pts.length - 1].t, session ? parseInstant(session.close).getTime() : -Infinity);
  const values = pts.map((p) => p.v);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const ref = toNum(g.reference ?? null);
  const lo = ref === null ? low : Math.min(low, ref);
  const hi = ref === null ? high : Math.max(high, ref);
  const span = hi - lo || 1;
  const tSpan = t1 - t0 || 1;
  const x = (t: number) => ((t - t0) / tSpan) * VB_W;
  const y = (v: number) => PAD_Y + (1 - (v - lo) / span) * (VB_H - PAD_Y * 2);
  const xy = pts.map((p) => [x(p.t), y(p.v)] as const);
  const line = xy.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  const first = xy[0];
  const last = xy[xy.length - 1];
  const area = `${line} L${last[0].toFixed(1)},${VB_H} L${first[0].toFixed(1)},${VB_H} Z`;
  return {
    line,
    area,
    refY: ref === null ? null : y(ref),
    end: { left: (last[0] / VB_W) * 100, top: (last[1] / VB_H) * 100 },
    low,
    high,
    start: t0,
    stop: t1,
  };
}

/**
 * The hero's "Today" stat block: the day's low and high and the previous close
 * (from the cached, live-patched 1D graph) with the market state. No curve: the
 * big graph below already draws 1D. While the graph loads the block keeps its
 * frame (dashes); once loaded with nothing to show it renders nothing.
 */
export function HeroIntraday({ currency, now, clock }: HeroIntradayProps) {
  const timeZone = useTimeZone();
  const graph = useGraph("1d", currency);
  const g = graph.data?.range === "1d" ? graph.data : undefined;
  const shape = useMemo(() => (g ? intradayShape(g) : null), [g]);
  const label = g?.session_date ? (lastSessionLabel(g.session_date, { timeZone, now }) ?? "Today") : "Today";
  const ref = toNum(g?.reference ?? null);
  const loading = graph.isPending || !g;
  if (!loading && !shape && ref === null) return clock ? <div className="hero-intraday">{clock}</div> : null;
  return (
    <div className="hero-intraday">
      {/* The countdown leads; the label then names the figures under it (Today / Last session). */}
      {clock}
      <div className="hero-intraday__head">
        <span className="hero-intraday__label">{label}</span>
        {!clock && <span className="hero-intraday__state">{g?.market_open ? "Market open" : "Market closed"}</span>}
      </div>
      <dl className="hero-intraday__facts">
        <div className="hero-intraday__fact">
          <dt className="hero-intraday__fact-label">Low</dt>
          <dd className="hero-intraday__fact-value">
            <Money amount={shape?.low ?? null} currency={currency} />
          </dd>
        </div>
        <div className="hero-intraday__fact">
          <dt className="hero-intraday__fact-label">High</dt>
          <dd className="hero-intraday__fact-value">
            <Money amount={shape?.high ?? null} currency={currency} />
          </dd>
        </div>
        <div className="hero-intraday__fact">
          <dt className="hero-intraday__fact-label">Prev close</dt>
          <dd className="hero-intraday__fact-value">
            <Money amount={ref} currency={currency} />
          </dd>
        </div>
      </dl>
    </div>
  );
}
