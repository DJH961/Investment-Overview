import { ChevronDown } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { FOLD_KEY_PREFIX } from "../../components/Card";
import { Money } from "../../components/Money";
import { Percent } from "../../components/Percent";
import { formatMonth } from "../../lib/format";
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

/** Net flow only adds something when money also went out (it equals "In" otherwise). */
function flowDiffers(row: PeriodRowOut): boolean {
  return toNum(row.net_flow) !== toNum(row.contributions);
}

type PeriodRowWithCashOut = PeriodRowOut & { cashed_out_eur?: string | null; cashed_out?: string | null };

/** One labelled figure in a muted text line; null when the amount is zero or missing. */
function part(label: string, value: string | null, currency: ReportingCurrency, kind: "money" | "pct"): ReactNode {
  const n = toNum(value);
  if (n === null || n === 0) return null;
  return (
    <span className="period-part">
      <span className="period-part__label">{label}</span>{" "}
      {kind === "pct" ? <Percent ratio={n} signed colored /> : <Money amount={n} currency={currency} digits={0} />}
    </span>
  );
}

function cashOutPart(row: PeriodRowWithCashOut, currency: ReportingCurrency): ReactNode {
  const v = toNum(row.cashed_out);
  if (v !== null && v > 0) return part("Cashed out", row.cashed_out ?? null, currency, "money");
  const eur = toNum(row.cashed_out_eur);
  if (eur !== null && eur > 0) return part("Cashed out", row.cashed_out_eur ?? null, "EUR", "money");
  return null;
}

/** Muted text line: the non-empty parts joined by a middle dot. */
function Line({ parts }: { parts: ReactNode[] }) {
  const shown = parts.filter((p) => p !== null);
  if (shown.length === 0) return null;
  return (
    <span className="period-line">
      {shown.map((p, i) => (
        // oxlint-disable-next-line react/no-array-index-key
        <Fragment key={i}>
          {i > 0 && <span aria-hidden> · </span>}
          {p}
        </Fragment>
      ))}
    </span>
  );
}

function secondPart(other: PeriodRowOut | undefined, currency: ReportingCurrency): ReactNode {
  const o = toNum(other?.closing_value);
  if (o === null) return null;
  return (
    <span className="period-part">
      <Money amount={o} currency={otherCcy(currency)} digits={0} />
    </span>
  );
}

function MonthRow({ row, currency, other }: { row: PeriodRowOut; currency: ReportingCurrency; other?: PeriodRowOut }) {
  return (
    <li className="period-month" data-period={row.label}>
      <div className="period-month__top">
        <span className="period-month__name">
          {monthName(row.label)}
          {row.is_current && <span className="period-month__pill">live</span>}
        </span>
        <span className="period-month__value">
          <Maybe present={toNum(row.closing_value) !== null} ccy={currency}>
            <Money amount={toNum(row.closing_value)} currency={currency} digits={0} />
          </Maybe>
        </span>
        <span className="period-month__growth">
          <Maybe present={toNum(row.growth_pct) !== null} ccy={currency}>
            <Percent ratio={toNum(row.growth_pct)} signed colored />
          </Maybe>
        </span>
      </div>
      <Line
        parts={[
          secondPart(other, currency),
          part("Total", row.total_growth_compounded, currency, "pct"),
          part("In", row.contributions, currency, "money"),
          flowDiffers(row) ? part("Net flow", row.net_flow, currency, "money") : null,
          cashOutPart(row, currency),
          part("Div.", row.dividends, currency, "money"),
        ]}
      />
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
  const s = group.summary;
  const lastMonth = group.months[0];
  const total = toNum(s?.closing_value ?? lastMonth?.closing_value ?? null);
  const other = s ? yearOther.get(s.label) : undefined;
  return (
    <section className={`period-year${open ? " period-year--open" : ""}`} data-year={group.year}>
      <button
        type="button"
        className="period-year__head"
        aria-expanded={open}
        aria-label={`${group.year}${open ? ", fold" : ", unfold"}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="period-year__top">
          <span className="period-year__title">
            <ChevronDown className="period-year__chevron" aria-hidden />
            {group.year}
            {group.isCurrent && <span className="period-year__pill">current</span>}
          </span>
          <span className="period-year__total">
            <span className="period-year__total-label">{s?.is_current || group.isCurrent ? "Now" : "Year end"}</span>
            <Money amount={total} currency={currency} digits={0} />
          </span>
        </span>
        {s && (
          <>
            <Line
              parts={[
                secondPart(other, currency),
                <span className="period-part" key="twr">
                  <span className="period-part__label">Growth (TWR)</span>{" "}
                  <Maybe present={toNum(s.growth_pct) !== null} ccy={currency}>
                    <Percent ratio={toNum(s.growth_pct)} signed colored />
                  </Maybe>
                </span>,
                <span className="period-part" key="xirr">
                  <span className="period-part__label">XIRR</span>{" "}
                  <Maybe present={toNum(s.period_growth_xirr) !== null} ccy={currency}>
                    <Percent ratio={toNum(s.period_growth_xirr)} signed colored />
                  </Maybe>
                </span>,
              ]}
            />
            <Line
              parts={[
                part("In", s.contributions, currency, "money"),
                flowDiffers(s) ? part("Net flow", s.net_flow, currency, "money") : null,
                cashOutPart(s, currency),
                part("Div.", s.dividends, currency, "money"),
              ]}
            />
          </>
        )}
      </button>
      {open && (
        <ul className="period-year__months" aria-label={`${group.year} months`}>
          {group.months.map((m) => (
            <MonthRow key={m.label} row={m} currency={currency} other={monthsOther.get(m.label)} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Phone "By year" view: compact year blocks with their months, server figures only. */
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
