import { useEffect, useState } from "react";
import { ArrowRight, Scale } from "lucide-react";
import { Link } from "react-router";
import { Card } from "../../../components/Card";
import { CurrencySection, serverStatItem, type StatMeta } from "../../../components/CurrencySection";
import { InfoTip } from "../../../components/InfoTip";
import { Money } from "../../../components/Money";
import { formatDate, formatNumber, formatPercent } from "../../../lib/format";
import { useScenarios, type ScenarioStatDto, type ScenariosDto } from "../../../lib/queries/currencyDollar";
import { toNum } from "../../../lib/queries/portfolio";
import type { CurrencySectionComponentProps } from "../sections";
import "./WhatIf.scss";

const STAT_META: Record<ScenarioStatDto["key"], StatMeta> = {
  one_cent: { label: "One cent", tip: "How much your dollar holdings would be worth if EUR/USD moved by one cent, at today's position." },
  breakeven: { label: "Break-even", tip: "The EUR/USD rate at which the currency effect on your holdings would be zero." },
  value_at_low: { label: "At the low", tip: "The value of your dollar holdings at the lowest rate in the available history." },
  value_at_high: { label: "At the high", tip: "The value of your dollar holdings at the highest rate in the available history." },
  volatility: { label: "Volatility", tip: "Annualised movement of the holdings in euros and dollars over the measured period.", fractionFormat: "percent" },
  deepest_fall: { label: "Deepest fall", tip: "The largest peak-to-trough fall measured in each currency over the available history.", fractionFormat: "percent" },
  dollar_rose_on_down_days: { label: "Dollar cushion", tip: "How often the dollar rose on days when the dollar-valued holdings fell.", fractionFormat: "percent" },
};

function statsFor(data: ScenariosDto) {
  return (data.stats ?? [])
    .filter((s) => s.key !== "dollar_rose_on_down_days")
    .map((s) => serverStatItem(s, STAT_META[s.key], data.ccy));
}

function ScenarioSlider({ data }: { data: ScenariosDto }) {
  const rows = data.rows ?? [];
  const marks = data.marks ?? [];
  const today = marks.find((m) => m.key === "today");
  const [index, setIndex] = useState(today?.row_index ?? 0);
  useEffect(() => setIndex(Math.min(rows.length - 1, Math.max(0, today?.row_index ?? 0))), [rows.length, today?.row_index]);
  const activeIndex = Math.min(rows.length - 1, Math.max(0, index));
  const row = rows[activeIndex];
  const max = Math.max(rows.length - 1, 1);
  const markerLabels: Record<(typeof marks)[number]["key"], string> = {
    historic_low: "Historic low",
    historic_high: "Historic high",
    average: "Your average",
    breakeven: "Break-even",
    today: "Today",
  };
  if (!row) return null;

  return (
    <Card className="what-if__scenario" title="Try another exchange rate">
      <p className="what-if__intro">
        Move the rate to see what your holdings would be worth. These are today's holdings valued at one rate; the app does not guess where the rate will go.
      </p>
      <div className="scenario-slider">
        <label className="scenario-slider__label" htmlFor="what-if-rate">
          EUR/USD <strong className="scenario-slider__rate">{row.rate_display}</strong>
        </label>
        <div className="scenario-slider__control">
          <input
            id="what-if-rate"
            className="scenario-slider__input"
            type="range"
            min={0}
            max={max}
            step={1}
            value={activeIndex}
            onChange={(event) => setIndex(Number(event.currentTarget.value))}
            aria-valuetext={`EUR/USD ${row.rate_display}`}
          />
        </div>
        {marks.length ? (
          <ul className="scenario-slider__reference-list" aria-label="Reference rates">
            {marks.map((mark) => (
              <li key={mark.key} className="scenario-slider__reference">
                <span className="scenario-slider__reference-label">{markerLabels[mark.key]}</span>
                <strong className="scenario-slider__reference-rate">{mark.rate_display}</strong>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="scenario-slider__ends" aria-hidden>
          <span>{formatNumber(toNum(data.min_rate), 4)}</span>
          <span>{formatNumber(toNum(data.max_rate), 4)}</span>
        </p>
      </div>
      <dl className="scenario-result">
        <div className="scenario-result__item scenario-result__item--lead">
          <dt className="scenario-result__label">Holdings worth</dt>
          <dd className="scenario-result__value"><Money amount={toNum(row.value)} currency={data.ccy} digits={0} /></dd>
        </div>
        <div className="scenario-result__item">
          <dt className="scenario-result__label">Currency gain/loss</dt>
          <dd className="scenario-result__value"><Money amount={toNum(row.gain)} currency={data.ccy} signed colored digits={0} /></dd>
        </div>
        <div className="scenario-result__item">
          <dt className="scenario-result__label">From break-even</dt>
          <dd className="scenario-result__value">
            {row.to_breakeven_pct == null ? "—" : formatPercent(toNum(row.to_breakeven_pct), { signed: true })}
          </dd>
          <dd className="scenario-result__note">
            {row.to_breakeven == null ? "Break-even is not available" : `${formatNumber(toNum(row.to_breakeven), 4)} EUR/USD`}
          </dd>
        </div>
      </dl>
      <p className="what-if__caption">
        Values use the server's scenario rows. The rate marks show your average, break-even and historical range when available.
      </p>
    </Card>
  );
}

function RiskCard({ data }: { data: ScenariosDto }) {
  const cushion = data.cushion;
  if (!cushion) return null;
  const rose = toNum(cushion.dollar_rose_share);
  return (
    <Card className="what-if__risk" title={<span className="what-if__title">Does the dollar cushion your swings?<InfoTip label="Does the dollar cushion your swings?" content="A comparison of the portfolio's historical volatility and deepest fall in euros and dollars. It describes what happened; it is not a promise that it will happen again." /></span>}>
      <p className="what-if__intro">Your own history, since {formatDate(cushion.since)}.</p>
      <div className="risk-compare" role="table" aria-label="Portfolio risk in euros and dollars">
        <div className="risk-compare__head" role="row"><span role="columnheader">Measure</span><span role="columnheader">EUR</span><span role="columnheader">USD</span></div>
        <div className="risk-compare__row" role="row"><span role="rowheader">Volatility</span><span role="cell">{formatPercent(toNum(cushion.volatility_eur), { digits: 1 })}</span><span role="cell">{formatPercent(toNum(cushion.volatility_usd), { digits: 1 })}</span></div>
        <div className="risk-compare__row" role="row"><span role="rowheader">Deepest fall</span><span role="cell">{formatPercent(toNum(cushion.max_drawdown_eur), { digits: 1 })}</span><span role="cell">{formatPercent(toNum(cushion.max_drawdown_usd), { digits: 1 })}</span></div>
      </div>
      {rose !== null ? (
        <p className="what-if__cushion">
          On {cushion.down_days_dollar_rose} of {cushion.down_days} down days, the dollar rose ({formatPercent(rose, { digits: 0 })}).
        </p>
      ) : <p className="what-if__caption">There are not enough paired down days to compare yet.</p>}
    </Card>
  );
}

/** Server-calculated what-if scenarios, with a discrete slider that only selects a row. */
export function WhatIf({ id, label, currency }: CurrencySectionComponentProps) {
  const q = useScenarios(currency);
  const data = q.data;
  const hasRows = Boolean(data?.rows?.length);
  return (
    <CurrencySection
      id={id}
      title={label}
      explainer="See what a different exchange rate would mean for your dollar holdings."
      meta={data?.as_of ? `As of ${formatDate(data.as_of)}` : undefined}
      stats={data ? statsFor(data) : undefined}
      statsLabel="What if at a glance"
      state={q.isError && !data ? "error" : !data ? "loading" : hasRows ? "ready" : "empty"}
      onRetry={() => void q.refetch()}
      busy={q.isFetching && !q.isPending && q.isPlaceholderData}
      emptyIcon={<Scale aria-hidden />}
      emptyTitle="No dollar holdings to model"
      emptyDescription="Once you hold something priced in dollars, you can see how different rates would value it."
      skeleton={["5rem", "16rem"]}
      className="what-if-section"
    >
      {data ? (
        <div className="what-if">
          <ScenarioSlider data={data} />
          <div className="what-if__pair">
            <RiskCard data={data} />
            <Card className="what-if__projection" title="Projection at different rates">
              <p className="what-if__intro">The Projection page also shows a range of possible euro values at the horizon.</p>
              <Link className="what-if__link" to="/projection#rate-band">See the rate band <ArrowRight aria-hidden /></Link>
            </Card>
          </div>
        </div>
      ) : null}
    </CurrencySection>
  );
}
