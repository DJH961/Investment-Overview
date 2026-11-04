import clsx from "clsx";
import { useId, useMemo } from "react";
import { lastSessionLabel } from "../Freshness";
import { Money } from "../Money";
import { formatTime, parseInstant } from "../../lib/format";
import type { ReportingCurrency } from "../../lib/prefs";
import { toNum, useGraph, type GraphDto } from "../../lib/queries/portfolio";
import { useTimeZone } from "../../lib/timezone";
import "./HeroIntraday.scss";

export interface HeroIntradayProps {
  currency: ReportingCurrency;
  /** Injected clock (tests). */
  now?: Date;
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
 * Desktop hero, right zone: today's (or the last session's) intraday curve
 * from the cached, live-patched 1D graph, with the previous close as a dashed
 * guide and the day's low / high. The box keeps its height while loading.
 */
export function HeroIntraday({ currency, now }: HeroIntradayProps) {
  const timeZone = useTimeZone();
  const graph = useGraph("1d", currency);
  const g = graph.data?.range === "1d" ? graph.data : undefined;
  const shape = useMemo(() => (g ? intradayShape(g) : null), [g]);
  const label = g?.session_date ? (lastSessionLabel(g.session_date, { timeZone, now }) ?? "Today") : "Today";
  const ref = toNum(g?.reference ?? null);
  const trend = g?.direction ?? null;
  const gradId = `hero-intraday-grad-${useId().replace(/:/g, "")}`;
  return (
    <div className={clsx("hero-intraday", trend && `hero-intraday--${trend}`)}>
      <div className="hero-intraday__head">
        <span className="hero-intraday__label">{label}</span>
        <span className="hero-intraday__state">{g?.market_open ? "Market open" : "Market closed"}</span>
      </div>
      <div className="hero-intraday__plot">
        <span className="u-sr-only">{label}: portfolio value through the session, chart</span>
        <svg className="hero-intraday__svg" viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none" aria-hidden>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" className="hero-intraday__grad-stop hero-intraday__grad-stop--top" />
              <stop offset="100%" className="hero-intraday__grad-stop" />
            </linearGradient>
          </defs>
          {shape?.refY != null && (
            <line className="hero-intraday__ref" x1={0} x2={VB_W} y1={shape.refY} y2={shape.refY} />
          )}
          {shape && <path className="hero-intraday__area" d={shape.area} fill={`url(#${gradId})`} />}
          {shape && <path className="hero-intraday__line" d={shape.line} />}
        </svg>
        {shape?.end && (
          <span
            className="hero-intraday__end"
            style={{ left: `${shape.end.left}%`, top: `${shape.end.top}%` }}
            aria-hidden
          />
        )}
      </div>
      <div className="hero-intraday__axis" aria-hidden>
        <span>{shape ? formatTime(new Date(shape.start), timeZone) : " "}</span>
        <span>{shape ? formatTime(new Date(shape.stop), timeZone) : " "}</span>
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
          <dt className="hero-intraday__fact-label">
            <span className="hero-intraday__swatch" aria-hidden />
            Prev close
          </dt>
          <dd className="hero-intraday__fact-value">
            <Money amount={ref} currency={currency} />
          </dd>
        </div>
      </dl>
    </div>
  );
}
