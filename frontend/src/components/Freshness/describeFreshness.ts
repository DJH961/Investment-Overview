import { formatTime, formatWeekdayTime } from "../../lib/format";
import type { LiveStatus } from "../../lib/live";
import type { RefreshState } from "../../lib/refresh";
import type { components } from "../../lib/api-types";
import type { FreshnessStatus } from "./Freshness";

type FreshnessDto = components["schemas"]["Freshness"];

export interface FreshnessView {
  status: FreshnessStatus;
  label: string;
  /** Phone top bar: the same facts in fewer words ("Closed · Mon 22:00"). */
  short?: string;
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
export function describeFreshness(
  freshness: FreshnessDto,
  opts: { live: LiveStatus; refresh: RefreshState; timeZone?: string },
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
  const priceAt = freshness.price_market_at ?? freshness.price_observed_at;
  const word = freshness.market_state === "holiday" ? "Holiday" : "Closed";
  const when = priceAt ? formatWeekdayTime(priceAt, timeZone) : null;
  return {
    status: "closed",
    label: when ? `${word} · prices as of ${when}` : word,
    short: when ? `${word} · ${when}` : word,
  };
}
