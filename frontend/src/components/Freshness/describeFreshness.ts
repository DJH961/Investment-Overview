import { formatTime, formatWeekdayTime } from "../../lib/format";
import type { LiveStatus } from "../../lib/live";
import type { RefreshState } from "../../lib/refresh";
import type { components } from "../../lib/api-types";
import type { FreshnessStatus } from "./Freshness";

type FreshnessDto = components["schemas"]["Freshness"];

export interface FreshnessView {
  status: FreshnessStatus;
  label: string;
}

const latest = (...values: (string | null | undefined)[]): string | null => {
  let best: string | null = null;
  for (const v of values) if (v && (!best || Date.parse(v) > Date.parse(best))) best = v;
  return best;
};

/** The "Updating…" chip while a refresh runs (historic downloads show their progress). */
export function updatingView(refresh: Pick<RefreshState, "historical" | "done" | "total" | "label">): FreshnessView {
  if (refresh.historical && refresh.total > 0) {
    return { status: "updating", label: `Downloading history ${refresh.done}/${refresh.total}` };
  }
  return { status: "updating", label: "Updating…" };
}

/**
 * Top-bar chip for the Overview. "Live" only when the server says a price
 * landed within the live window (`prices_live`), stamped with the price time,
 * never the server's compute time.
 */
const NY = "America/New_York";
const OPEN_MINUTES = 9 * 60 + 30; // regular session opens 09:30 New York time

/**
 * When the US market opens later today, or null when it does not (weekend,
 * already opened or closed for the day). Only call this for a "closed" market
 * state: the server already reports exchange holidays as "holiday".
 */
export function preMarketOpen(now: Date = new Date()): Date | null {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: NY,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return null;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  if (minutes >= OPEN_MINUTES) return null;
  const msToOpen = (OPEN_MINUTES - minutes) * 60_000 - Number(parts.second) * 1000 - now.getMilliseconds();
  return new Date(now.getTime() + msToOpen);
}

export function describeFreshness(
  freshness: FreshnessDto,
  opts: { live: LiveStatus; refresh: RefreshState; timeZone?: string; now?: Date },
): FreshnessView {
  const { live, refresh, timeZone } = opts;
  if (refresh.running || freshness.refresh_running) {
    return updatingView(
      refresh.running
        ? refresh
        : {
            historical: freshness.historical,
            done: freshness.progress_done,
            total: freshness.progress_total,
            label: freshness.progress_label ?? null,
          },
    );
  }
  if (live === "reconnecting") return { status: "stale", label: "Reconnecting…" };
  if (live === "offline" && typeof navigator !== "undefined" && navigator.onLine === false) {
    return { status: "stale", label: "Offline" };
  }
  const updated = latest(freshness.last_price_update_at, freshness.price_observed_at, refresh.lastUpdateAt);
  const pricesLive = refresh.pricesLive ?? freshness.prices_live;
  if (freshness.market_state === "open") {
    if (pricesLive) return { status: "live", label: updated ? `Live · ${formatTime(updated, timeZone)}` : "Live" };
    return { status: "closed", label: updated ? `Updated ${formatTime(updated, timeZone)}` : "Market open" };
  }
  // A weekday morning before the bell: say when trading starts, so "Closed"
  // does not read like something is broken.
  const opensAt = freshness.market_state === "closed" ? preMarketOpen(opts.now) : null;
  if (opensAt) return { status: "closed", label: `Pre-market · opens ${formatTime(opensAt, timeZone)}` };
  const priceAt = freshness.price_market_at ?? freshness.price_observed_at;
  const word = freshness.market_state === "holiday" ? "Holiday" : "Closed";
  return {
    status: "closed",
    label: priceAt ? `${word} · prices as of ${formatWeekdayTime(priceAt, timeZone)}` : word,
  };
}
