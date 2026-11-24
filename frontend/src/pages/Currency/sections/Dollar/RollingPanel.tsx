import clsx from "clsx";
import { Card } from "../../../../components/Card";
import { InfoTip } from "../../../../components/InfoTip";
import { formatDate } from "../../../../lib/format";
import type { DollarDto, RollingSeriesDto } from "../../../../lib/queries/currencyDollar";
import { toNum } from "../../../../lib/queries/portfolio";
import { contextUntilMs } from "../../numbers";
import { pct } from "./quote";

const WINDOW_LABEL = {
  "1m": "1 month",
  "3m": "3 months",
  "1y": "1 year",
} as const;
const W = 300;
const H = 88;

/**
 * One window's trailing change over the page range, on a band of its normal size: the
 * shaded band is ±the 80th percentile of every move of that length since 1999, the
 * dashed line zero. Plain presentation of the server's series (the view's quote).
 */
function RollingMini({ s, word, euro, ctx }: { s: RollingSeriesDto; word: string | null; euro: boolean; ctx: number | null }) {
  const pts = (s.points ?? [])
    .map((p) => ({
      t: Date.parse(p.t),
      // The view's own currency: the dollar's change (EUR view) or the euro's (USD view),
      // each computed on its own price by the server, with its own normal band.
      v: toNum(euro ? p.rate_pct : p.inverse_pct),
    }))
    .filter((p): p is { t: number; v: number } => p.v !== null && Number.isFinite(p.t));
  const limit = Math.abs(toNum(s.normal_limit_pct ?? null) ?? 0);
  const label = WINDOW_LABEL[s.window];
  if (pts.length < 2) return null;
  const vals = pts.map((p) => p.v);
  const extent = Math.max(limit * 1.8, ...vals.map(Math.abs).map((v) => v * 1.1)) || 0.01;
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * W;
  const y = (v: number) => H / 2 - (v / extent) * (H / 2 - 3);
  const path = (list: { t: number; v: number }[]) =>
    list.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  // Max: the days before you started are the rate's context, drawn muted and dashed.
  const before = ctx === null ? [] : pts.filter((p) => p.t <= ctx);
  const mine = ctx === null ? pts : pts.filter((p) => p.t > ctx);
  // The context line runs up to the first own point, so the two join without a gap.
  const ctxLine = before.length && mine.length ? [...before, mine[0]] : before;
  const d = path(mine.length >= 2 ? mine : pts);
  const dCtx = mine.length >= 2 && ctxLine.length >= 2 ? path(ctxLine) : null;
  const ctxEnd = dCtx ? x(ctxLine[ctxLine.length - 1].t) : 0;
  const last = pts[pts.length - 1].v;
  const outside = limit > 0 && Math.abs(last) > limit;
  const insideShare = limit > 0 ? vals.filter((v) => Math.abs(v) <= limit).length / vals.length : null;
  return (
    <figure className="dollar-rolling__item">
      <figcaption className="dollar-rolling__head">
        <span className="dollar-rolling__window">{label}</span>
        <span className="dollar-rolling__now">
          <strong className="dollar-rolling__value">{pct(last)}</strong>
          <span className={clsx("dollar-rolling__word", outside && "dollar-rolling__word--outside")}>
            {outside ? (word ?? "larger than usual") : "normal"}
          </span>
        </span>
      </figcaption>
      <div className="dollar-rolling__plot">
        <span className="u-sr-only">{`${label} change, now ${pct(last)}; normal range ±${pct(limit).replace(/^[+−-]/, "")}`}</span>
        <svg className="dollar-rolling__svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {limit > 0 ? (
            <>
              <rect className="dollar-rolling__band" x={0} width={W} y={y(limit)} height={y(-limit) - y(limit)} />
              <line className="dollar-rolling__edge" x1={0} x2={W} y1={y(limit)} y2={y(limit)} />
              <line className="dollar-rolling__edge" x1={0} x2={W} y1={y(-limit)} y2={y(-limit)} />
            </>
          ) : null}
          <line className="dollar-rolling__zero" x1={0} x2={W} y1={y(0)} y2={y(0)} />
          {dCtx ? (
            <>
              <rect className="dollar-rolling__before" x={0} width={ctxEnd} y={0} height={H} />
              <path className="dollar-rolling__line dollar-rolling__line--context" d={dCtx} />
            </>
          ) : null}
          <path className="dollar-rolling__line" d={d} />
        </svg>
        {/* The end dot in HTML: the stretched SVG would draw it as an ellipse. */}
        <span
          className={clsx("dollar-rolling__dot", outside && "dollar-rolling__dot--outside")}
          style={{
            // A fraction of the plot's width; the stylesheet keeps the whole dot inside it.
            ["--dot-x" as string]: x(t1) / W,
            top: `${(y(last) / H) * 100}%`,
          }}
        />
      </div>
      <p className="dollar-rolling__foot">
        <span>
          {formatDate(new Date(t0).toISOString().slice(0, 10))}
          {dCtx ? <span className="dollar-rolling__before-label"> · dashed: before you started</span> : null}
        </span>
        <span>{formatDate(new Date(t1).toISOString().slice(0, 10))}</span>
      </p>
      <p className="dollar-rolling__normal">
        <span className="dollar-rolling__swatch" aria-hidden />
        Normal ±{pct(limit).replace(/^[+−-]/, "")}
        {insideShare !== null ? ` · ${Math.round(insideShare * 100)}% of days inside` : ""}
      </p>
    </figure>
  );
}

/** Rolling 1M / 3M / 1Y changes, each next to its normal band (over the page range). */
export function RollingPanel({ data }: { data: DollarDto }) {
  const t = data.trend;
  const euro = t?.asset === "euro";
  const name = euro ? "euro" : "dollar";
  // One wording everywhere: the server's label for the windows it rates, else "larger than usual".
  const NAMES = { normal: "normal", large: "larger than usual", unusual: "unusual" } as const;
  const wordFor = (w: string) => {
    const r = w === "1m" ? t?.normal_month : w === "1y" ? t?.normal_year : null;
    return r ? NAMES[r.label] : null;
  };
  const series = (data.rolling ?? []).filter((s) => (s.points ?? []).length > 1);
  const ctx = contextUntilMs(data.window);
  if (data.rolling_too_short) {
    // 1D / 1W: a trailing month or year does not fit inside the range; say so calmly.
    return (
      <Card className="dollar-rolling" title="Rolling changes">
        <p className="dollar-rolling__short" data-state="too-short">
          Too short a range for trailing changes; pick 1M or longer.
        </p>
      </Card>
    );
  }
  if (series.length === 0) return null;
  return (
    <Card
      className="dollar-rolling"
      title={
        <span className="dollar-rolling__title">
          Rolling changes
          <InfoTip
            label="Rolling changes"
            content={`How much the ${name} moved over the trailing month, quarter and year at each day of the range. The shaded band is a normal move of that length (80% of all since 1999).`}
          />
        </span>
      }
      meta={`the ${name}'s change`}
    >
      <div className="dollar-rolling__grid">
        {series.map((s) => (
          <RollingMini key={s.window} s={s} word={wordFor(s.window)} euro={euro} ctx={ctx} />
        ))}
      </div>
    </Card>
  );
}
