import clsx from "clsx";
import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import { Card } from "../../../../components/Card";
import { InfoTip } from "../../../../components/InfoTip";
import { TREND_WORD } from "../../../../components/TrendChip";
import { formatDate } from "../../../../lib/format";
import { quoteOf, type DollarDto, type NormalRangeDto } from "../../../../lib/queries/currencyDollar";
import { toNum } from "../../../../lib/queries/portfolio";
import { pct, rateText, share } from "./quote";

const NORMAL_WORD = {
  normal: "normal",
  large: "larger than usual",
  unusual: "unusual",
} as const;
const WINDOW_WORD = { month: "month", year: "year" } as const;

/** The magnitude of a signed percent text: `+1.2%` -> `1.2%`. */
const mag = (v: number, digits = 1) => pct(Math.abs(v), digits).replace(/^[+−-]/, "");

/** Position (0..100) of `v` on a symmetric scale of ±`extent`, kept inside the track. */
const at = (v: number, extent: number) => Math.max(3, Math.min(97, 50 + (v / extent) * 50));

/** A round scale end (a multiple of half a percent) at or above `raw`. */
const niceExtent = (raw: number) => Math.max(0.005, Math.ceil(raw * 200) / 200);

const cap = (s: string) => s.replace(/^./, (c) => c.toUpperCase());

/** The direction words for either currency's trend (the euro's in the USD view). */
const DIRECTION_WORD = {
  ...TREND_WORD,
  euro_up: { word: "strengthening", Icon: TrendingUp },
  euro_down: { word: "weakening", Icon: TrendingDown },
} as const;

/**
 * "Is this move normal?": the dollar's move over the window against every move of the
 * same length since 1999. The shaded band is the normal range (80 % of all moves); the
 * dot is now. Outside the band the dot turns to the warning tint and the word says so
 * (never color alone).
 */
export function NormalGauge({ range }: { range: NormalRangeDto }) {
  const move = toNum(range.move_pct) ?? 0;
  const limit = Math.abs(toNum(range.normal_limit_pct) ?? 0.02);
  const typical = Math.abs(toNum(range.typical_move_pct) ?? limit / 2);
  const extent = niceExtent(Math.max(limit * 1.6, Math.abs(move) * 1.15, typical * 2));
  const outside = range.label !== "normal";
  const word = WINDOW_WORD[range.window];
  const digits = (extent * 100) % 1 === 0 ? 0 : 1;
  return (
    <div className="dollar-gauge">
      <span className="u-sr-only">{`This ${word} ${pct(move)}. The normal range is ±${mag(limit)}: ${NORMAL_WORD[range.label]}.`}</span>
      <div className="dollar-gauge__track" aria-hidden="true">
        <span className="dollar-gauge__band" style={{ left: `${at(-limit, extent)}%`, right: `${100 - at(limit, extent)}%` }} />
        <span className="dollar-gauge__zero" />
        <span className={clsx("dollar-gauge__dot", outside && "dollar-gauge__dot--outside")} style={{ left: `${at(move, extent)}%` }} />
      </div>
      <p className="dollar-gauge__scale" aria-hidden>
        <span>{pct(-extent, digits)}</span>
        <span>normal ±{mag(limit)}</span>
        <span>{pct(extent, digits)}</span>
      </p>
    </div>
  );
}

/** The figure and its word on a gauge cell's label line: "+1.6% · larger than usual". */
function GaugeAside({ range }: { range: NormalRangeDto }) {
  const outside = range.label !== "normal";
  return (
    <span className="dollar-trend__aside">
      <strong className="dollar-gauge__move">{pct(toNum(range.move_pct) ?? 0)}</strong>
      <span className={clsx("dollar-gauge__label", outside && "dollar-gauge__label--outside")}>{NORMAL_WORD[range.label]}</span>
    </span>
  );
}

/**
 * One cell: its label line (label and tip on the left, an optional figure on the right),
 * then the picture, its end labels and at most one short line, in that order in every
 * cell, so cells side by side line up.
 */
function Row({ label, tip, aside, children }: { label: string; tip?: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="dollar-trend__row">
      <dt className="dollar-trend__head">
        <span className="dollar-trend__label">
          {label}
          {tip ? <InfoTip label={label} content={tip} /> : null}
        </span>
        {aside}
      </dt>
      <dd className="dollar-trend__body">{children}</dd>
    </div>
  );
}

/** One bordered tile answering one question: its title, the answer as the headline, then its rows. */
function Tile({
  title,
  tip,
  headline,
  sub,
  flag,
  children,
}: {
  title: string;
  tip?: string;
  headline: React.ReactNode;
  sub?: string;
  flag?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={clsx("dollar-tile", flag && "dollar-tile--flag")} aria-label={title}>
      <header className="dollar-tile__head">
        <h3 className="dollar-tile__title">
          {title}
          {tip ? <InfoTip label={title} content={tip} /> : null}
        </h3>
        <p className="dollar-tile__headline">{headline}</p>
        {sub ? <p className="dollar-tile__sub">{sub}</p> : null}
      </header>
      <dl className="dollar-tile__rows">{children}</dl>
    </section>
  );
}

/** A filled bar with a dot at `at` (0..1); `mid` adds a centre tick (a symmetric scale). */
function Bar({ at: v, label, mid, fill }: { at: number; label: string; mid?: boolean; fill?: boolean }) {
  const pos = Math.max(2, Math.min(98, v * 100));
  return (
    <>
      <span className="u-sr-only">{label}</span>
      <div className="dollar-range__track" aria-hidden="true">
        {fill ? <span className="dollar-range__fill" style={{ width: `${Math.max(0, Math.min(100, v * 100))}%` }} /> : null}
        {mid ? <span className="dollar-range__mid" /> : null}
        <span className="dollar-range__dot" style={{ left: `${pos}%` }} />
      </div>
    </>
  );
}

/**
 * The dollar's trend (EUR view) or the euro's (USD view: you convert euros into dollars,
 * so the euro's strength is what matters), described and never predicted. A one-line verdict of chips first,
 * then three short groups: where it is heading, whether this month's and year's moves are
 * ordinary, and where it stands in its own history. Every row is a label, a picture and at
 * most one line; the longer explanations live in the tips. All figures are the server's;
 * the percentages are that currency's own change (the server computes each on its own
 * price), the rates are printed in the view's quote.
 */
export function TrendPanel({ data }: { data: DollarDto }) {
  const field = data.quote.field;
  const t: Partial<NonNullable<DollarDto["trend"]>> = data.trend ?? {};
  const euro = t.asset === "euro";
  const name = euro ? "euro" : "dollar";
  const regime = t.regime;
  const dir = regime ? DIRECTION_WORD[regime.direction] : null;
  const p = t.percentiles ?? {};
  const w = t.week52;
  // The dollar's 52-week low is EUR/USD's high (and the other way round).
  const lowPt = w ? (field === "rate" ? w.low : w.high) : null;
  const highPt = w ? (field === "rate" ? w.high : w.low) : null;
  const lo = lowPt ? toNum(quoteOf(lowPt, field)) : null;
  const hi = highPt ? toNum(quoteOf(highPt, field)) : null;
  const now = toNum(quoteOf(data.position?.rate_now ?? null, field));
  const nowAt = lo !== null && hi !== null && now !== null && hi > lo ? (now - lo) / (hi - lo) : null;
  const percentiles = [
    { key: "since_start", label: "since you started", v: toNum(p.since_start ?? null) },
    { key: "y5", label: "5 years", v: toNum(p.y5 ?? null) },
    { key: "y10", label: "10 years", v: toNum(p.y10 ?? null) },
    { key: "since_1999", label: "since 1999", v: toNum(p.since_1999 ?? null) },
  ].filter((x) => x.v !== null);
  const ma = t.ma200;
  const maDistance = ma ? toNum(ma.distance_pct) : null;
  const longRun = t.long_run;
  const longDistance = longRun ? toNum((euro ? longRun.distance_pct : longRun.distance_inverse_pct) ?? null) : null;
  const aboveEntry = toNum(t.above_entry_share ?? null);
  const month = t.normal_month;
  const year = t.normal_year;
  const run = t.run;
  const headline = percentiles[0];
  const hasDirection = Boolean((regime && dir) || (ma && maDistance !== null) || run);
  const hasNormal = Boolean(month || year);
  const hasStands = Boolean(percentiles.length || (w && lo !== null && hi !== null) || longRun || aboveEntry !== null);

  const monthWord = month
    ? { normal: "Normal this month", large: "Larger than usual this month", unusual: "Unusual this month" }[month.label]
    : null;
  const runRow = run ? (
    <Row
      label="Recent run"
      tip={`The ${name}'s move over each of the last months (calendar month ends). Filled months went the way of the run.`}
    >
      <ol className="dollar-run" aria-label={`The ${name} ${run.direction} in ${run.count} of the last ${run.of} months`}>
        {(run.months ?? []).map((m) => {
          const Icon = m.move === "rose" ? TrendingUp : m.move === "fell" ? TrendingDown : Minus;
          const [y, mo] = m.month.split("-").map(Number);
          const monthName = new Date(Date.UTC(y, mo - 1, 1)).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
          return (
            <li key={m.month} className={clsx("dollar-run__item", m.move === run.direction && "dollar-run__item--on")}>
              <span className="dollar-run__cell" title={`${monthName} ${y}: the ${name} ${m.move}`}>
                <Icon aria-hidden className="dollar-run__icon" />
              </span>
              <span className="dollar-run__month">{monthName}</span>
            </li>
          );
        })}
      </ol>
      <p className="dollar-trend__line">
        {cap(run.direction)} in {run.count} of the last {run.of} months
      </p>
    </Row>
  ) : null;

  return (
    <Card className="dollar-trend" title={euro ? "Euro trend" : "Dollar trend"}>
      <div className="dollar-trend__tiles">
        {hasDirection ? (
          <Tile
            title="Direction"
            tip={`The direction only changes once the ${name} has clearly crossed its 200-day average, so the label does not flicker.`}
            headline={
              regime && dir ? (
                <>
                  <dir.Icon aria-hidden className="dollar-tile__icon" />
                  {cap(dir.word)}
                </>
              ) : (
                "Direction"
              )
            }
            sub={regime ? `since ${formatDate(regime.since)} · ${pct(toNum(regime.since_change_pct))}` : undefined}
          >
            {ma && maDistance !== null ? (
              <Row
                label="200-day average"
                tip={`The ${name}'s average rate over the last 200 days (${rateText(toNum(quoteOf(ma.ma200, field)), field)}), and whether that average is rising or falling (now ${ma.slope}).`}
              >
                <div className="dollar-range">
                  <Bar at={at(maDistance, 0.06) / 100} mid label={`The ${name} is ${mag(maDistance)} ${ma.side} its 200-day average`} />
                  <p className="dollar-range__ends" aria-hidden>
                    <span>−6%</span>
                    <span>average</span>
                    <span>+6%</span>
                  </p>
                </div>
                <p className="dollar-trend__line">
                  {(regime?.direction.endsWith("_down") && ma.side === "above") ||
                  (regime?.direction.endsWith("_up") && ma.side === "below")
                    ? "Still "
                    : ""}
                  {mag(maDistance)} {ma.side}, average {ma.slope}
                </p>
              </Row>
            ) : null}
            {runRow}
          </Tile>
        ) : null}
        {hasNormal ? (
          <Tile
            title="Is this normal?"
            tip={`The ${name}'s move against every move of the same length since 1999. The shaded band holds the 80% that were normal.`}
            headline={monthWord ?? "Normal?"}
            sub={month ? `a typical month moves about ±${mag(toNum(month.typical_move_pct) ?? 0)}` : undefined}
            flag={month ? month.label !== "normal" : false}
          >
            {month ? (
              <Row label="This month" tip="The last month's move against every month since 1999." aside={<GaugeAside range={month} />}>
                <NormalGauge range={month} />
              </Row>
            ) : null}
            {year ? (
              <Row
                label="This year"
                tip={`The last year's move against every year since 1999. A typical year moves about ±${mag(toNum(year.typical_move_pct) ?? 0)}.`}
                aside={<GaugeAside range={year} />}
              >
                <NormalGauge range={year} />
              </Row>
            ) : null}
          </Tile>
        ) : null}
        {hasStands ? (
          <Tile
            title="Where it stands"
            tip={`The share of days on which the ${name} was cheaper than today. A high share means the ${name} is dear against its own history.`}
            headline={headline && headline.v !== null ? `Higher than on ${share(headline.v)} of days` : "Where it stands"}
            sub={headline ? headline.label : undefined}
          >
            {percentiles.length > 1 ? (
              <Row label="Against history" tip={`The share of days on which the ${name} was cheaper than today, in each window.`}>
                <ul className="dollar-pct" aria-label={`Share of days the ${name} was cheaper than today`}>
                  {percentiles.map((x) => (
                    <li key={x.key} className="dollar-pct__row">
                      <span className="dollar-pct__label">{x.label}</span>
                      <span className="u-sr-only">{`Cheaper than today on ${share(x.v)} of days ${x.label}`}</span>
                      <span className="dollar-pct__track" aria-hidden="true">
                        <span className="dollar-pct__fill" style={{ width: `${(x.v ?? 0) * 100}%` }} />
                        <span className="dollar-pct__dot" style={{ left: `${Math.max(2, Math.min(98, (x.v ?? 0) * 100))}%` }} />
                      </span>
                      <strong className="dollar-pct__value">{share(x.v)}</strong>
                    </li>
                  ))}
                </ul>
              </Row>
            ) : null}
            {w && lo !== null && hi !== null ? (
              <Row label="52 weeks" tip="Today's rate between the lowest and highest rate of the last 52 weeks.">
                <div className="dollar-range">
                  {nowAt !== null ? <Bar at={nowAt} label={`Today ${rateText(now, field)} between the 52-week low and high`} /> : null}
                  <p className="dollar-range__ends" aria-hidden>
                    <span>low {rateText(lo, field)}</span>
                    <span>high {rateText(hi, field)}</span>
                  </p>
                </div>
                <p className="dollar-trend__line">
                  {mag(toNum(euro ? w.from_low_rate_pct : w.from_high_inverse_pct) ?? 0)} above the low,{" "}
                  {mag(toNum(euro ? w.from_high_rate_pct : w.from_low_inverse_pct) ?? 0)} below the high
                </p>
              </Row>
            ) : null}
            {longRun && longDistance !== null ? (
              <Row
                label="Long run"
                tip={`The ${name} against its average since 1999. Exchange rates tend to drift back toward it over years, not months.`}
              >
                <div className="dollar-range">
                  <Bar
                    at={at(longDistance, 0.3) / 100}
                    mid
                    label={`${mag(longDistance)} ${longDistance >= 0 ? "above" : "below"} its long-run average`}
                  />
                  <p className="dollar-range__ends" aria-hidden>
                    <span>−30%</span>
                    <span>average since {longRun.since.slice(0, 4)}</span>
                    <span>+30%</span>
                  </p>
                </div>
                <p className="dollar-trend__line">
                  {mag(longDistance)} {longDistance >= 0 ? "above" : "below"} the average (
                  {rateText(toNum(quoteOf(longRun.mean, field)), field)})
                </p>
              </Row>
            ) : null}
            {aboveEntry !== null ? (
              <Row
                label="You"
                tip={
                  euro
                    ? "The share of days since your first transaction on which the euro bought more dollars than at your average conversion rate."
                    : "The share of days since your first transaction on which the dollar was above your average rate."
                }
              >
                <div className="dollar-range">
                  <Bar at={aboveEntry} fill label={`The ${name} was above your average rate on ${share(aboveEntry)} of days`} />
                  <p className="dollar-range__ends" aria-hidden>
                    <span>no days</span>
                    <span>every day</span>
                  </p>
                </div>
                <p className="dollar-trend__line">Above your average rate on {share(aboveEntry)} of days</p>
              </Row>
            ) : null}
          </Tile>
        ) : null}
      </div>
    </Card>
  );
}
