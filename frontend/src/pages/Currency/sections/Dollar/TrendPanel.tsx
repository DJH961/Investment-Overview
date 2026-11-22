import clsx from "clsx";
import { Card } from "../../../../components/Card";
import { InfoTip } from "../../../../components/InfoTip";
import { TREND_WORD } from "../../../../components/TrendChip";
import { formatDate } from "../../../../lib/format";
import { quoteOf, type DollarDto, type NormalRangeDto } from "../../../../lib/queries/currencyDollar";
import { toNum } from "../../../../lib/queries/portfolio";
import { pct, rateText, share } from "./quote";

const NORMAL_WORD = { normal: "normal", large: "larger than usual", unusual: "unusual" } as const;
const WINDOW_WORD = { month: "month", year: "year" } as const;

/** Position (0..100) of `v` on a symmetric scale of ±`extent`. */
const at = (v: number, extent: number) => Math.max(0, Math.min(100, 50 + (v / extent) * 50));

/**
 * "Is this move normal?": the dollar's move over the window against every move of the
 * same length since 1999. The shaded band is the normal range (80 % of all moves), the
 * ticks a typical move; the dot is now. Outside the band the dot turns to the warning
 * tint and the word says so (never colour alone).
 */
export function NormalGauge({ range }: { range: NormalRangeDto }) {
  const move = toNum(range.move_pct) ?? 0;
  const limit = Math.abs(toNum(range.normal_limit_pct) ?? 0.02);
  const typical = Math.abs(toNum(range.typical_move_pct) ?? limit / 2);
  const extent = Math.max(limit * 1.8, Math.abs(move) * 1.15, typical * 2);
  const outside = range.label !== "normal";
  const word = WINDOW_WORD[range.window];
  return (
    <div className="dollar-gauge">
      <p className="dollar-gauge__text">
        This {word} <strong className="dollar-gauge__move">{pct(move)}</strong>; a typical {word} moves ±
        {pct(typical).replace(/^[+−-]/, "")}
        <span className={clsx("dollar-gauge__label", outside && "dollar-gauge__label--outside")}>{NORMAL_WORD[range.label]}</span>
      </p>
      <div
        className="dollar-gauge__track"
        role="img"
        aria-label={`This ${word} ${pct(move)}. Normal range ±${pct(limit).replace(/^[+−-]/, "")}: ${NORMAL_WORD[range.label]}.`}
      >
        <span className="dollar-gauge__band" style={{ left: `${at(-limit, extent)}%`, right: `${100 - at(limit, extent)}%` }} />
        <span className="dollar-gauge__zero" />
        <span className="dollar-gauge__tick" style={{ left: `${at(-typical, extent)}%` }} />
        <span className="dollar-gauge__tick" style={{ left: `${at(typical, extent)}%` }} />
        <span className={clsx("dollar-gauge__dot", outside && "dollar-gauge__dot--outside")} style={{ left: `${at(move, extent)}%` }} />
      </div>
      <p className="dollar-gauge__scale" aria-hidden>
        <span>{pct(-extent, 0)}</span>
        <span>normal ±{pct(limit).replace(/^[+−-]/, "")}</span>
        <span>{pct(extent, 0)}</span>
      </p>
    </div>
  );
}

/** One row of the trend panel: a short label, then plain sentences. */
function Row({ label, tip, children }: { label: string; tip?: string; children: React.ReactNode }) {
  return (
    <div className="dollar-trend__row">
      <dt className="dollar-trend__label">
        {label}
        {tip ? <InfoTip label={label} content={tip} /> : null}
      </dt>
      <dd className="dollar-trend__body">{children}</dd>
    </div>
  );
}

/**
 * The dollar's trend, described and never predicted: its regime (with hysteresis), how
 * ordinary this month's and this year's moves are, where today sits in its own history,
 * its recent run, its distance from the long-run average, and how often you have been
 * above your entry. All from the server's trend block; the dollar's own terms
 * throughout, rates printed in the view's quote.
 */
export function TrendPanel({ data }: { data: DollarDto }) {
  const field = data.quote.field;
  const t = data.trend ?? {};
  const regime = t.regime;
  const dir = regime ? TREND_WORD[regime.direction] : null;
  const p = t.percentiles ?? {};
  const p1999 = toNum(p.since_1999 ?? null);
  const w = t.week52;
  // The dollar's 52-week low is EUR/USD's high (and the other way round).
  const lowPt = w ? (field === "rate" ? w.low : w.high) : null;
  const highPt = w ? (field === "rate" ? w.high : w.low) : null;
  const lo = lowPt ? toNum(quoteOf(lowPt, field)) : null;
  const hi = highPt ? toNum(quoteOf(highPt, field)) : null;
  const now = toNum(quoteOf(data.position?.rate_now ?? null, field));
  const nowAt = lo !== null && hi !== null && now !== null && hi > lo ? Math.max(0, Math.min(100, ((now - lo) / (hi - lo)) * 100)) : null;
  const percentiles = [
    { key: "since_start", label: "since you started", v: toNum(p.since_start ?? null) },
    { key: "y5", label: "5 years", v: toNum(p.y5 ?? null) },
    { key: "y10", label: "10 years", v: toNum(p.y10 ?? null) },
    { key: "since_1999", label: "since 1999", v: p1999 },
  ].filter((x) => x.v !== null);

  return (
    <Card className="dollar-trend" title="Dollar trend">
      <dl className="dollar-trend__rows">
        {regime && dir ? (
          <Row label="Regime" tip="The direction only changes once the dollar has clearly crossed its 200-day average, so the label does not flicker.">
            <p className="dollar-trend__lead">
              <dir.Icon aria-hidden className="dollar-trend__icon" />
              <span>
                <strong className="dollar-trend__strong">{dir.word.replace(/^./, (c) => c.toUpperCase())}</strong> since{" "}
                {formatDate(regime.since)} ({pct(toNum(regime.since_change_pct))})
              </span>
            </p>
            {t.ma200 ? (
              <p className="dollar-trend__line">
                {t.ma200.side === "above" ? "Above" : "Below"} its 200-day average ({rateText(toNum(quoteOf(t.ma200.ma200, field)), field)},{" "}
                {pct(toNum(t.ma200.distance_pct))}), which is {t.ma200.slope}
              </p>
            ) : null}
          </Row>
        ) : null}
        {t.normal_month || t.normal_year ? (
          <Row
            label="Normal?"
            tip="The dollar's move over the last month and year against every move of the same length since 1999. The shaded band holds 80 % of them."
          >
            <div className="dollar-trend__gauges">
              {t.normal_month ? <NormalGauge range={t.normal_month} /> : null}
              {t.normal_year ? <NormalGauge range={t.normal_year} /> : null}
            </div>
          </Row>
        ) : null}
        {percentiles.length > 0 ? (
          <Row label="Context" tip="The share of days on which the dollar was cheaper than today, in each window.">
            <p className="dollar-trend__line">
              The dollar was cheaper than today on{" "}
              {percentiles.map((x, i) => (
                <span key={x.key}>
                  {i > 0 ? (i === percentiles.length - 1 ? " and " : ", ") : ""}
                  <strong className="dollar-trend__strong">{share(x.v)}</strong> of days {x.label}
                </span>
              ))}
            </p>
            {p1999 !== null ? (
              <div className="dollar-range">
                <div className="dollar-range__track" role="img" aria-label={`Today the dollar is dearer than on ${share(p1999)} of days since 1999`}>
                  <span className="dollar-range__fill" style={{ width: `${p1999 * 100}%` }} />
                  <span className="dollar-range__dot" style={{ left: `${p1999 * 100}%` }} />
                </div>
                <p className="dollar-range__ends" aria-hidden>
                  <span>cheapest since 1999</span>
                  <span>today {share(p1999)}</span>
                  <span>dearest</span>
                </p>
              </div>
            ) : null}
          </Row>
        ) : null}
        {w && lo !== null && hi !== null ? (
          <Row label="52 weeks">
            <div className="dollar-range">
              <p className="dollar-range__ends dollar-range__ends--figures">
                <span>
                  low <strong className="dollar-trend__strong">{rateText(lo, field)}</strong>
                </span>
                <span>
                  high <strong className="dollar-trend__strong">{rateText(hi, field)}</strong>
                </span>
              </p>
              <div className="dollar-range__track" role="img" aria-label={`Today ${rateText(now, field)} between the 52-week low and high`}>
                {nowAt !== null ? <span className="dollar-range__dot" style={{ left: `${nowAt}%` }} /> : null}
              </div>
              <p className="dollar-trend__line dollar-trend__line--muted">
                The dollar is {pct(toNum(w.from_high_inverse_pct))} from its 52-week low and {pct(toNum(w.from_low_inverse_pct))} from its high
              </p>
            </div>
          </Row>
        ) : null}
        {t.run ? (
          <Row label="Run">
            <p className="dollar-trend__line">
              The dollar {t.run.direction} in <strong className="dollar-trend__strong">{t.run.count}</strong> of the last {t.run.of}{" "}
              months
            </p>
          </Row>
        ) : null}
        {t.long_run ? (
          <Row label="Long run" tip="The dollar against its average since 1999. Exchange rates tend to drift back towards it over years, not months.">
            <p className="dollar-trend__line">
              {pct(toNum(t.long_run.distance_inverse_pct))} from its average since {t.long_run.since.slice(0, 4)} (
              {rateText(toNum(quoteOf(t.long_run.mean, field)), field)})
            </p>
          </Row>
        ) : null}
        {t.above_entry_share ? (
          <Row label="You">
            <p className="dollar-trend__line">
              The dollar was above your entry rate on <strong className="dollar-trend__strong">{share(toNum(t.above_entry_share))}</strong> of
              days since you started
            </p>
          </Row>
        ) : null}
      </dl>
    </Card>
  );
}
