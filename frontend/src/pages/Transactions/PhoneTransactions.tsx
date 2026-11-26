import { ChevronDown, Pencil, Tag } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { FOLD_KEY_PREFIX } from "../../components/Card";
import { Money } from "../../components/Money";
import { formatDate, getFormatPrefs, MISSING } from "../../lib/format";
import type { TrailKind } from "../../lib/journey-types";
import type { TransactionOut } from "../../lib/queries/ledger";
import type { LedgerMonth } from "../../lib/queries/ledgerAll";
import type { DepositMatch } from "../../lib/queries/manage";
import { usePersistentState } from "../../lib/usePersistentState";
import { EstChip } from "./EstChip";
import { formatPrice, formatQuantity, num } from "./numbers";
import { RateChip, TrailChip } from "./RateChip";

type Ccy = "EUR" | "USD";

/** "23 Nov": the month header already names the year. */
function shortDate(iso: string): string {
  return new Intl.DateTimeFormat(getFormatPrefs().locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${iso}T00:00:00Z`),
  );
}

/** What the phone list needs from the page (all server figures; nothing is computed here). */
export interface PhoneTransactionsProps {
  rows: TransactionOut[];
  /** Month totals from the server; when set the list is grouped under month headers. */
  months: Map<string, LedgerMonth> | null;
  currency: Ccy;
  depositMap: Map<number, DepositMatch>;
  kindLabel: (kind: string) => string;
  monthLabel: (month: string) => string;
  trailKindOf: (r: TransactionOut) => TrailKind | null;
  onEdit: (r: TransactionOut) => void;
  onOpenRate: (m: DepositMatch) => void;
  onOpenTrail: (kind: TrailKind, id: number) => void;
  onOpenEst: (id: number) => void;
}

type RowProps = Omit<PhoneTransactionsProps, "rows" | "months" | "monthLabel"> & {
  row: TransactionOut;
  open: boolean;
  onToggle: () => void;
};

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="phone-tx-detail__cell">
      <dt className="phone-tx-detail__label">{label}</dt>
      <dd className="phone-tx-detail__value">{children}</dd>
    </div>
  );
}

function TxRow({ row: r, currency, depositMap, kindLabel, trailKindOf, onEdit, onOpenRate, onOpenTrail, onOpenEst, open, onToggle }: RowProps) {
  const other: Ccy = currency === "EUR" ? "USD" : "EUR";
  const main = num(currency === "EUR" ? r.cash_eur : r.cash_usd);
  const second = num(other === "EUR" ? r.cash_eur : r.cash_usd);
  const nativeOther = r.currency !== "EUR" && r.currency !== "USD";
  const qty = r.quantity != null && num(r.quantity) ? formatQuantity(r.quantity.replace(/^-/, "")) : null;
  const price = r.price_native != null ? formatPrice(r.price_native, r.currency) : null;
  const match = depositMap.get(r.id);
  const trail = trailKindOf(r);
  const fees = num(r.fees_native);
  const chips = Boolean(match || trail || r.is_estimate);
  return (
    <li className={`phone-tx${open ? " phone-tx--open" : ""}`} data-tx={r.id}>
      <button type="button" className="phone-tx__row" aria-expanded={open} aria-label={`${r.symbol || r.account} ${formatDate(r.date)}`} onClick={onToggle}>
        <span className="phone-tx__name">
          <ChevronDown className="phone-tx__chevron" aria-hidden />
          <span className="phone-tx__title" data-truncate-ok title={r.symbol || r.account}>{r.symbol || r.account}</span>
        </span>
        <span className="phone-tx__main">
          {main === null ? <span title="No exchange rate on file for this date">–</span> : <Money amount={main} currency={currency} signed colored />}
        </span>
        <span className="phone-tx__kind-col">
          <span className={`phone-tx__kind phone-tx__kind--${r.kind}`} title={kindLabel(r.kind)}>
            {kindLabel(r.kind)}
          </span>
        </span>
        <span className="phone-tx__sub phone-tx__sub--left">
          {shortDate(r.date)}
          {qty ? ` · ${qty} sh` : ""}
        </span>
        <span className="phone-tx__sub">
          {second !== null && <Money amount={second} currency={other} signed />}
          {second === null && nativeOther && <Money amount={num(r.net_native)} currency={r.currency} signed />}
        </span>
        <span className="phone-tx__sub phone-tx__sub--pill">{r.is_estimate ? "estimate" : ""}</span>
      </button>
      {open && (
        <div className="phone-tx-detail">
          <dl className="phone-tx-detail__grid">
            <Detail label="Account">{r.account}</Detail>
            <Detail label="Fees">{fees ? <Money amount={fees} currency={r.currency} /> : MISSING}</Detail>
            <Detail label="Source">{r.source ?? MISSING}</Detail>
            {nativeOther && (
              <Detail label={`Net (${r.currency})`}>
                <Money amount={num(r.net_native)} currency={r.currency} signed />
              </Detail>
            )}
            {second !== null && (
              <Detail label={`${currency === "EUR" ? "USD" : "EUR"} basis`}>
                <Money amount={second} currency={other} signed />
              </Detail>
            )}
            {qty && <Detail label="Shares">{qty}</Detail>}
            {price && <Detail label="Price">{price}</Detail>}
          </dl>
          <div className="phone-tx-detail__actions">
            {match && <RateChip match={match} onOpen={onOpenRate} />}
            {!match && trail && <TrailChip kind={trail} onOpen={() => onOpenTrail(trail, r.id)} />}
            {r.is_estimate && <EstChip onOpen={() => onOpenEst(r.id)} />}
            {chips && <span className="phone-tx-detail__spacer" />}
            {r.instrument_id != null && (
              <Link to={`/instruments?id=${r.instrument_id}`} className="phone-tx-detail__action" aria-label={`Edit instrument ${r.symbol}`}>
                <Tag aria-hidden /> Instrument
              </Link>
            )}
            <button type="button" className="phone-tx-detail__action" aria-label={`Edit transaction ${r.id}`} onClick={() => onEdit(r)}>
              <Pencil aria-hidden /> Edit
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function MonthGroup({
  month,
  rows,
  totals,
  list,
}: {
  month: string;
  rows: TransactionOut[];
  totals: LedgerMonth | undefined;
  list: PhoneTransactionsProps;
}) {
  // Shares the fold memory with the desktop month cards.
  const [open, setOpen] = usePersistentState<boolean>(`${FOLD_KEY_PREFIX}transactions.month.${month}`, true);
  const [openRow, setOpenRow] = useState<number | null>(null);
  const net = totals ? (list.currency === "EUR" ? totals.net_eur : totals.net_usd) : null;
  const label = list.monthLabel(month);
  return (
    <section className={`phone-tx-month${open ? " phone-tx-month--open" : ""}`} data-month={month}>
      <button type="button" className="phone-tx-month__head" aria-expanded={open} aria-label={`${label}${open ? ", fold" : ", unfold"}`} onClick={() => setOpen((o) => !o)}>
        <span className="phone-tx-month__title">
          <ChevronDown className="phone-tx-month__chevron" aria-hidden />
          {label}
        </span>
        <span className="phone-tx-month__net">{totals && <Money amount={net} currency={list.currency} signed colored />}</span>
        <span className="phone-tx-month__sub">
          {totals ? `${totals.count} ${totals.count === 1 ? "transaction" : "transactions"}` : ""}
          {totals && rows.length < totals.count ? ` · ${rows.length} on this page` : ""}
          {totals?.fx_incomplete && <span className="phone-tx-month__warn">no rate</span>}
        </span>
        <span className="phone-tx-month__sub phone-tx-month__sub--right">{totals ? "net" : ""}</span>
      </button>
      {open && (
        <ul className="phone-tx-list" aria-label={`Transactions ${label}`}>
          {rows.map((r) => (
            <TxRow key={r.id} row={r} {...list} open={openRow === r.id} onToggle={() => setOpenRow((cur) => (cur === r.id ? null : r.id))} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Phone Transactions: month groups of two-line rows; a tap opens fees, account, trail and the actions. */
export function PhoneTransactions(props: PhoneTransactionsProps) {
  const [openRow, setOpenRow] = useState<number | null>(null);
  if (props.months === null) {
    return (
      <ul className="phone-tx-list phone-tx-list--flat" aria-label="Transactions">
        {props.rows.map((r) => (
          <TxRow key={r.id} row={r} {...props} open={openRow === r.id} onToggle={() => setOpenRow((cur) => (cur === r.id ? null : r.id))} />
        ))}
      </ul>
    );
  }
  const groups = new Map<string, TransactionOut[]>();
  for (const r of props.rows) {
    const m = r.date.slice(0, 7);
    groups.set(m, [...(groups.get(m) ?? []), r]);
  }
  return (
    <div className="phone-tx-months">
      {[...groups.entries()].map(([month, rows]) => (
        <MonthGroup key={month} month={month} rows={rows} totals={props.months?.get(month)} list={props} />
      ))}
    </div>
  );
}
