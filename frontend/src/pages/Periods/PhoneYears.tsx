import { ChevronDown } from "lucide-react";
import { FOLD_KEY_PREFIX } from "../../components/Card";
import { Money } from "../../components/Money";
import { Percent } from "../../components/Percent";
import type { ReportingCurrency } from "../../lib/prefs";
import { type PeriodRowOut, toNum } from "../../lib/queries/reports";
import { usePersistentState } from "../../lib/usePersistentState";
import type { YearGroup } from "./groupByYear";
import { Maybe } from "./Maybe";

const otherCcy = (c: ReportingCurrency): ReportingCurrency => (c === "EUR" ? "USD" : "EUR");

/** "2026-10" -> "October"; the year is the group's heading. */
function monthName(label: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(label);
  if (!m) return label;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)).toLocaleDateString("en-GB", {
    month: "long",
    timeZone: "UTC",
  });
}

/** Net flow only adds something when money also went out (it equals "In" otherwise). */
function flowDiffers(row: PeriodRowOut): boolean {
  return toNum(row.net_flow) !== toNum(row.contributions);
}

/** Small labelled figure; left out entirely when the amount is zero or missing. */
function Chip({ label, value, currency, pct }: { label: string; value: string | null; currency: ReportingCurrency; pct?: boolean }) {
  const n = toNum(value);
  if (n === null || n === 0) return null;
  return (
    <span className="period-chip">
      <span className="period-chip__label">{label}</span>
      <span className="period-chip__value">
        {pct ? <Percent ratio={n} signed colored /> : <Money amount={n} currency={currency} />}
      </span>
    </span>
  );
}

function Growth({ label, value, currency }: { label: string; value: string | null; currency: ReportingCurrency }) {
  return (
    <span className="period-year__growth">
      <span className="period-year__growth-label">{label}</span>
      <span className="period-year__growth-value">
        <Maybe present={toNum(value) !== null} ccy={currency}>
          <Percent ratio={toNum(value)} signed colored />
        </Maybe>
      </span>
    </span>
  );
}

function MonthRow({ row, currency, other }: { row: PeriodRowOut; currency: ReportingCurrency; other?: PeriodRowOut }) {
  const second = toNum(other?.closing_value);
  return (
    <li className="period-month" data-period={row.label}>
      <div className="period-month__top">
        <span className="period-month__name">
          {monthName(row.label)}
          {row.is_current && <span className="period-month__pill">live</span>}
        </span>
        {/* The month's growth, as before (the owner likes this one as it is). */}
        <span className="period-month__growth">
          <Maybe present={toNum(row.growth_pct) !== null} ccy={currency}>
            <Percent ratio={toNum(row.growth_pct)} signed colored />
          </Maybe>
        </span>
      </div>
      <div className="period-month__value">
        <Maybe present={toNum(row.closing_value) !== null} ccy={currency}>
          <Money amount={toNum(row.closing_value)} currency={currency} />
        </Maybe>
        {second !== null && (
          <span className="period-month__second">
            <Money amount={second} currency={otherCcy(currency)} />
          </span>
        )}
      </div>
      <div className="period-month__chips">
        <Chip label="Total" value={row.total_growth_compounded} currency={currency} pct />
        <Chip label="In" value={row.contributions} currency={currency} />
        {flowDiffers(row) && <Chip label="Net flow" value={row.net_flow} currency={currency} />}
        <Chip label="Div." value={row.dividends} currency={currency} />
      </div>
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
  // Shares the fold memory with the desktop year cards.
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
            <span className="period-year__growths">
              <Growth label="Growth (TWR)" value={s.growth_pct} currency={currency} />
              <Growth label="XIRR" value={s.period_growth_xirr} currency={currency} />
            </span>
            <span className="period-year__chips">
              <Chip label="In" value={s.contributions} currency={currency} />
              {flowDiffers(s) && <Chip label="Net flow" value={s.net_flow} currency={currency} />}
              <Chip label="Div." value={s.dividends} currency={currency} />
              {toNum(other?.closing_value) !== null && (
                <span className="period-chip period-chip--muted">
                  <Money amount={toNum(other?.closing_value)} currency={otherCcy(currency)} digits={0} />
                </span>
              )}
            </span>
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
