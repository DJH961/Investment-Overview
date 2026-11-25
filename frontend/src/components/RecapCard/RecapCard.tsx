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
  note?: ReactNode;
}

/**
 * The figures of one side, in reading order. Server figures only; a line with nothing
 * to say is left out (cashed out while 0, a period without conversions). The dollar view
 * shows dollars only: the currency part, the conversion cost and the real return are
 * euro stories (the owner holds dollar funds, so in dollars they are empty).
 */
export function recapFacts(side: RecapSideDto, currency: ReportingCurrency): RecapFact[] {
  const eur = currency === "EUR";
  const money = (v: string | null, signed = false) => (
    <Money amount={toNum(v)} currency={currency} digits={0} signed={signed} colored={signed} />
  );
  const income = (toNum(side.dividends) ?? 0) + (toNum(side.interest) ?? 0);
  const value = toNum(side.closing_value);
  const facts: RecapFact[] = [
    {
      key: "return",
      label: eur ? "Return in euros" : "Return",
      value: <Percent ratio={toNum(side.nominal_return)} signed colored />,
      note: value !== null ? <>Value {money(side.closing_value)}</> : undefined,
    },
  ];
  if (eur) {
    const real = toNum(side.real_return);
    facts.push({
      key: "real",
      label: "Real return",
      value: real !== null ? <Percent ratio={real} signed colored /> : <span className="recap-card__none">–</span>,
      note: side.real_to ? `After prices to ${formatMonth(side.real_to, "short")}` : "Prices not published yet",
    });
  }
  facts.push({ key: "contributed", label: "Contributed", value: money(side.contributed) });
  const cashedOut = toNum(side.cashed_out);
  if (cashedOut) facts.push({ key: "cashed-out", label: "Cashed out", value: money(side.cashed_out) });
  facts.push({
    key: "market",
    label: "Market",
    value: money(side.market, true),
    note: income ? (
      <>
        incl. <Money amount={income} currency={currency} digits={0} /> dividends
      </>
    ) : undefined,
  });
  if (eur && toNum(side.currency) !== null) {
    facts.push({ key: "currency", label: "Currency", value: money(side.currency, true) });
  }
  const cost = toNum(side.conversion_cost);
  if (eur && cost !== null && side.conversions > 0) {
    facts.push({
      key: "cost",
      label: "Conversion cost",
      value: <Money amount={-cost} currency={currency} digits={2} signed colored />,
      note: side.conversions === 1 ? "1 conversion" : `${side.conversions} conversions`,
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
  const facts = recapFacts(r[currency], currency);
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
      <dl className="recap-card__facts">
        {facts.map((f, i) => (
          <div key={f.key} className={i === 0 ? "recap-card__fact recap-card__fact--lead" : "recap-card__fact"} data-testid={`recap-${f.key}`}>
            <dt className="recap-card__label">{f.label}</dt>
            <dd className="recap-card__value">{f.value}</dd>
            {f.note && <dd className="recap-card__note">{f.note}</dd>}
          </div>
        ))}
      </dl>
    </section>
  );
}
