import clsx from "clsx";
import { ChevronDown, Link2, X } from "lucide-react";
import { Fragment, useEffect, useId, useMemo } from "react";
import { Link } from "react-router";
import { Card } from "../Card";
import { ErrorState } from "../ErrorState";
import { foldStamps, formatStamp, holdingMarks, isNavRow, PriceStamps, PriceTick, sentenceCase } from "../Freshness";
import { Money } from "../Money";
import { Percent } from "../Percent";
import { Skeleton } from "../Skeleton";
import { formatPp } from "../../lib/format";
import { toNum, useHoldings, type HoldingRowDto, type OverviewDto } from "../../lib/queries/portfolio";
import { useDisplayPrefs } from "../../lib/displayPrefs";
import type { ReportingCurrency } from "../../lib/prefs";
import { useTimeZone } from "../../lib/timezone";
import { usePersistentState } from "../../lib/usePersistentState";
import "./OverviewHoldings.scss";

/** How many positions stay open above the fold (largest first). */
export const OVERVIEW_HOLDINGS_LIMIT = 8;

/** How long "twin was X.XX pp off" remains visible after the actual NAV price drops (12 hours). */
export const TWIN_OFF_TTL_MS = 12 * 60 * 60 * 1000;

export interface TwinWatchState {
  /** Symbol -> epoch ms (as text) of the last time the user saw the twin while it was pending. */
  seenPending: Record<string, string>;
  /** Session key (`symbol:date`) dismissed by the user via the × button. */
  dismissed: Record<string, boolean>;
}

const DEFAULT_TWIN_WATCH: TwinWatchState = { seenPending: {}, dismissed: {} };

function isTwinWatchState(v: unknown): v is TwinWatchState {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.seenPending === "object" && obj.seenPending !== null && typeof obj.dismissed === "object" && obj.dismissed !== null;
}

/** Key identifying the session for a twin divergence reading. */
export function twinSessionKey(row: HoldingRowDto): string {
  const date = row.twin?.divergence?.last_date ?? row.price_as_of ?? "unknown";
  return `${row.symbol}:${date}`;
}

/** Whether the actual NAV price drop is within the 12-hour display window. */
export function isWithinNavDropWindow(row: HoldingRowDto, nowMs = Date.now()): boolean {
  const droppedIso = row.updated_at ?? row.price_market_at ?? null;
  if (!droppedIso) return true;
  const droppedMs = Date.parse(droppedIso);
  if (!Number.isFinite(droppedMs)) return true;
  return nowMs - droppedMs <= TWIN_OFF_TTL_MS;
}

export interface OverviewHoldingsProps {
  currency: ReportingCurrency;
  /** Overview movers, to badge the winners/losers — only when the setting is on. */
  movers?: OverviewDto["movers"];
}

export function topHoldings(rows: HoldingRowDto[], limit = OVERVIEW_HOLDINGS_LIMIT): HoldingRowDto[] {
  return byValue(rows).slice(0, limit);
}

/** Every position, largest first. */
export function byValue(rows: HoldingRowDto[]): HoldingRowDto[] {
  return [...rows].sort((a, b) => (toNum(b.value) ?? -Infinity) - (toNum(a.value) ?? -Infinity));
}

/** "└┄" connector: dashed L from the row above to the twin line (decorative). */
function TwinLink() {
  return <span className="overview-holdings__twin-link" aria-hidden />;
}

/** Whether the row carries a visible twin line (estimate while pending, or eligible post-NAV divergence). */
export function hasTwinLine(row: HoldingRowDto, watch?: TwinWatchState, nowMs = Date.now()): boolean {
  const t = row.twin;
  if (!t) return false;
  if (t.pending) return t.est_value != null;
  if (toNum(t.divergence?.last_pp ?? null) === null) return false;
  if (!isWithinNavDropWindow(row, nowMs)) return false;
  if (!watch) return true;
  const key = twinSessionKey(row);
  if (watch.dismissed[key]) return false;
  return seenThisSession(row, watch, nowMs);
}

/** How long before the NAV posted the user's last look at the estimate still counts as "watched". */
export const TWIN_SEEN_BEFORE_NAV_MS = 18 * 60 * 60 * 1000;
/** Seen-stamps older than this are dropped from storage. */
export const TWIN_SEEN_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * True only when the user looked at the pending estimate shortly before (or after) this
 * NAV posted, so an old sighting of the same fund never triggers today's accuracy note.
 * `seenPending[symbol]` holds the epoch milliseconds of the last sighting.
 */
function seenThisSession(row: HoldingRowDto, watch: TwinWatchState, nowMs: number): boolean {
  const seenMs = Number(watch.seenPending[row.symbol]);
  if (!Number.isFinite(seenMs) || seenMs <= 0) return false;
  const droppedMs = Date.parse(row.updated_at ?? row.price_market_at ?? "");
  const navMs = Number.isFinite(droppedMs) ? droppedMs : nowMs;
  return navMs - seenMs <= TWIN_SEEN_BEFORE_NAV_MS;
}

/**
 * One quiet line under a NAV fund whose ETF twin is estimating it (NAV not posted yet):
 * `└┄ [≈ est.] VOO · today 14:02   ≈value   ≈+0.61% ≈+€254`. Once the NAV posted it
 * only says how far the twin was off (if the user watched the pending estimate and the
 * NAV dropped within 12h), with an × button to dismiss. Nothing here is official.
 */
function TwinSubRow({
  row,
  ccy,
  timeZone,
  watch,
  onDismiss,
}: {
  row: HoldingRowDto;
  ccy: string;
  timeZone?: string;
  watch: TwinWatchState;
  onDismiss: (key: string) => void;
}) {
  const twin = row.twin;
  if (!twin) return null;
  if (!twin.pending) {
    if (!hasTwinLine(row, watch)) return null;
    const pp = toNum(twin.divergence?.last_pp ?? null);
    if (pp === null) return null;
    const money = toNum(twin.divergence?.last_money ?? null);
    const key = twinSessionKey(row);
    return (
      <li
        className="overview-holdings__twin overview-holdings__twin--off"
        data-twin-for={row.symbol}
        aria-label={`${twin.symbol} twin accuracy for ${row.symbol}`}
      >
        <span className="overview-holdings__twin-who overview-holdings__twin-who--wide">
          <TwinLink />
          <Link2 className="overview-holdings__twin-icon" aria-hidden />
          <span className="overview-holdings__twin-note">
            twin was {formatPp(pp / 100)} off
            {money !== null && (
              <>
                {" ("}
                <Money amount={money} currency={ccy} signed digits={0} />
                {")"}
              </>
            )}
          </span>
          <button
            type="button"
            className="overview-holdings__twin-dismiss"
            aria-label={`Dismiss ${twin.symbol} twin notice for ${row.symbol}`}
            title="Hide twin accuracy note"
            onClick={() => onDismiss(key)}
          >
            <X aria-hidden />
          </button>
        </span>
      </li>
    );
  }
  if (twin.est_value == null) return null;
  const age = twin.at ? formatStamp(twin.at, { timeZone }) : null;
  return (
    <li
      className="overview-holdings__twin"
      data-twin-for={row.symbol}
      aria-label={`Estimate for ${row.symbol} from ${twin.symbol}`}
    >
      <span className="overview-holdings__twin-who">
        <TwinLink />
        <span className="overview-holdings__twin-badge" title={`Not the official NAV: estimated from ${twin.symbol}`}>
          <Link2 className="overview-holdings__twin-icon" aria-hidden />
          ≈ est.
        </span>
        <span className="overview-holdings__twin-symbol">
          <span className="overview-holdings__twin-approx" aria-hidden>
            ≈{" "}
          </span>
          {twin.symbol}
        </span>
        {age && (
          <span className="overview-holdings__twin-age" title={`${twin.symbol} price as of ${age}`}>
            {age}
          </span>
        )}
        {/* The twin's own close is in hand, so this estimate will not move again
            until the next open — the same promise the ✓ makes on a priced row. */}
        <PriceTick
          className="overview-holdings__twin-tick"
          title={twin.at_close ? `Up to date with ${twin.symbol}'s latest close` : null}
        />
      </span>
      <span className="overview-holdings__cell overview-holdings__twin-value">
        <span className="overview-holdings__twin-num">
          ≈<Money amount={toNum(twin.est_value)} currency={ccy} />
        </span>
      </span>
      <span className="overview-holdings__cell overview-holdings__twin-day">
        <span className="overview-holdings__twin-num">
          ≈<Percent ratio={toNum(twin.est_today_pct ?? null)} signed colored />
        </span>
        <span className="overview-holdings__twin-num overview-holdings__twin-sub">
          ≈<Money amount={toNum(twin.est_today_move ?? null)} currency={ccy} signed colored />
        </span>
      </span>
      {/* Every other row reports money and percent since buying; so does this one. */}
      <span className="overview-holdings__cell overview-holdings__total overview-holdings__twin-total">
        <span className="overview-holdings__twin-num">
          ≈<Money amount={toNum(twin.est_total_return ?? null)} currency={ccy} signed colored />
        </span>
        <span className="overview-holdings__twin-num overview-holdings__twin-sub">
          ≈<Percent ratio={toNum(twin.est_total_growth ?? null)} signed />
        </span>
      </span>
    </li>
  );
}

function Row({
  row,
  ccy,
  badge,
  stamp,
  tick,
  staleMove,
  maxWeight,
  watch,
}: {
  row: HoldingRowDto;
  ccy: string;
  /** "top winner" / "top loser" pill, off unless `display.mover_badges` is on. */
  badge?: "winner" | "loser";
  /** This row's price time, only when it differs from the card's (see `foldStamps`). */
  stamp: string | null;
  /** The up-to-date ✓ title while the market is shut, else null. */
  tick: string | null;
  /** Why the day move is greyed (an earlier session's), else null. */
  staleMove: string | null;
  /** Largest weight in the list: the weight bars share its scale. */
  maxWeight: number;
  watch: TwinWatchState;
}) {
  const stale = staleMove !== null;
  const weight = toNum(row.weight_pct);
  const live = row.market_open && !stale;
  return (
    <li className={clsx("overview-holdings__row", hasTwinLine(row, watch) && "overview-holdings__row--twin")} data-symbol={row.symbol}>
      <span className="overview-holdings__who">
        <span className="overview-holdings__symbol">
          {row.symbol}
          {/* Warnings first: when the cell is narrow they wrap to a second line, never clip. */}
          {row.value_warning && (
            <span className="overview-holdings__pill overview-holdings__pill--warn">stale value</span>
          )}
          {row.price_data_warning && (
            <span className="overview-holdings__pill overview-holdings__pill--warn">bad history</span>
          )}
          {live && <span className="overview-holdings__pill overview-holdings__pill--live">live</span>}
          {row.is_money_market && <span className="overview-holdings__pill">CASH</span>}
          {!row.is_money_market && isNavRow(row) && <span className="overview-holdings__pill">NAV</span>}
          <PriceTick title={tick} />
          {badge && (
            <span className={clsx("overview-holdings__pill", `overview-holdings__pill--${badge}`)}>
              {badge === "winner" ? "top winner" : "top loser"}
            </span>
          )}
        </span>
        <span className="overview-holdings__name" title={row.name}>
          {row.name}
        </span>
        {stamp && (
          <span className="overview-holdings__asof" title={`Price as of ${stamp}`}>
            <span className="overview-holdings__asof-key">Price as of</span> {sentenceCase(stamp)}
          </span>
        )}
      </span>
      <span className="overview-holdings__weight">
        <span className="overview-holdings__weight-bar" aria-hidden>
          <span
            className="overview-holdings__weight-fill"
            style={{ width: `${weight !== null && maxWeight > 0 ? Math.min((weight / maxWeight) * 100, 100) : 0}%` }}
          />
        </span>
        <span className="overview-holdings__num">
          <Percent ratio={weight} digits={1} />
        </span>
      </span>
      <span className="overview-holdings__cell overview-holdings__value">
        <span className="overview-holdings__main">
          <Money amount={toNum(row.value)} currency={ccy} />
        </span>
        <span className="overview-holdings__sub overview-holdings__sub--phone">
          <Percent ratio={weight} digits={1} /> of portfolio
        </span>
      </span>
      <span
        className={clsx("overview-holdings__cell", stale && "overview-holdings__today--stale")}
        title={staleMove ?? undefined}
      >
        <span className="overview-holdings__main">
          <Percent ratio={toNum(row.today_pct)} signed colored={!stale} />
        </span>
        <span className="overview-holdings__sub">
          <Money amount={toNum(row.today_move)} currency={ccy} signed colored={!stale} />
        </span>
        {staleMove && <span className="overview-holdings__sr">{staleMove}</span>}
      </span>
      <span className="overview-holdings__cell overview-holdings__total">
        <span className="overview-holdings__main">
          <Money amount={toNum(row.total_return)} currency={ccy} signed colored />
        </span>
        <span className="overview-holdings__sub">
          <Percent ratio={toNum(row.total_growth)} signed />
        </span>
      </span>
    </li>
  );
}

/**
 * Compact table of every position on the Overview: the largest stay open, the
 * rest sit in an inline fold in the same grid (remembered in
 * `iv.overview.holdings.open`), with a link to the full table.
 */
export function OverviewHoldings({ currency, movers }: OverviewHoldingsProps) {
  const q = useHoldings(currency);
  const timeZone = useTimeZone();
  const listId = useId();
  const [open, setOpen] = usePersistentState<boolean>("overview.holdings.open", false);
  const [watch, setWatch] = usePersistentState<TwinWatchState>(
    "overview.holdings.twinWatch",
    DEFAULT_TWIN_WATCH,
    isTwinWatchState,
  );
  // Off by default: the pill pushed the symbol line onto a second row too often,
  // and the Top movers card above already names them (`display.mover_badges`).
  const { moverBadges } = useDisplayPrefs();
  const winners = new Set(moverBadges ? (movers?.winners.map((m) => m.symbol) ?? []) : []);
  const losers = new Set(moverBadges ? (movers?.losers.map((m) => m.symbol) ?? []) : []);
  const all = q.data ? byValue(q.data.holdings) : [];
  const more = Math.max(0, all.length - OVERVIEW_HOLDINGS_LIMIT);
  const rows = open ? all : all.slice(0, OVERVIEW_HOLDINGS_LIMIT);
  const maxWeight = Math.max(0, ...all.map((r) => toNum(r.weight_pct) ?? 0));

  useEffect(() => {
    if (!q.data) return;
    const pendingRows = q.data.holdings.filter((r) => r.twin?.pending && r.twin.est_value != null);
    if (pendingRows.length === 0) return;
    setWatch((prev) => {
      let changed = false;
      const now = Date.now();
      const nextSeen = { ...prev.seenPending };
      // Prune old sightings so the stored map does not grow for ever.
      for (const [sym, ms] of Object.entries(nextSeen)) {
        const n = Number(ms);
        if (!Number.isFinite(n) || now - n > TWIN_SEEN_PRUNE_MS) {
          delete nextSeen[sym];
          changed = true;
        }
      }
      for (const r of pendingRows) {
        // Refresh at most once a minute (every tick would rewrite storage).
        const last = Number(nextSeen[r.symbol]);
        if (!Number.isFinite(last) || now - last > 60_000) {
          nextSeen[r.symbol] = String(now);
          changed = true;
        }
      }
      return changed ? { ...prev, seenPending: nextSeen } : prev;
    });
  }, [q.data, setWatch]);

  const dismissTwin = (key: string) => {
    setWatch((prev) => ({
      ...prev,
      dismissed: { ...prev.dismissed, [key]: true },
    }));
  };

  // The price time is said once, in the header; a row only shows its own when it differs.
  // `weekdays` renders an older session as "Fri" rather than "Yesterday": shorter
  // for the header's corner, and it does not quietly mislead after a long weekend,
  // when the previous session is three days back.
  const stampOpts = useMemo(() => ({ timeZone, weekdays: true }) as const, [timeZone]);
  const stamps = useMemo(() => foldStamps(q.data?.holdings ?? [], stampOpts), [q.data, stampOpts]);
  const marks = useMemo(() => holdingMarks(q.data?.holdings ?? [], { timeZone }), [q.data, timeZone]);
  return (
    <Card
      className="overview-holdings"
      title="Holdings"
      meta={
        stamps.price || stamps.updated ? (
          <PriceStamps
            className="overview-holdings__stamps"
            priceText={stamps.price}
            updated={stamps.updated}
            compact
            priceOnly
            options={stampOpts}
          />
        ) : undefined
      }
      collapsibleId="overview.holdings"
    >
      {q.isError && !q.data ? (
        <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
      ) : q.isPending ? (
        <Skeleton height="8rem" />
      ) : (
        <>
          <ul className="overview-holdings__list" id={listId}>
            <li className="overview-holdings__head" aria-hidden>
              <span>Holding</span>
              <span className="overview-holdings__head-weight">Weight</span>
              <span className="overview-holdings__head-num">Value</span>
              <span className="overview-holdings__head-num">Day</span>
              <span className="overview-holdings__head-num overview-holdings__head-total">Since buying</span>
            </li>
            {rows.map((r) => (
              <Fragment key={r.instrument_id}>
                <Row
                  row={r}
                  ccy={currency}
                  stamp={stamps.rowPrice(r)}
                  tick={marks.tick(r)}
                  staleMove={marks.staleMove(r)}
                  maxWeight={maxWeight}
                  badge={winners.has(r.symbol) ? "winner" : losers.has(r.symbol) ? "loser" : undefined}
                  watch={watch}
                />
                <TwinSubRow row={r} ccy={currency} timeZone={timeZone} watch={watch} onDismiss={dismissTwin} />
              </Fragment>
            ))}
          </ul>
          {/* Footer: the inline fold stays with the list it opens, the way out sits in the corner. */}
          <div className="overview-holdings__footer">
            {more > 0 && (
              <button
                type="button"
                className="overview-holdings__fold"
                aria-expanded={open}
                aria-controls={listId}
                onClick={() => setOpen((v) => !v)}
              >
                <ChevronDown
                  className={clsx("overview-holdings__fold-icon", open && "overview-holdings__fold-icon--open")}
                  aria-hidden
                />
                {open ? "Show fewer" : `Show all ${all.length} holdings`}
              </button>
            )}
            <Link className="overview-holdings__link" to="/holdings">
              Full table
            </Link>
          </div>
        </>
      )}
    </Card>
  );
}
