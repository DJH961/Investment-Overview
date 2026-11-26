import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { FOLD_KEY_PREFIX } from "../../components/Card";
import { Money } from "../../components/Money";
import { Percent } from "../../components/Percent";
import { formatMonth, MISSING } from "../../lib/format";
import type { ReportingCurrency } from "../../lib/prefs";
import { type PeriodRowOut, toNum } from "../../lib/queries/reports";
import { usePersistentState } from "../../lib/usePersistentState";
import type { YearGroup } from "./groupByYear";
import { Maybe } from "./Maybe";

const otherCcy = (c: ReportingCurrency): ReportingCurrency => (c === "EUR" ? "USD" : "EUR");

/** "2026-10" -> "October"; the year is the group's heading. */
function monthName(label: string): string {
  return formatMonth(label, "month-only");
}

type PeriodRowWithCashOut = PeriodRowOut & { cashed_out_eur?: string | null; cashed_out?: string | null };

function money(v: string | null, currency: ReportingCurrency) {
  const n = toNum(v);
  return n === null ? MISSING : <Money amount={n} currency={currency} digits={0} />;
}

function cashedOut(row: PeriodRowOut, currency: ReportingCurrency) {
  const r = row as PeriodRowWithCashOut;
  const v = toNum(r.cashed_out);
  if (v !== null && v > 0) return <Money amount={v} currency={currency} digits={0} />;
  const eur = toNum(r.cashed_out_eur);
  if (eur !== null && eur > 0) return <Money amount={eur} currency="EUR" digits={0} />;
  return MISSING;
}

/** Label above value: In, Net flow, Cashed out, Dividends (a dash when empty). */
function Flows({ row, currency, modifier }: { row: PeriodRowOut; currency: ReportingCurrency; modifier: "year" | "month" }) {
  const cell = (label: string, value: React.ReactNode) => (
    <div className="period-flow">
      <dt className="period-flow__label">{label}</dt>
      <dd className="period-flow__value">{value}</dd>
    </div>
  );
  return (
    <dl className={`period-flows period-flows--${modifier}`}>
      {cell("In", money(row.contributions, currency))}
      {cell("Net flow", money(row.net_flow, currency))}
      {cell("Cashed out", cashedOut(row, currency))}
      {cell("Dividends", money(row.dividends, currency))}
    </dl>
  );
}

function MonthRow({
  row,
  currency,
  other,
  open,
  onToggle,
}: {
  row: PeriodRowOut;
  currency: ReportingCurrency;
  other?: PeriodRowOut;
  open: boolean;
  onToggle: () => void;
}) {
  const second = toNum(other?.closing_value);
  const g = toNum(row.growth_pct);
  const tone = g === null ? "flat" : g > 0 ? "pos" : g < 0 ? "neg" : "flat";
  const total = toNum(row.total_growth_compounded);
  return (
    <li className={`period-month${open ? " period-month--open" : ""}`} data-period={row.label}>
      <button type="button" className="period-month__row" aria-expanded={open} onClick={onToggle}>
        <span className="period-month__name">
          <ChevronDown className="period-month__chevron" aria-hidden />
          {monthName(row.label)}
          {row.is_current && <span className="period-month__pill">live</span>}
        </span>
        <span className="period-month__value">
          <Maybe present={toNum(row.closing_value) !== null} ccy={currency}>
            <Money amount={toNum(row.closing_value)} currency={currency} digits={0} />
          </Maybe>
        </span>
        <span className={`period-month__growth period-month__growth--${tone}`}>
          <Maybe present={g !== null} ccy={currency}>
            <Percent ratio={g} signed colored />
          </Maybe>
        </span>
        <span className="period-month__sub">
          {second !== null && <Money amount={second} currency={otherCcy(currency)} digits={0} />}
        </span>
        <span className="period-month__sub">
          {total !== null && (
            <>
              Total <Percent ratio={total} signed colored />
            </>
          )}
        </span>
      </button>
      {open && <Flows row={row} currency={currency} modifier="month" />}
    </li>
  );
}

function PhoneYear({
  group,
  currency,
  monthsOther,
  yearOther,
}: {
  group: YearGroup;
  currency: ReportingCurrency;
  monthsOther: Map<string, PeriodRowOut>;
  yearOther: Map<string, PeriodRowOut>;
}) {
  // Shares the fold memory with the desktop table.
  const [open, setOpen] = usePersistentState<boolean>(`${FOLD_KEY_PREFIX}periods.year.${group.year}`, group.isCurrent);
  const [openMonth, setOpenMonth] = useState<string | null>(null);
  const s = group.summary;
  const lastMonth = group.months[0];
  const total = toNum(s?.closing_value ?? lastMonth?.closing_value ?? null);
  const second = toNum(s ? yearOther.get(s.label)?.closing_value : null);
  const pct = (v: string | null) => (
    <Maybe present={toNum(v) !== null} ccy={currency}>
      <Percent ratio={toNum(v)} signed colored />
    </Maybe>
  );
  return (
    <section className={`period-year${open ? " period-year--open" : ""}`} data-year={group.year}>
      <button
        type="button"
        className="period-year__head"
        aria-expanded={open}
        aria-label={`${group.year}${open ? ", fold" : ", unfold"}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="period-year__title">
          <ChevronDown className="period-year__chevron" aria-hidden />
          {group.year}
          {group.isCurrent && <span className="period-year__pill">current</span>}
        </span>
        <span className="period-year__total">
          <span className="period-year__label">{s?.is_current || group.isCurrent ? "Now" : "Year end"}</span>
          <span className="period-year__amount">
            <Money amount={total} currency={currency} digits={0} />
          </span>
          {second !== null && (
            <span className="period-year__second">
              <Money amount={second} currency={otherCcy(currency)} digits={0} />
            </span>
          )}
        </span>
        {s && (
          <span className="period-year__heroes">
            <span className="period-year__hero">
              <span className="period-year__label">Growth (TWR)</span>
              <span className="period-year__hero-value">{pct(s.growth_pct)}</span>
            </span>
            <span className="period-year__hero">
              <span className="period-year__label">XIRR</span>
              <span className="period-year__hero-value">{pct(s.period_growth_xirr)}</span>
            </span>
          </span>
        )}
      </button>
      {open && s && <Flows row={s} currency={currency} modifier="year" />}
      {open && (
        <ul className="period-year__months" aria-label={`${group.year} months`}>
          {group.months.map((m) => (
            <MonthRow
              key={m.label}
              row={m}
              currency={currency}
              other={monthsOther.get(m.label)}
              open={openMonth === m.label}
              onToggle={() => setOpenMonth((cur) => (cur === m.label ? null : m.label))}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Phone "By year": native-list style year cards with their months, server figures only. */
export function PhoneYears({
  groups,
  currency,
  monthsOther,
  yearOther,
}: {
  groups: YearGroup[];
  currency: ReportingCurrency;
  monthsOther: Map<string, PeriodRowOut>;
  yearOther: Map<string, PeriodRowOut>;
}) {
  return (
    <div className="period-years">
      {groups.map((g) => (
        <PhoneYear key={g.year} group={g} currency={currency} monthsOther={monthsOther} yearOther={yearOther} />
      ))}
    </div>
  );
}
