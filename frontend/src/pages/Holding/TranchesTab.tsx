import clsx from "clsx";
import { ArrowDown, ArrowUp, ChevronDown, CircleCheck, Clock, Hourglass, Inbox, TriangleAlert } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { Money } from "../../components/Money";
import { Percent } from "../../components/Percent";
import { Skeleton } from "../../components/Skeleton";
import { formatDate, formatMoney, formatQuantity as formatQty1 } from "../../lib/format";
import {
  type HoldingTranchesDto,
  type TrancheGroupDto,
  type TrancheRowDto,
  useHoldingTranches,
} from "../../lib/queries/holding-detail";
import type { HoldingRowDto } from "../../lib/queries/holdings";
import { toNum } from "../../lib/queries/portfolio";
import { useIsPhone } from "../../lib/useMediaQuery";
import { formatQuantity as formatShares } from "../Transactions/numbers";
import { formatAge } from "./holdingFormat";

/** As many decimals as the server sent (trailing zeros dropped, at most 6). */
const qty = (v: string | null | undefined): string => formatShares(v);

/** Status badge: always an icon and a word (P3: "soon" = long-term within 60 days). */
export function TrancheBadge({
  row,
  compact = false,
}: {
  row: Pick<TrancheRowDto, "status" | "days_to_long_term">;
  /** Phone cards: shorter words (still an icon and a word). */
  compact?: boolean;
}) {
  const days = row.days_to_long_term;
  const look =
    row.status === "long"
      ? { icon: <CircleCheck aria-hidden size={14} className="holding-page__lot-icon holding-page__lot-icon--long" />, text: "Long-term" }
      : row.status === "soon"
        ? { icon: <Hourglass aria-hidden size={14} className="holding-page__lot-icon holding-page__lot-icon--soon" />, text: compact ? `Long in ${days ?? "–"} d` : `Long-term in ${days ?? "–"} d` }
        : { icon: <Clock aria-hidden size={14} className="holding-page__lot-icon" />, text: compact ? `Short · ${days ?? "–"} d` : `Short-term · ${days ?? "–"} d left` };
  return (
    <span className={clsx("holding-page__lot-badge", `holding-page__lot-badge--${row.status}`)}>
      {look.icon}
      {look.text}
    </span>
  );
}

/** Gain bar on one shared scale (share of the largest |gain %|); blue up, orange down. */
function GainBar({ pct, scale, wide = false }: { pct: string | null; scale: number; wide?: boolean }) {
  const v = toNum(pct);
  if (v === null || scale <= 0) return null;
  const share = Math.min(1, Math.abs(v) / scale);
  return (
    <span className={clsx("holding-page__lot-bar", wide && "holding-page__lot-bar--wide")} aria-hidden>
      <span
        className={clsx("holding-page__lot-bar-fill", v < 0 ? "holding-page__lot-bar-fill--neg" : "holding-page__lot-bar-fill--pos")}
        style={{ width: `${(share * 100).toFixed(1)}%` }}
      />
    </span>
  );
}

/** Value now = cost + gain (both server figures, same lot); null without a price. */
function valueNow(cost: string | null, gain: string | null): number | null {
  const c = toNum(cost);
  const g = toNum(gain);
  return c === null || g === null ? null : c + g;
}

function Gain({ amount, pct, ccy, scale = 0 }: { amount: string | null; pct: string | null; ccy: string; scale?: number }) {
  const p = toNum(pct);
  return (
    <span className="holding-page__lot-gain">
      <Money amount={toNum(amount)} currency={ccy} signed colored digits={0} />
      <span className="holding-page__lot-pct">
        {p !== null && p !== 0 && (p > 0 ? <ArrowUp aria-hidden size={12} /> : <ArrowDown aria-hidden size={12} />)}
        <Percent ratio={p} signed />
      </span>
      <GainBar pct={pct} scale={scale} />
    </span>
  );
}

function LotRow({ r, ccy, nested = false, accounts, scale }: { r: TrancheRowDto; ccy: string; nested?: boolean; accounts: boolean; scale: number }) {
  const sold = (toNum(r.quantity_bought) ?? 0) - (toNum(r.quantity_left) ?? 0);
  return (
    <tr className={clsx("holding-page__lot", nested && "holding-page__lot--nested")}>
      <td className="holding-page__lot-td">
        {formatDate(r.acquired_on)}
        {r.source !== "buy" && (
          <span className="holding-page__muted"> · {r.source === "reinvest" ? "reinvested" : "moved in"}</span>
        )}
        <span className="holding-page__lot-sub">{formatAge(r.age_days)}</span>
        <span className="holding-page__lot-inline">
          <TrancheBadge row={r} compact />
        </span>
      </td>
      {accounts && (
        <td className="holding-page__lot-td holding-page__lot-td--account" title={r.account_name}>
          <span className="holding-page__clip">{r.account_name}</span>
        </td>
      )}
      <td className="holding-page__lot-td holding-page__lot-td--right">
        {qty(r.quantity_left)} / {qty(r.quantity_bought)}
        {sold > 0 && <span className="holding-page__lot-sub">{formatShares(String(Math.round(sold * 1e6) / 1e6))} sold</span>}
      </td>
      <td className="holding-page__lot-td holding-page__lot-td--right">
        {formatMoney(toNum(r.cost_per_share_native), ccy)}
      </td>
      <td className="holding-page__lot-td holding-page__lot-td--right holding-page__lot-td--cost">
        <Money amount={toNum(r.cost_native)} currency={ccy} digits={0} />
      </td>
      <td className="holding-page__lot-td holding-page__lot-td--right">
        <Money amount={valueNow(r.cost_native, r.gain_native)} currency={ccy} digits={0} />
        <span className="holding-page__lot-sub holding-page__lot-sub--cost">
          cost <Money amount={toNum(r.cost_native)} currency={ccy} digits={0} />
        </span>
      </td>
      <td className="holding-page__lot-td holding-page__lot-td--status">
        <TrancheBadge row={r} />
      </td>
      <td className="holding-page__lot-td holding-page__lot-td--right">
        <Gain amount={r.gain_native} pct={r.gain_pct} ccy={ccy} scale={scale} />
      </td>
    </tr>
  );
}

function GroupRow({
  g,
  members,
  ccy,
  account,
  accounts,
  scale,
}: {
  g: TrancheGroupDto;
  members: TrancheRowDto[];
  ccy: string;
  account: string;
  accounts: boolean;
  scale: number;
}) {
  const [open, setOpen] = useState(false);
  const id = `lot-group-${g.account_id}`;
  return (
    <>
      <tr className="holding-page__lot holding-page__lot--group">
        <td className="holding-page__lot-td">
          <button
            type="button"
            className="holding-page__lot-toggle"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen((o) => !o)}
          >
            <ChevronDown aria-hidden size={14} className={clsx("holding-page__lot-chevron", open && "holding-page__lot-chevron--open")} />
            {g.count} reinvested · {qty(g.quantity_left)} sh
          </button>
          <span className="holding-page__lot-inline holding-page__lot-sub">
            {g.long_count} long · {g.short_count} short
          </span>
        </td>
        {accounts && (
          <td className="holding-page__lot-td holding-page__lot-td--account" title={account}>
            <span className="holding-page__clip">{account}</span>
          </td>
        )}
        <td className="holding-page__lot-td holding-page__lot-td--right">{qty(g.quantity_left)}</td>
        <td className="holding-page__lot-td holding-page__lot-td--right">
          {formatMoney(toNum(g.avg_cost_per_share_native), ccy)}
          <span className="holding-page__lot-sub">average</span>
        </td>
        <td className="holding-page__lot-td holding-page__lot-td--right holding-page__lot-td--cost">
          <Money amount={toNum(g.cost_native)} currency={ccy} digits={0} />
        </td>
        <td className="holding-page__lot-td holding-page__lot-td--right">
          <Money amount={valueNow(g.cost_native, g.gain_native)} currency={ccy} digits={0} />
          <span className="holding-page__lot-sub holding-page__lot-sub--cost">
            cost <Money amount={toNum(g.cost_native)} currency={ccy} digits={0} />
          </span>
        </td>
        <td className="holding-page__lot-td holding-page__lot-td--status holding-page__muted">
          {g.long_count} long · {g.short_count} short
        </td>
        <td className="holding-page__lot-td holding-page__lot-td--right">
          <Gain amount={g.gain_native} pct={g.gain_pct} ccy={ccy} scale={scale} />
        </td>
      </tr>
      {open && (
        <tr id={id} className="holding-page__lot-nest" aria-label={`Reinvested dividends in ${account}`}>
          <td colSpan={accounts ? 8 : 7} className="holding-page__lot-nest-cell" aria-label={`${g.count} reinvested tranches`}>
            <table className="holding-page__lots holding-page__lots--nested">
              <caption className="holding-page__sr">Reinvested dividends in {account}</caption>
              <tbody>
                {members.map((r) => (
                  <LotRow key={r.id} r={r} ccy={ccy} nested accounts={accounts} scale={scale} />
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}

/** Phone card, four calm lines on one left and one right edge: title and badge, detail, gain and %, bar. */
function CardBody({
  title,
  badge,
  shares,
  bought,
  value,
  gain,
  pct,
  ccy,
  scale,
}: {
  title: ReactNode;
  badge: ReactNode;
  shares: ReactNode;
  bought: ReactNode;
  value: ReactNode;
  gain: string | null;
  pct: string | null;
  ccy: string;
  scale: number;
}) {
  const p = toNum(pct);
  return (
    <>
      <span className="holding-page__lotcard-title">{title}</span>
      <span className="holding-page__lotcard-badge">{badge}</span>
      <span className="holding-page__lotcard-figs">
        <span className="holding-page__lotcard-fig">
          <span className="holding-page__lotcard-label">Shares</span>
          <span className="holding-page__lotcard-val">{shares}</span>
        </span>
        <span className="holding-page__lotcard-fig holding-page__lotcard-fig--mid">
          <span className="holding-page__lotcard-label">Bought at</span>
          <span className="holding-page__lotcard-val">{bought}</span>
        </span>
        <span className="holding-page__lotcard-fig holding-page__lotcard-fig--end">
          <span className="holding-page__lotcard-label">Value now</span>
          <span className="holding-page__lotcard-val">{value}</span>
        </span>
      </span>
      <span className="holding-page__lotcard-gain">
        <Money amount={toNum(gain)} currency={ccy} signed colored digits={0} />
      </span>
      <span className="holding-page__lotcard-pct">
        {p !== null && p !== 0 && (p > 0 ? <ArrowUp aria-hidden size={12} /> : <ArrowDown aria-hidden size={12} />)}
        <Percent ratio={p} signed />
      </span>
      <GainBar pct={pct} scale={scale} wide />
    </>
  );
}

function LotCard({ r, ccy, nested = false, scale }: { r: TrancheRowDto; ccy: string; nested?: boolean; scale: number }) {
  const same = toNum(r.quantity_left) === toNum(r.quantity_bought);
  return (
    <li className="holding-page__row-item">
      <div className="holding-page__lotcard">
        <CardBody
          title={
            <>
              {formatDate(r.acquired_on)}
              {r.source === "reinvest" && !nested && <span className="holding-page__muted"> · reinvested</span>}
            </>
          }
          badge={<TrancheBadge row={r} compact />}
          bought={formatMoney(toNum(r.cost_per_share_native), ccy)}
          shares={same ? qty(r.quantity_left) : `${qty(r.quantity_left)} / ${qty(r.quantity_bought)}`}
          value={<Money amount={valueNow(r.cost_native, r.gain_native)} currency={ccy} digits={0} />}
          gain={r.gain_native}
          pct={r.gain_pct}
          ccy={ccy}
          scale={scale}
        />
      </div>
    </li>
  );
}

function GroupCard({ g, members, ccy, scale }: { g: TrancheGroupDto; members: TrancheRowDto[]; ccy: string; scale: number }) {
  const [open, setOpen] = useState(false);
  const id = `lot-card-group-${g.account_id}`;
  return (
    <li className="holding-page__row-item">
      <button
        type="button"
        className="holding-page__lotcard holding-page__lotcard--button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        <CardBody
          title={
            <>
              <ChevronDown aria-hidden size={14} className={clsx("holding-page__lot-chevron", open && "holding-page__lot-chevron--open")} />
              {g.count} reinvested · {qty(g.quantity_left)} sh
            </>
          }
          badge={
            <span className="holding-page__muted">
              {g.long_count} long · {g.short_count} short
            </span>
          }
          bought={formatMoney(toNum(g.avg_cost_per_share_native), ccy)}
          shares={qty(g.quantity_left)}
          value={<Money amount={valueNow(g.cost_native, g.gain_native)} currency={ccy} digits={0} />}
          gain={g.gain_native}
          pct={g.gain_pct}
          ccy={ccy}
          scale={scale}
        />
      </button>
      {open && (
        <ul id={id} className="holding-page__rows holding-page__rows--nested">
          {members.map((r) => (
            <LotCard key={r.id} r={r} ccy={ccy} nested scale={scale} />
          ))}
        </ul>
      )}
    </li>
  );
}

function Footer({ d }: { d: HoldingTranchesDto }) {
  const t = d.totals;
  return (
    <p className="holding-page__lot-footer">
      <span className="holding-page__lot-check">
        {t.matches_position ? (
          <CircleCheck aria-hidden size={14} />
        ) : (
          <TriangleAlert aria-hidden size={14} />
        )}
        Open {qty(t.quantity_left)} sh{" "}
        {t.matches_position ? "= position" : `≠ position ${qty(t.position_quantity)} sh`}
      </span>
      <span>
        {t.fully_sold_count} fully sold
      </span>
      <span>
        Long-term {formatQty1(toNum(t.long_quantity), 1)} sh · short-term {formatQty1(toNum(t.short_quantity), 1)} sh
      </span>
    </p>
  );
}

/** One row per purchase, used up first in, first out (a view; nothing sums from it). */
export function TranchesTab({ row }: { row: HoldingRowDto }) {
  const q = useHoldingTranches(row.instrument_id);
  const isPhone = useIsPhone();
  if (q.isError) return <ErrorState message="Could not load the tranches." onRetry={() => void q.refetch()} />;
  if (q.isPending) return <Skeleton height="12rem" />;
  const d = q.data;
  if (d.rows.length === 0) {
    return <EmptyState icon={<Inbox aria-hidden />} title={`No open tranches of ${row.symbol}.`} />;
  }
  const ccy = d.currency;
  const byId = new Map(d.rows.map((r) => [r.id, r]));
  const grouped = new Set(d.groups.flatMap((g) => g.row_ids));
  const loose = d.rows.filter((r) => !grouped.has(r.id));
  const accountOf = (id: number) => d.rows.find((r) => r.account_id === id)?.account_name ?? "";
  const members = (g: TrancheGroupDto) => g.row_ids.flatMap((id) => byId.get(id) ?? []);
  const accounts = new Set(d.rows.map((r) => r.account_id)).size > 1;
  const price = d.price_native ?? null;
  const scale = Math.max(0, ...[...d.rows, ...d.groups].map((x) => Math.abs(toNum(x.gain_pct) ?? 0)));
  const gainHead = price !== null ? `Gain at ${formatMoney(toNum(price), ccy, { unmasked: true })}` : "Gain vs today";
  const heads = ["Bought", ...(accounts ? ["Account"] : []), "Shares left / bought", "Bought at", "Cost", "Value now", "Status", gainHead];
  const right = new Set(["Shares left / bought", "Bought at", "Cost", "Value now", gainHead]);
  return (
    <div className="holding-page__panel">
      <p className="holding-page__note">
        One row per purchase, used up first in, first out. The totals elsewhere use the average cost, so these
        gains do not add up to the holding&apos;s.
      </p>
      {isPhone ? (
        <ul className="holding-page__rows">
          {loose.map((r) => (
            <LotCard key={r.id} r={r} ccy={ccy} scale={scale} />
          ))}
          {d.groups.map((g) => (
            <GroupCard key={`g${g.account_id}`} g={g} members={members(g)} ccy={ccy} scale={scale} />
          ))}
        </ul>
      ) : (
        <div className="holding-page__table-wrap" data-scrollable>
          <table className="holding-page__lots">
            <caption className="holding-page__sr">Tranches of {row.symbol}</caption>
            <thead>
              <tr>
                {heads.map((h) => (
                  <th key={h} scope="col" className={clsx("holding-page__lot-th", right.has(h) && "holding-page__lot-th--right", h === "Cost" && "holding-page__lot-th--cost", h === "Status" && "holding-page__lot-th--status")}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loose.map((r) => (
                <LotRow key={r.id} r={r} ccy={ccy} accounts={accounts} scale={scale} />
              ))}
              {d.groups.map((g) => (
                <Fragment key={`g${g.account_id}`}>
                  <GroupRow g={g} members={members(g)} ccy={ccy} account={accountOf(g.account_id)} accounts={accounts} scale={scale} />
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Footer d={d} />
    </div>
  );
}
