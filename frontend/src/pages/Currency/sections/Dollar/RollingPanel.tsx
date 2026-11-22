import clsx from "clsx";
import { Card } from "../../../../components/Card";
import { InfoTip } from "../../../../components/InfoTip";
import { formatAxisDate } from "../../../../lib/format";
import type { DollarDto, RollingSeriesDto } from "../../../../lib/queries/currencyDollar";
import { toNum } from "../../../../lib/queries/portfolio";
import { pct } from "./quote";

const WINDOW_LABEL = { "1m": "1 month", "3m": "3 months", "1y": "1 year" } as const;
const W = 300;
const H = 88;

/**
 * One window's trailing change over the page range, on a band of its normal size: the
 * shaded band is ±the 80th percentile of every move of that length since 1999, the
 * dashed line zero. Plain presentation of the server's series (the view's quote).
 */
function RollingMini({ s, field }: { s: RollingSeriesDto; field: DollarDto["quote"]["field"] }) {
  const pts = (s.points ?? [])
    .map((p) => ({ t: Date.parse(p.t), v: toNum(field === "inverse" ? p.inverse_pct : p.rate_pct) }))
    .filter((p): p is { t: number; v: number } => p.v !== null && Number.isFinite(p.t));
  const limit = Math.abs(toNum(s.normal_limit_pct ?? null) ?? 0);
  const label = WINDOW_LABEL[s.window];
  if (pts.length < 2) return null;
  const vals = pts.map((p) => p.v);
  const extent = Math.max(limit * 1.25, ...vals.map(Math.abs)) || 0.01;
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * W;
  const y = (v: number) => H / 2 - (v / extent) * (H / 2 - 3);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
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
            {outside ? "outside normal" : "normal"}
          </span>
        </span>
      </figcaption>
      <div className="dollar-rolling__plot">
        <svg
          className="dollar-rolling__svg"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${label} change, now ${pct(last)}; normal range ±${pct(limit).replace(/^[+−-]/, "")}`}
        >
          {limit > 0 ? <rect className="dollar-rolling__band" x={0} width={W} y={y(limit)} height={y(-limit) - y(limit)} /> : null}
          <line className="dollar-rolling__zero" x1={0} x2={W} y1={y(0)} y2={y(0)} />
          <path className="dollar-rolling__line" d={d} />
        </svg>
        {/* The end dot in HTML: the stretched SVG would draw it as an ellipse. */}
        <span
          className={clsx("dollar-rolling__dot", outside && "dollar-rolling__dot--outside")}
          style={{ left: `${(x(t1) / W) * 100}%`, top: `${(y(last) / H) * 100}%` }}
        />
      </div>
      <p className="dollar-rolling__foot">
        <span>{formatAxisDate(t0, 0)}</span>
        <span>
          normal ±{pct(limit).replace(/^[+−-]/, "")}
          {insideShare !== null ? ` · inside ${Math.round(insideShare * 100)} % of the time` : ""}
        </span>
      </p>
    </figure>
  );
}

/** Rolling 1M / 3M / 1Y changes, each next to its normal band (over the page range). */
export function RollingPanel({ data }: { data: DollarDto }) {
  const field = data.quote.field;
  const series = (data.rolling ?? []).filter((s) => (s.points ?? []).length > 1);
  if (series.length === 0) return null;
  return (
    <Card
      className="dollar-rolling"
      title={
        <span className="dollar-rolling__title">
          Rolling changes
          <InfoTip
            label="Rolling changes"
            content={`How much ${field === "inverse" ? "one dollar in euros" : "EUR/USD"} moved over the trailing month, quarter and year at each day of the range. The shaded band is a normal move of that length (80 % of all since 1999).`}
          />
        </span>
      }
      meta={data.quote.pair}
    >
      <div className="dollar-rolling__grid">
        {series.map((s) => (
          <RollingMini key={s.window} s={s} field={field} />
        ))}
      </div>
    </Card>
  );
}
