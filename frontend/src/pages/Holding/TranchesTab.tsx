import clsx from "clsx";
import { ChevronDown, CircleCheck, Clock, Hourglass, Inbox, TriangleAlert } from "lucide-react";
import { Fragment, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { Money } from "../../components/Money";
import { Percent } from "../../components/Percent";
import { Skeleton } from "../../components/Skeleton";
import { formatDate, formatMoney } from "../../lib/format";
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
export function TrancheBadge({ row }: { row: Pick<TrancheRowDto, "status" | "days_to_long_term"> }) {
  const days = row.days_to_long_term;
  const look =
    row.status === "long"
      ? { icon: <CircleCheck aria-hidden size={14} className="holding-page__lot-icon holding-page__lot-icon--long" />, text: "Long-term" }
      : row.status === "soon"
        ? { icon: <Hourglass aria-hidden size={14} className="holding-page__lot-icon holding-page__lot-icon--soon" />, text: `Long-term in ${days ?? "–"} d` }
        : { icon: <Clock aria-hidden size={14} className="holding-page__lot-icon" />, text: `Short-term · ${days ?? "–"} d left` };
  return (
    <span className={clsx("holding-page__lot-badge", `holding-page__lot-badge--${row.status}`)}>
      {look.icon}
      {look.text}
    </span>
  );
}

function Gain({ amount, pct, ccy }: { amount: string | null; pct: string | null; ccy: string }) {
  return (
    <span className="holding-page__lot-gain">
      <Money amount={toNum(amount)} currency={ccy} signed colored />
      <Percent ratio={toNum(pct)} signed className="holding-page__lot-pct" />
    </span>
  );
}

function LotRow({ r, ccy, nested = false }: { r: TrancheRowDto; ccy: string; nested?: boolean }) {
  const sold = (toNum(r.quantity_bought) ?? 0) - (toNum(r.quantity_left) ?? 0);
  return (
    <tr className={clsx("holding-page__lot", nested && "holding-page__lot--nested")}>
      <td className="holding-page__lot-td">
        {formatDate(r.acquired_on)}
        {r.source !== "buy" && (
          <span className="holding-page__muted"> · {r.source === "reinvest" ? "reinvested" : "moved in"}</span>
        )}
      </td>
      <td className="holding-page__lot-td holding-page__lot-td--account" title={r.account_name}>
        <span className="holding-page__clip">{r.account_name}</span>
      </td>
      <td className="holding-page__lot-td holding-page__lot-td--right">
        {qty(r.quantity_left)} / {qty(r.quantity_bought)}
        {sold > 0 && <span className="holding-page__lot-sub">{formatShares(String(Math.round(sold * 1e6) / 1e6))} sold</span>}
      </td>
      <td className="holding-page__lot-td holding-page__lot-td--right">
        {formatMoney(toNum(r.cost_per_share_native), ccy)}
      </td>
      <td className="holding-page__lot-td holding-page__lot-td--right">
        <Money amount={toNum(r.cost_native)} currency={ccy} />
      </td>
      <td className="holding-page__lot-td holding-page__lot-td--right">{formatAge(r.age_days)}</td>
      <td className="holding-page__lot-td">
        <TrancheBadge row={r} />
      </td>
      <td className="holding-page__lot-td holding-page__lot-td--right">
        <Gain amount={r.gain_native} pct={r.gain_pct} ccy={ccy} />
      </td>
    </tr>
  );
}

function GroupRow({
  g,
  members,
  ccy,
  account,
}: {
  g: TrancheGroupDto;
  members: TrancheRowDto[];
  ccy: string;
  account: string;
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
        </td>
        <td className="holding-page__lot-td holding-page__lot-td--account" title={account}>
          <span className="holding-page__clip">{account}</span>
        </td>
        <td className="holding-page__lot-td holding-page__lot-td--right">{qty(g.quantity_left)}</td>
        <td className="holding-page__lot-td holding-page__lot-td--right">
          {formatMoney(toNum(g.avg_cost_per_share_native), ccy)}
          <span className="holding-page__lot-sub">average</span>
        </td>
        <td className="holding-page__lot-td holding-page__lot-td--right">
          <Money amount={toNum(g.cost_native)} currency={ccy} />
        </td>
        <td className="holding-page__lot-td holding-page__lot-td--right">–</td>
        <td className="holding-page__lot-td holding-page__muted">
          {g.long_count} long · {g.short_count} short
        </td>
        <td className="holding-page__lot-td holding-page__lot-td--right">
          <Gain amount={g.gain_native} pct={g.gain_pct} ccy={ccy} />
        </td>
      </tr>
      {open && (
        <tr id={id} className="holding-page__lot-nest" aria-label={`Reinvested dividends in ${account}`}>
          <td colSpan={8} className="holding-page__lot-nest-cell" aria-label={`${g.count} reinvested tranches`}>
            <table className="holding-page__lots holding-page__lots--nested">
              <caption className="holding-page__sr">Reinvested dividends in {account}</caption>
              <tbody>
                {members.map((r) => (
                  <LotRow key={r.id} r={r} ccy={ccy} nested />
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}

function LotCard({ r, ccy, nested = false }: { r: TrancheRowDto; ccy: string; nested?: boolean }) {
  return (
    <li className="holding-page__row-item">
      <div className="holding-page__row">
        <span className="holding-page__row-lead">
          {formatDate(r.acquired_on)}
          {r.source === "reinvest" && !nested && <span className="holding-page__muted"> · reinvested</span>}
        </span>
        <span className="holding-page__row-amount">
          <Money amount={toNum(r.gain_native)} currency={ccy} signed colored />
        </span>
        <span className="holding-page__row-meta">
          {/* "x / y" only when some were sold; otherwise just the shares. */}
          {toNum(r.quantity_left) === toNum(r.quantity_bought) ? qty(r.quantity_left) : `${qty(r.quantity_left)} / ${qty(r.quantity_bought)}`} sh ·{" "}
          {formatMoney(toNum(r.cost_per_share_native), ccy)}
        </span>
        <span className="holding-page__row-detail">
          <TrancheBadge row={r} />
        </span>
      </div>
    </li>
  );
}

function GroupCard({ g, members, ccy }: { g: TrancheGroupDto; members: TrancheRowDto[]; ccy: string }) {
  const [open, setOpen] = useState(false);
  const id = `lot-card-group-${g.account_id}`;
  return (
    <li className="holding-page__row-item">
      <button
        type="button"
        className="holding-page__row holding-page__row--button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="holding-page__row-lead">
          <ChevronDown aria-hidden size={14} className={clsx("holding-page__lot-chevron", open && "holding-page__lot-chevron--open")} />
          {g.count} reinvested · {qty(g.quantity_left)} sh
        </span>
        <span className="holding-page__row-amount">
          <Money amount={toNum(g.gain_native)} currency={ccy} signed colored />
        </span>
        <span className="holding-page__row-meta">
          avg {formatMoney(toNum(g.avg_cost_per_share_native), ccy)} · cost <Money amount={toNum(g.cost_native)} currency={ccy} compact />
        </span>
        <span className="holding-page__row-detail holding-page__muted">
          {g.long_count} long · {g.short_count} short
        </span>
      </button>
      {open && (
        <ul id={id} className="holding-page__rows holding-page__rows--nested">
          {members.map((r) => (
            <LotCard key={r.id} r={r} ccy={ccy} nested />
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
        Long-term {qty(t.long_quantity)} sh · short-term {qty(t.short_quantity)} sh
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
  return (
    <div className="holding-page__panel">
      <p className="holding-page__note">
        One row per purchase, used up first in, first out. The totals elsewhere use the average cost, so these
        gains do not add up to the holding&apos;s.
      </p>
      {isPhone ? (
        <ul className="holding-page__rows">
          {loose.map((r) => (
            <LotCard key={r.id} r={r} ccy={ccy} />
          ))}
          {d.groups.map((g) => (
            <GroupCard key={`g${g.account_id}`} g={g} members={members(g)} ccy={ccy} />
          ))}
        </ul>
      ) : (
        <div className="holding-page__table-wrap" data-scrollable>
          <table className="holding-page__lots">
            <caption className="holding-page__sr">Tranches of {row.symbol}</caption>
            <thead>
              <tr>
                {["Bought", "Account", "Shares left / bought", "Cost / sh", "Cost", "Age", "Status", "Gain vs today"].map(
                  (h, i) => (
                    <th
                      key={h}
                      scope="col"
                      className={clsx("holding-page__lot-th", [2, 3, 4, 5, 7].includes(i) && "holding-page__lot-th--right")}
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {loose.map((r) => (
                <LotRow key={r.id} r={r} ccy={ccy} />
              ))}
              {d.groups.map((g) => (
                <Fragment key={`g${g.account_id}`}>
                  <GroupRow g={g} members={members(g)} ccy={ccy} account={accountOf(g.account_id)} />
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
