import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { FOLD_KEY_PREFIX } from "../../components/Card";
import { Money } from "../../components/Money";
import { Percent } from "../../components/Percent";
import { formatMoney, formatMonth, MISSING } from "../../lib/format";
import type { ReportingCurrency } from "../../lib/prefs";
import { type PeriodRowOut, toNum } from "../../lib/queries/reports";
import { useIsDesktop } from "../../lib/useMediaQuery";
import { usePersistentState } from "../../lib/usePersistentState";
import type { YearGroup } from "./groupByYear";
import "./YearsTable.scss";

const otherCcy = (c: ReportingCurrency): ReportingCurrency => (c === "EUR" ? "USD" : "EUR");

type RowWithCashOut = PeriodRowOut & { cashed_out_eur?: string | null; cashed_out?: string | null };

interface Props {
  groups: YearGroup[];
  currency: ReportingCurrency;
  monthsOther: Map<string, PeriodRowOut>;
  yearOther: Map<string, PeriodRowOut>;
}

function CashedOut({ row, currency, digits }: { row: PeriodRowOut; currency: ReportingCurrency; digits?: number }) {
  const r = row as RowWithCashOut;
  const v = toNum(r.cashed_out);
  if (v !== null && v > 0) return <Money amount={v} currency={currency} digits={digits} />;
  const eur = toNum(r.cashed_out_eur);
  if (eur !== null && eur > 0) return <Money amount={eur} currency="EUR" digits={digits} />;
  return <>{MISSING}</>;
}

function Cell({ children }: { children: ReactNode }) {
  return <td className="years-table__td">{children}</td>;
}

function amount(v: string | null, currency: ReportingCurrency, digits?: number) {
  const n = toNum(v);
  return n === null ? MISSING : <Money amount={n} currency={currency} digits={digits} />;
}

function pct(v: string | null) {
  const n = toNum(v);
  return n === null ? MISSING : <Percent ratio={n} signed colored />;
}

/** The value, with the same value in the other currency small and muted right after it. */
function Value({
  v,
  other,
  currency,
  digits,
}: {
  v: string | null;
  other: PeriodRowOut | undefined;
  currency: ReportingCurrency;
  digits?: number;
}) {
  const o = toNum(other?.closing_value);
  const second = otherCcy(currency);
  return (
    <td className="years-table__td years-table__td--value" title={o !== null ? formatMoney(o, second, { digits }) : undefined}>
      {amount(v, currency, digits)}
      {o !== null && (
        <span className="years-table__second">
          <Money amount={o} currency={second} digits={digits} />
        </span>
      )}
    </td>
  );
}

function YearBody({ group, currency, monthsOther, yearOther }: { group: YearGroup } & Omit<Props, "groups">) {
  // Cents on wide screens only: the eight columns must fit a tablet without scrolling.
  const md = useIsDesktop() ? undefined : 0;
  const [open, setOpen] = usePersistentState<boolean>(`${FOLD_KEY_PREFIX}periods.year.${group.year}`, group.isCurrent);
  const s = group.summary;
  const lastMonth = group.months[0];
  const closing = s?.closing_value ?? lastMonth?.closing_value ?? null;
  return (
    <tbody className={`years-table__year${open ? " years-table__year--open" : ""}`} data-year={group.year}>
      <tr className="years-table__row years-table__row--year">
        <th scope="row" className="years-table__th years-table__th--year">
          <button
            type="button"
            className="years-table__toggle"
            aria-expanded={open}
            aria-label={`${group.year}${open ? ", fold" : ", unfold"}`}
            onClick={() => setOpen((o) => !o)}
          >
            <ChevronDown className="years-table__chevron" aria-hidden />
            <span className="years-table__year-title">{group.year}</span>
            {group.isCurrent && <span className="years-table__tag">current</span>}
          </button>
        </th>
        <Value v={closing} other={s ? yearOther.get(s.label) : undefined} currency={currency} digits={0} />
        <Cell>{s ? pct(s.growth_pct) : MISSING}</Cell>
        <Cell>
          {s ? (
            <>
              <span className="years-table__mini">XIRR</span> {pct(s.period_growth_xirr)}
            </>
          ) : (
            MISSING
          )}
        </Cell>
        <Cell>{s ? amount(s.net_flow, currency, 0) : MISSING}</Cell>
        <Cell>{s ? amount(s.contributions, currency, 0) : MISSING}</Cell>
        <Cell>{s ? <CashedOut row={s} currency={currency} digits={0} /> : MISSING}</Cell>
        <Cell>{s ? amount(s.dividends, currency, 0) : MISSING}</Cell>
      </tr>
      {open &&
        group.months.map((m) => (
          <tr key={m.label} className="years-table__row years-table__row--month" data-period={m.label}>
            <th scope="row" className="years-table__th years-table__th--month">
              {formatMonth(m.label, "short")}
              {m.is_current && <span className="years-table__tag"> live</span>}
            </th>
            <Value v={m.closing_value} other={monthsOther.get(m.label)} currency={currency} digits={md} />
            <Cell>{pct(m.growth_pct)}</Cell>
            <Cell>{pct(m.total_growth_compounded)}</Cell>
            <Cell>{amount(m.net_flow, currency, md)}</Cell>
            <Cell>{amount(m.contributions, currency, md)}</Cell>
            <Cell>
              <CashedOut row={m} currency={currency} digits={md} />
            </Cell>
            <Cell>{amount(m.dividends, currency, md)}</Cell>
          </tr>
        ))}
    </tbody>
  );
}

/** Tablet/desktop "By year": one dense table, each year a tinted header row over its months. */
export function YearsTable({ groups, currency, monthsOther, yearOther }: Props) {
  return (
    <div className="years-table__wrap">
      <table className="years-table">
        <caption className="u-sr-only">Periods by year</caption>
        <thead>
          <tr>
            <th scope="col" className="years-table__col years-table__col--left">
              Period
            </th>
            <th scope="col" className="years-table__col">
              Value
            </th>
            <th scope="col" className="years-table__col">
              Growth
            </th>
            <th scope="col" className="years-table__col">
              Total growth / XIRR
            </th>
            <th scope="col" className="years-table__col">
              Net flow
            </th>
            <th scope="col" className="years-table__col">
              Contributions
            </th>
            <th scope="col" className="years-table__col">
              Cashed out
            </th>
            <th scope="col" className="years-table__col">
              Dividends
            </th>
          </tr>
        </thead>
        {groups.map((g) => (
          <YearBody key={g.year} group={g} currency={currency} monthsOther={monthsOther} yearOther={yearOther} />
        ))}
      </table>
    </div>
  );
}
