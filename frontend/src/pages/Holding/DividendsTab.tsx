import clsx from "clsx";
import { Inbox } from "lucide-react";
import { Fragment, useMemo } from "react";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { Money } from "../../components/Money";
import { Percent } from "../../components/Percent";
import { Skeleton } from "../../components/Skeleton";
import { StatStrip } from "../../components/StatStrip";
import { formatDate, formatMoney } from "../../lib/format";
import type { ReportingCurrency } from "../../lib/prefs";
import type { DividendRowDto, DividendsDto } from "../../lib/queries/activity";
import type { DividendHoldingExtra } from "../../lib/queries/holding-detail";
import type { HoldingRowDto } from "../../lib/queries/holdings";
import type { TransactionOut } from "../../lib/queries/ledger";
import { toNum } from "../../lib/queries/portfolio";
import { formatPrice, formatQuantity } from "../Transactions/numbers";
import { kindLook } from "./holdingFormat";
import { KindTag, TwoLineRow, YearLine } from "./TwoLineRow";

type Totals = DividendsDto["by_holding"][number] & DividendHoldingExtra;

/** One bar per year (the current one dashed, "ytd"); heights share the largest year's scale. */
export function DividendBars({ years, ccy, currentYear }: { years: { year: number; amount: string }[]; ccy: string; currentYear: number }) {
  const list = [...years].sort((a, b) => a.year - b.year);
  const max = Math.max(0, ...list.map((y) => toNum(y.amount) ?? 0));
  if (list.length === 0 || max <= 0) return null;
  return (
    <figure className="holding-page__bars" aria-label="Dividends per year">
      <ul className="holding-page__bars-plot">
        {list.map((y) => {
          const v = toNum(y.amount) ?? 0;
          const ytd = y.year === currentYear;
          return (
            <li key={y.year} className="holding-page__bar-slot">
              <span className="holding-page__bar-value">{formatMoney(v, ccy, { compact: true })}</span>
              <span
                className={clsx("holding-page__bar", ytd && "holding-page__bar--ytd")}
                style={{ height: `${Math.max(4, (v / max) * 100)}%` }}
                aria-hidden
              />
              <span className="holding-page__bar-label">
                {y.year}
                {ytd && <span className="holding-page__muted"> ytd</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

function rowMeta(d: DividendRowDto, tx: TransactionOut | undefined): string {
  if (d.kind === "reinvest") {
    const q = tx?.quantity;
    return `Reinvested · ${q ? `${formatQuantity(q)} sh` : d.account}`;
  }
  return `${d.kind === "interest" ? "Interest" : "Cash"} · ${d.account}`;
}

function perShare(d: DividendRowDto, tx: TransactionOut | undefined): string {
  if (!tx?.price_native) return "";
  return d.kind === "reinvest"
    ? `@ ${formatPrice(tx.price_native, tx.currency)}`
    : `${formatPrice(tx.price_native, tx.currency)} / sh`;
}

export function DividendsTab({
  row,
  ccy,
  data,
  pending,
  error,
  onRetry,
  txns,
}: {
  row: HoldingRowDto;
  ccy: ReportingCurrency;
  data: DividendsDto | undefined;
  pending: boolean;
  error: boolean;
  onRetry: () => void;
  /** This holding's transactions: they carry the shares and the per-share amount. */
  txns: TransactionOut[];
}) {
  const rows = useMemo(
    () => (data?.rows ?? []).filter((d) => d.symbol === row.symbol).sort((a, b) => b.date.localeCompare(a.date)),
    [data, row.symbol],
  );
  const totals = ((data?.by_holding ?? []).find((h) => h.symbol === row.symbol) ?? null) as Totals | null;
  const txById = useMemo(() => new Map(txns.map((t) => [t.id, t])), [txns]);
  const years = useMemo(() => {
    const out = new Map<string, DividendRowDto[]>();
    for (const r of rows) out.set(r.date.slice(0, 4), [...(out.get(r.date.slice(0, 4)) ?? []), r]);
    return [...out];
  }, [rows]);
  const asOfYear = Number((data?.as_of ?? rows[0]?.date ?? "").slice(0, 4));
  const yearTotal = (y: string) => totals?.by_year?.find((b) => String(b.year) === y)?.amount ?? null;

  if (error) return <ErrorState message="Could not load the dividends." onRetry={onRetry} />;
  if (pending) return <Skeleton height="10rem" />;
  if (rows.length === 0) return <EmptyState icon={<Inbox aria-hidden />} title={`No dividends from ${row.symbol} yet.`} />;

  return (
    <div className="holding-page__panel">
      <StatStrip
        label={`Dividends from ${row.symbol}`}
        items={[
          { key: "life", label: "Lifetime", value: <Money amount={toNum(totals?.lifetime ?? null)} currency={ccy} /> },
          {
            key: "ttm",
            label: "Last 12 months",
            value: <Money amount={toNum(totals?.last_12m ?? totals?.ttm ?? null)} currency={ccy} />,
          },
          {
            key: "yield",
            label: "Yield (TTM)",
            value: <Percent ratio={toNum(totals?.yield_ttm ?? null)} digits={2} />,
            tip: "The last 12 months' dividends from this holding as a share of its value today.",
          },
        ]}
      />
      {totals?.by_year && <DividendBars years={totals.by_year} ccy={ccy} currentYear={asOfYear} />}
      <ul className="holding-page__rows" aria-label={`Dividends from ${row.symbol}`}>
        {years.map(([year, list]) => {
          const total = yearTotal(year);
          return (
            <Fragment key={year}>
              <YearLine year={year} summary={total !== null ? <Money amount={toNum(total)} currency={ccy} /> : undefined} />
              {list.map((d) => {
                const tx = d.id !== null ? txById.get(d.id) : undefined;
                // Line 1 says what it is; line 2 says how it was paid (cash or reinvested).
                const k = kindLook("dividend_cash");
                return (
                  <TwoLineRow
                    key={d.id ?? `${d.date}-${d.amount}`}
                    lead={<KindTag icon={k.icon} label={d.kind === "interest" ? "Interest" : k.label} />}
                    amount={<Money amount={toNum(d.amount)} currency={ccy} />}
                    meta={`${formatDate(d.date)} · ${rowMeta(d, tx)}`}
                    detail={perShare(d, tx)}
                  />
                );
              })}
            </Fragment>
          );
        })}
      </ul>
    </div>
  );
}
