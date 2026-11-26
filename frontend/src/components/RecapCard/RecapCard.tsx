import { CalendarCheck, ChevronLeft, ChevronRight, X } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "../IconButton";
import { Money } from "../Money";
import { Percent } from "../Percent";
import { formatMonth } from "../../lib/format";
import type { ReportingCurrency } from "../../lib/prefs";
import { toNum } from "../../lib/queries/reports";
import { useAckRecap, useRecap, type RecapDto, type RecapSideDto } from "../../lib/queries/recap";
import "./RecapCard.scss";

/** "2026-10" -> "October 2026"; a year stays "2025". */
export function recapTitle(period: string): string {
  return period.length === 4 ? `${period} in review` : `${formatMonth(period, "long")} in review`;
}

export interface RecapFact {
  key: string;
  label: string;
  value: ReactNode;
}

/**
 * The figures of one side, in reading order: a label and one figure each, no note lines,
 * so every cell has the same height and nothing leaves an empty line. Server figures
 * only; a line with nothing to say is left out (cashed out while 0, dividends while 0, a
 * period without conversions). The dollar view shows dollars only: the currency part,
 * the conversion cost and the real return are euro stories. The period's closing value
 * fills in when the count would be odd, so a phone never shows a lone figure.
 */
export function recapFacts(
  side: RecapSideDto,
  currency: ReportingCurrency,
  granularity: "month" | "year" = "month",
): RecapFact[] {
  const eur = currency === "EUR";
  const money = (v: string | null | number, signed = false) => (
    <Money amount={typeof v === "number" ? v : toNum(v)} currency={currency} digits={0} signed={signed} colored={signed} />
  );
  const facts: RecapFact[] = [
    {
      key: "return",
      label: eur ? "Return in euros" : "Return",
      value: <Percent ratio={toNum(side.nominal_return)} signed colored />,
    },
  ];
  if (eur) {
    const real = toNum(side.real_return);
    facts.push({
      key: "real",
      // "to <month>": the price index is published weeks after the month ends.
      label: side.real_to ? `Real · to ${formatMonth(side.real_to, "short")}` : "Real · index not out",
      value: real !== null ? <Percent ratio={real} signed colored /> : <span className="recap-card__none">–</span>,
    });
  }
  facts.push({ key: "contributed", label: "Contributed", value: money(side.contributed) });
  if (toNum(side.cashed_out)) facts.push({ key: "cashed-out", label: "Cashed out", value: money(side.cashed_out) });
  facts.push({ key: "market", label: "Market", value: money(side.market, true) });
  const income = (toNum(side.dividends) ?? 0) + (toNum(side.interest) ?? 0);
  if (income) facts.push({ key: "dividends", label: "Of which dividends", value: money(income) });
  if (eur && toNum(side.currency) !== null) {
    facts.push({ key: "currency", label: "Currency", value: money(side.currency, true) });
  }
  const cost = toNum(side.conversion_cost);
  if (eur && cost !== null && side.conversions > 0) {
    facts.push({
      key: "cost",
      label: side.conversions === 1 ? "Conversion cost" : `Cost · ${side.conversions} conversions`,
      value: <Money amount={-cost} currency={currency} digits={2} signed colored />,
    });
  }
  if (facts.length % 2 === 1 && toNum(side.closing_value) !== null) {
    facts.splice(1, 0, {
      key: "value",
      label: granularity === "year" ? "Value at year end" : "Value at month end",
      value: money(side.closing_value),
    });
  }
  return facts;
}

export interface RecapCardProps {
  currency: ReportingCurrency;
  /** `overview`: only when due, with a dismiss (= ack). `periods`: always, with a stepper. */
  place: "overview" | "periods";
  /** Periods: the period shown (`null` = the server's default) and the finished ones to step through, oldest first. */
  period?: string | null;
  periods?: { month: string[]; year: string[] };
  onPeriod?: (period: string) => void;
}

/**
 * The month / year recap (7.4 P8): one header line, then one row of figures split by
 * hairlines, like the Daily Brief and the stat strips (two columns on a phone, a lone
 * last figure spans both). Every figure equals the Periods page for the same period.
 */
const NO_PERIODS = { month: [], year: [] };

export function RecapCard({ currency, place, period = null, periods = NO_PERIODS, onPeriod }: RecapCardProps) {
  const recap = useRecap(period);
  const r = recap.data;
  if (!r || !r.has_data) return null;
  if (place === "overview" && !r.due) return null;
  return <RecapBody recap={r} currency={currency} place={place} periods={periods[r.granularity]} onPeriod={onPeriod} />;
}

function RecapBody({
  recap: r,
  currency,
  place,
  periods,
  onPeriod,
}: {
  recap: RecapDto;
  currency: ReportingCurrency;
  place: RecapCardProps["place"];
  periods: string[];
  onPeriod?: (period: string) => void;
}) {
  const { mutate } = useAckRecap();
  const facts = recapFacts(r[currency], currency, r.granularity);
  const at = periods.indexOf(r.period);
  const prev = at > 0 ? periods[at - 1] : null;
  const next = at >= 0 && at < periods.length - 1 ? periods[at + 1] : null;
  return (
    <section className="recap-card u-enter" aria-label={recapTitle(r.period)} data-testid="recap-card">
      <header className="recap-card__head">
        <span className="recap-card__icon">
          <CalendarCheck aria-hidden />
        </span>
        <h2 className="recap-card__title" data-testid="recap-title">
          {recapTitle(r.period)}
        </h2>
        {place === "periods" && onPeriod && periods.length > 1 && (
          <span className="recap-card__nav">
            <IconButton
              size="sm"
              label="Previous period"
              icon={<ChevronLeft aria-hidden />}
              disabled={!prev}
              onClick={() => prev && onPeriod(prev)}
            />
            <IconButton
              size="sm"
              label="Next period"
              icon={<ChevronRight aria-hidden />}
              disabled={!next}
              onClick={() => next && onPeriod(next)}
            />
          </span>
        )}
        {place === "overview" && (
          <IconButton
            className="recap-card__dismiss"
            label="Dismiss the recap"
            size="sm"
            icon={<X aria-hidden />}
            onClick={() => mutate(r.period)}
          />
        )}
      </header>
      <dl className={`recap-card__facts recap-card__facts--n${facts.length}`}>
        {facts.map((f) => (
          <div key={f.key} className="recap-card__fact" data-testid={`recap-${f.key}`}>
            <dt className="recap-card__label" data-truncate-ok title={f.label}>{f.label}</dt>
            <dd className="recap-card__value">{f.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
