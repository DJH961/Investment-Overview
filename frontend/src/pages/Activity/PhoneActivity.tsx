import { ChevronDown } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Money } from "../../components/Money";
import { formatMonth } from "../../lib/format";
import type { ReportingCurrency } from "../../lib/prefs";
import { toNum } from "../../lib/queries/portfolio";
import "./PhoneActivity.scss";

export interface PhoneActivityItem {
  key: string;
  /** ISO date; its month decides the group. */
  date: string;
  /** Line 1 left: what happened. */
  title: ReactNode;
  /** Line 2 left, muted. */
  sub: ReactNode;
  amount: string | null;
  amountOther: string | null | undefined;
  /** Far right: short label and one muted line under it. */
  pill: string;
  pillSub?: string;
  /** Disclosed on tap, label above value. */
  details: { label: string; value: ReactNode }[];
}

const otherCcy = (c: ReportingCurrency): ReportingCurrency => (c === "EUR" ? "USD" : "EUR");

function sum(items: PhoneActivityItem[], pick: (i: PhoneActivityItem) => string | null | undefined): number | null {
  let total = 0;
  let any = false;
  for (const i of items) {
    const n = toNum(pick(i));
    if (n !== null) {
      total += n;
      any = true;
    }
  }
  return any ? total : null;
}

function Row({
  item,
  currency,
  open,
  onToggle,
}: {
  item: PhoneActivityItem;
  currency: ReportingCurrency;
  open: boolean;
  onToggle: () => void;
}) {
  const main = toNum(item.amount);
  const second = toNum(item.amountOther);
  return (
    <li className={`phone-act-row${open ? " phone-act-row--open" : ""}`}>
      <button type="button" className="phone-act-row__btn" aria-expanded={open} onClick={onToggle}>
        <ChevronDown className="phone-act-row__chevron" aria-hidden />
        <span className="phone-act-row__title">{item.title}</span>
        <span className="phone-act-row__main">{main !== null && <Money amount={main} currency={currency} />}</span>
        <span className="phone-act-row__pill">{item.pill}</span>
        <span className="phone-act-row__sub" data-truncate-ok title={typeof item.sub === "string" ? item.sub : undefined}>{item.sub}</span>
        <span className="phone-act-row__second">
          {second !== null && <Money amount={second} currency={otherCcy(currency)} />}
        </span>
        <span className="phone-act-row__pillsub">{item.pillSub}</span>
      </button>
      {open && (
        <dl className="phone-act-row__details">
          {item.details.map((d) => (
            <div className="phone-act-row__detail" key={d.label}>
              <dt className="phone-act-row__label">{d.label}</dt>
              <dd className="phone-act-row__value">{d.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

/** Phone list: month groups (total right), 2-line aligned rows, tap to disclose the rest. */
export function PhoneActivityList({
  items,
  currency,
  totalLabel,
  groupBy = "month",
  totals,
}: {
  items: PhoneActivityItem[];
  currency: ReportingCurrency;
  totalLabel: string;
  groupBy?: "month" | "year";
  /** Server-computed group totals (key: year or month); falls back to summing the rows. */
  totals?: Record<string, { amount: string | null; other: string | null | undefined }>;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  // Newest group open, the others folded (tap the header).
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const groups = new Map<string, PhoneActivityItem[]>();
  for (const i of items) {
    const m = i.date.slice(0, groupBy === "year" ? 4 : 7);
    groups.set(m, [...(groups.get(m) ?? []), i]);
  }
  return (
    <div className="phone-act">
      {[...groups.entries()].map(([month, rows], gi) => {
        const total = totals?.[month] ? toNum(totals[month].amount) : sum(rows, (r) => r.amount);
        const second = totals?.[month] ? toNum(totals[month].other) : sum(rows, (r) => r.amountOther);
        const label = groupBy === "year" ? month : formatMonth(month, "long");
        const groupOpen = (gi === 0) !== toggled.has(month);
        return (
          <section className="phone-act__group" key={month} data-month={month}>
            <button
              type="button"
              className="phone-act__head"
              aria-expanded={groupOpen}
              onClick={() =>
                setToggled((t) => {
                  const n = new Set(t);
                  if (n.has(month)) n.delete(month);
                  else n.add(month);
                  return n;
                })
              }
            >
              <span className="phone-act__month">
                <ChevronDown
                  className={`phone-act__chevron${groupOpen ? "" : " phone-act__chevron--folded"}`}
                  aria-hidden
                />
                {label}
              </span>
              <span className="phone-act__total">
                <span className="phone-act__total-label">{totalLabel}</span>
                {total !== null && (
                  <span className="phone-act__total-amount">
                    <Money amount={total} currency={currency} />
                  </span>
                )}
                {second !== null && (
                  <span className="phone-act__total-second">
                    <Money amount={second} currency={otherCcy(currency)} />
                  </span>
                )}
              </span>
            </button>
            {groupOpen && (
              <ul className="phone-act__rows" aria-label={label}>
                {rows.map((r) => (
                  <Row
                    key={r.key}
                    item={r}
                    currency={currency}
                    open={openKey === r.key}
                    onToggle={() => setOpenKey((k) => (k === r.key ? null : r.key))}
                  />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
