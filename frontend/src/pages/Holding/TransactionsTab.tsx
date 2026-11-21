import clsx from "clsx";
import { ArrowRight, Inbox } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router";
import { Dialog } from "../../components/Dialog";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { Money } from "../../components/Money";
import { Sheet } from "../../components/Sheet";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { formatDate, formatMoney } from "../../lib/format";
import { useAccounts } from "../../lib/queries/accounts";
import type { HoldingRowDto } from "../../lib/queries/holdings";
import { type TransactionOut, type TransactionWrite, useUpdateTransaction } from "../../lib/queries/ledger";
import { useIsPhone } from "../../lib/useMediaQuery";
import { TransactionForm } from "../Transactions/TransactionForm";
import { formatPrice, formatQuantity, num } from "../Transactions/numbers";
import { kindLook } from "./holdingFormat";
import { KindTag, TwoLineRow, YearLine } from "./TwoLineRow";

export const isDividend = (k: string): boolean => k === "dividend_cash" || k === "dividend_reinvest";

export type TxFilter = "all" | "buys" | "sells" | "dividends";

const MATCH: Record<TxFilter, (k: string) => boolean> = {
  all: () => true,
  buys: (k) => k === "buy",
  sells: (k) => k === "sell",
  dividends: (k) => isDividend(k),
};

const LABEL: Record<TxFilter, string> = { all: "All", buys: "Buys", sells: "Sells", dividends: "Dividends" };

/** Line 2, right: "50 sh @ $264.65" for trades, "$0.36 / sh" for dividends (server figures as stored). */
export function txDetail(t: TransactionOut): string {
  const q = num(t.quantity);
  const price = num(t.price_native);
  if (t.kind === "dividend_cash") return price === null ? "" : `${formatPrice(t.price_native, t.currency)} / sh`;
  if (q === null) return "";
  const shares = `${formatQuantity(t.quantity?.replace(/^-/, ""))} sh`;
  return price === null ? shares : `${shares} @ ${formatPrice(t.price_native, t.currency)}`;
}

/**
 * The year line's net: what went into the holding that year (buys minus sells, a plain
 * sum of the server's net amounts, per currency). Dividends are not part of it.
 */
export function yearNet(rows: TransactionOut[]): { currency: string; bought: number }[] {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.kind !== "buy" && r.kind !== "sell") continue;
    const n = num(r.net_native);
    if (n === null) continue;
    // Buys are stored as cash out (negative): money put in is its opposite.
    out.set(r.currency, (out.get(r.currency) ?? 0) - n);
  }
  return [...out].map(([currency, bought]) => ({ currency, bought }));
}

function YearSummary({ rows }: { rows: TransactionOut[] }) {
  const nets = yearNet(rows);
  if (nets.length === 0) return null;
  return (
    <>
      {nets.map((n, i) => (
        <span key={n.currency}>
          {i > 0 && " · "}
          {n.bought >= 0 ? "net bought " : "net sold "}
          <Money amount={Math.abs(n.bought)} currency={n.currency} />
        </span>
      ))}
    </>
  );
}

function byYear(rows: TransactionOut[]): [string, TransactionOut[]][] {
  const out = new Map<string, TransactionOut[]>();
  for (const r of rows) {
    const y = r.date.slice(0, 4);
    out.set(y, [...(out.get(y) ?? []), r]);
  }
  return [...out].sort((a, b) => b[0].localeCompare(a[0]));
}

function EditTransaction({ row, onClose }: { row: TransactionOut; onClose: () => void }) {
  const { toast } = useToast();
  const isPhone = useIsPhone();
  const accountList = useAccounts();
  const accounts = useMemo(
    () => (accountList.data ?? []).map((a) => ({ value: String(a.id), label: a.account_label })),
    [accountList.data],
  );
  const update = useUpdateTransaction();
  const save = (body: TransactionWrite) =>
    update.mutate(
      { id: row.id, body },
      {
        onSuccess: (r) => {
          toast({ title: "Updated", description: r.warnings?.join(" "), tone: "success" });
          onClose();
        },
      },
    );
  const form = (
    <TransactionForm
      row={row}
      accounts={accounts}
      busy={update.isPending}
      serverError={update.error}
      onSubmit={save}
      onCancel={onClose}
    />
  );
  return isPhone ? (
    <Sheet open onOpenChange={(o) => !o && onClose()} title="Edit transaction">
      {form}
    </Sheet>
  ) : (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Edit transaction">
      {form}
    </Dialog>
  );
}

export function TransactionsTab({
  row,
  txns,
  pending,
  error,
}: {
  row: HoldingRowDto;
  txns: TransactionOut[];
  pending: boolean;
  error: boolean;
}) {
  const [filter, setFilter] = useState<TxFilter>("all");
  const [editing, setEditing] = useState<TransactionOut | null>(null);
  const isPhone = useIsPhone();
  const counts = useMemo(
    () =>
      Object.fromEntries((Object.keys(MATCH) as TxFilter[]).map((f) => [f, txns.filter((t) => MATCH[f](t.kind)).length])) as Record<
        TxFilter,
        number
      >,
    [txns],
  );
  const shown = useMemo(() => txns.filter((t) => MATCH[filter](t.kind)), [txns, filter]);
  const years = useMemo(() => byYear(shown), [shown]);

  if (error) return <ErrorState message="Could not load the transactions." />;
  if (pending) return <Skeleton height="10rem" />;
  if (txns.length === 0) return <EmptyState icon={<Inbox aria-hidden />} title={`No transactions for ${row.symbol} yet.`} />;

  return (
    <div className="holding-page__panel">
      <fieldset className="holding-page__filters">
        <legend className="holding-page__sr">Show</legend>
        {(Object.keys(MATCH) as TxFilter[]).map((f) => (
          <button
            key={f}
            type="button"
            className={clsx("holding-page__filter", filter === f && "holding-page__filter--on")}
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
          >
            {LABEL[f]} <span className="holding-page__filter-count">{counts[f]}</span>
          </button>
        ))}
      </fieldset>
      {shown.length === 0 ? (
        <p className="holding-page__note">No {LABEL[filter].toLowerCase()} for {row.symbol}.</p>
      ) : isPhone ? (
        <ul className="holding-page__rows" aria-label={`Transactions for ${row.symbol}`}>
          {years.map(([year, rows]) => (
            <Fragment key={year}>
              <YearLine year={year} summary={<YearSummary rows={rows} />} />
              {rows.map((t) => {
                const k = kindLook(t.kind);
                return (
                  <TwoLineRow
                    key={t.id}
                    lead={<KindTag icon={k.icon} label={k.label} />}
                    amount={<Money amount={num(t.net_native)} currency={t.currency} signed />}
                    meta={`${formatDate(t.date)} · ${t.account}`}
                    detail={txDetail(t)}
                    onOpen={() => setEditing(t)}
                    openLabel={`Edit ${k.label.toLowerCase()} of ${formatDate(t.date)}`}
                  />
                );
              })}
            </Fragment>
          ))}
        </ul>
      ) : (
        <div className="holding-page__table-wrap" data-scrollable>
          <table className="holding-page__txs">
            <caption className="holding-page__sr">Transactions for {row.symbol}</caption>
            <thead>
              <tr>
                {["Date", "Kind", "Account", "Shares", "Price", "Fees", "Net"].map((h, i) => (
                  <th key={h} scope="col" className={clsx("holding-page__tx-th", i >= 3 && "holding-page__tx-th--right")}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            {years.map(([year, rows]) => (
              <tbody key={year}>
                <tr className="holding-page__tx-year">
                  <th scope="rowgroup" colSpan={7} className="holding-page__tx-year-cell">
                    <span className="holding-page__year-label">{year}</span>
                    <span className="holding-page__year-summary">
                      <YearSummary rows={rows} />
                    </span>
                  </th>
                </tr>
                {rows.map((t) => {
                  const k = kindLook(t.kind);
                  const fees = num(t.fees_native);
                  return (
                    <tr key={t.id} className="holding-page__tx">
                      <td className="holding-page__tx-td">
                        <button
                          type="button"
                          className="holding-page__tx-open"
                          onClick={() => setEditing(t)}
                          aria-label={`Edit ${k.label.toLowerCase()} of ${formatDate(t.date)}`}
                        >
                          {formatDate(t.date)}
                        </button>
                      </td>
                      <td className="holding-page__tx-td">
                        <KindTag icon={k.icon} label={k.label} />
                      </td>
                      <td className="holding-page__tx-td holding-page__tx-td--account" title={t.account}>
                        {t.account}
                      </td>
                      <td className="holding-page__tx-td holding-page__tx-td--right">
                        {t.quantity == null ? "–" : formatQuantity(t.quantity)}
                      </td>
                      <td className="holding-page__tx-td holding-page__tx-td--right">
                        {t.price_native == null ? "–" : formatPrice(t.price_native, t.currency)}
                      </td>
                      <td className="holding-page__tx-td holding-page__tx-td--right">
                        {fees === null || fees === 0 ? "–" : formatMoney(fees, t.currency)}
                      </td>
                      <td className="holding-page__tx-td holding-page__tx-td--right">
                        <Money amount={num(t.net_native)} currency={t.currency} signed />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </table>
        </div>
      )}
      <Link to="/transactions" className="holding-page__more">
        All transactions <ArrowRight aria-hidden size={14} />
      </Link>
      {editing && <EditTransaction row={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
