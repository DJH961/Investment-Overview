import clsx from "clsx";
import { ArrowRight, Layers, ListOrdered } from "lucide-react";
import type { ReactNode } from "react";
import { LinkButton } from "../Button";
import { Percent } from "../Percent";
import { Skeleton } from "../Skeleton";
import { Sparkline } from "../Sparkline";
import { formatAxisDate, formatMoney, formatNumber, formatPp, formatQuantity } from "../../lib/format";
import { usePrefs } from "../../lib/prefs";
import { type HoldingPeekDto, useHoldingPeek } from "../../lib/queries/holding-detail";
import type { HoldingRowDto } from "../../lib/queries/holdings";
import { toNum } from "../../lib/queries/portfolio";
import "./HoldingPeek.scss";

/** "Long-term in N d" is worth saying only when it is close (P3). */
export const SOON_DAYS = 60;

const TRADE_LABEL: Record<string, string> = {
  buy: "Buy",
  sell: "Sell",
  dividend_reinvest: "Reinvested",
  transfer_in: "Moved in",
  transfer_out: "Moved out",
};

export interface HoldingPeekProps {
  row: HoldingRowDto;
  /** `phone`: one compact column under the row; `panel`: the desktop full-width row. */
  layout: "phone" | "panel";
  id?: string;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="holding-peek__fact">
      <dt className="holding-peek__key">{label}</dt>
      <dd className="holding-peek__value">{children}</dd>
    </div>
  );
}

/** "23/12": the day in the app's date layout, no year (the peek is about recent things). */
const shortDay = (iso: string): string => formatAxisDate(Date.parse(`${iso.slice(0, 10)}T12:00:00Z`), 0);

function tranchesText(p: HoldingPeekDto): string {
  const t = p.tranches;
  const base = `${t.open_count} open`;
  const days = t.next_long_term_days;
  return days != null && days >= 0 && days <= SOON_DAYS ? `${base} · long-term in ${days} d` : base;
}

function TradeFact({ p }: { p: HoldingPeekDto }) {
  const t = p.last_trade;
  if (!t) return <span className="holding-peek__muted">None yet</span>;
  const qty = toNum(t.quantity);
  return (
    <>
      {TRADE_LABEL[t.kind] ?? t.kind}
      {qty !== null && ` ${formatQuantity(Math.abs(qty), Number.isInteger(qty) ? 0 : 4)} sh`}
      <span className="holding-peek__muted"> · {shortDay(t.date)}</span>
    </>
  );
}

function DividendFact({ p }: { p: HoldingPeekDto }) {
  const d = p.last_dividend;
  if (!d) return <span className="holding-peek__muted">None yet</span>;
  return (
    <>
      {formatMoney(toNum(d.amount_native ?? null), p.currency, { digits: 0 })}
      {d.reinvested && <span className="holding-peek__muted"> reinvested</span>}
      <span className="holding-peek__muted"> · {shortDay(d.date)}</span>
    </>
  );
}

/** The twin line comes from the holdings row (the peek does not repeat it). */
function TwinFact({ row }: { row: HoldingRowDto }) {
  const t = row.twin;
  if (!t) return null;
  if (t.pending) {
    return (
      <span className="holding-peek__twin">
        ≈ {t.symbol} <Percent ratio={toNum(t.est_today_pct ?? null)} signed />
        <span className="holding-peek__muted"> · est. until the NAV</span>
      </span>
    );
  }
  const gap = toNum(t.divergence?.last_pp ?? null);
  return (
    <span className="holding-peek__twin">
      {t.symbol}
      <span className="holding-peek__muted">
        {gap !== null ? ` · last gap ${formatPp(gap / 100)}` : " · NAV posted"}
      </span>
    </span>
  );
}

function Week({ p, wide }: { p: HoldingPeekDto; wide: boolean }) {
  const { currency } = usePrefs();
  if (!p.week) {
    // NAV funds: one price a day, no week of intraday values.
    return (
      <div className="holding-peek__week">
        <span className="holding-peek__key">Past week</span>
        <span className="holding-peek__muted">One NAV a day: see the holding page</span>
      </div>
    );
  }
  const values = p.week.points.map((pt) => toNum(pt.value_native ?? null));
  const ret = currency === "EUR" ? p.week.return_eur : p.week.return_usd;
  return (
    <div className="holding-peek__week">
      <span className="holding-peek__key">Past week</span>
      <Sparkline
        values={values}
        width={wide ? 240 : 132}
        height={wide ? 56 : 32}
        ariaLabel="Value over the past week"
        className="holding-peek__spark"
      />
      <Percent ratio={toNum(ret ?? null)} signed colored className="holding-peek__week-pct" />
    </div>
  );
}

function Actions({ row, layout }: { row: HoldingRowDto; layout: HoldingPeekProps["layout"] }) {
  const size = layout === "phone" ? "lg" : "sm";
  const base = `/holdings/${row.instrument_id}`;
  // Phone: words only, so the three fit one row at 360 px.
  const icon = (node: ReactNode) => (layout === "phone" ? undefined : node);
  return (
    <div className="holding-peek__actions">
      <LinkButton to={base} variant="primary" size={size} className="holding-peek__action holding-peek__open">
        {layout === "phone" ? `Open ${row.symbol}` : "Open deep dive"}
        <ArrowRight aria-hidden size={16} />
      </LinkButton>
      <LinkButton to={`${base}/tranches`} variant="secondary" size={size} className="holding-peek__action" leftIcon={icon(<Layers aria-hidden size={16} />)}>
        Tranches
      </LinkButton>
      <LinkButton
        to={`${base}/transactions`}
        variant="secondary"
        size={size}
        className="holding-peek__action"
        leftIcon={icon(<ListOrdered aria-hidden size={16} />)}
      >
        Activity
      </LinkButton>
    </div>
  );
}

/**
 * The compact look inside a holdings row (7.1): the past week, four one-line facts
 * and the ways into the deep dive. Everything else lives on the holding page, so no
 * figure here repeats the row above it. Loaded only once the row is opened.
 */
export function HoldingPeek({ row, layout, id }: HoldingPeekProps) {
  const q = useHoldingPeek(row.instrument_id, true);
  const p = q.data;
  const wide = layout === "panel";
  const facts = () =>
    p && (
      <dl className="holding-peek__facts">
        <Fact label="Tranches">{tranchesText(p)}</Fact>
        {row.twin && (
          <Fact label="Twin">
            <TwinFact row={row} />
          </Fact>
        )}
        <Fact label="Last trade">
          <TradeFact p={p} />
        </Fact>
        <Fact label="Last dividend">
          <DividendFact p={p} />
        </Fact>
        {/* 7.4: the rate this holding's dollars cost (pool blend), when the server has it. */}
        {(p as typeof p & { your_rate?: string | null }).your_rate ? (
          <Fact label="Your rate">{formatNumber(Number((p as typeof p & { your_rate?: string | null }).your_rate), 4)}</Fact>
        ) : null}
      </dl>
    );

  const body = q.isPending ? (
    <Skeleton height={wide ? "4.5rem" : "6rem"} />
  ) : q.isError || !p ? (
    <p className="holding-peek__muted">Could not load the summary. The holding page has everything.</p>
  ) : wide ? (
    <div className="holding-peek__cols">
      <Week p={p} wide />
      {facts()}
    </div>
  ) : (
    <>
      <Week p={p} wide={false} />
      {facts()}
    </>
  );

  return (
    <section id={id} className={clsx("holding-peek", `holding-peek--${layout}`)} aria-label={`${row.symbol} at a glance`}>
      {body}
      <Actions row={row} layout={layout} />
    </section>
  );
}
