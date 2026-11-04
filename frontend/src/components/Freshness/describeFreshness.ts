import { parseInstant } from "../../lib/format";
import type { LiveStatus } from "../../lib/live";
import type { RefreshState } from "../../lib/refresh";
import type { components } from "../../lib/api-types";
import type { FreshnessStatus } from "./Freshness";
import { formatStamp, priceAsOf, relativeDay, type PriceTime, type StampOptions } from "./stamps";

type FreshnessDto = components["schemas"]["Freshness"];

export interface FreshnessView {
  status: FreshnessStatus;
  /** Market state + when the prices are from ("Closed · prices as of yesterday 22:00"). */
  label: string;
  /** Phone top bar: the same facts in fewer words ("Closed · yesterday 22:00"). */
  short?: string;
  /** When the app last fetched prices ("Updated today 21:27"); shown beside the chip on wide screens. */
  updated?: string;
}

/** The newest of several server instants (offset-less ones are UTC). */
export const latestInstant = (...values: (string | null | undefined)[]): string | null => {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const v of values) {
    if (!v) continue;
    const ms = parseInstant(v).getTime();
    if (ms > bestMs) {
      best = v;
      bestMs = ms;
    }
  }
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
 * landed within the live window (`prices_live`). The chip says when the
 * *prices are from*; `updated` says when the app last *fetched* them.
 * All times are in the Settings timezone (`timeZone`).
 */
export function describeFreshness(
  freshness: FreshnessDto,
  opts: {
    live: LiveStatus;
    refresh: RefreshState;
    /** Session date of the headline move, so a closed market names its close ("yesterday's close"). */
    sessionDate?: string | null;
  } & StampOptions,
): FreshnessView {
  const { live, refresh } = opts;
  const stamp = { timeZone: opts.timeZone, now: opts.now };
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
  const fetched = latestInstant(freshness.last_price_update_at, freshness.price_observed_at, refresh.lastUpdateAt);
  const updated = fetched ? `Updated ${formatStamp(fetched, stamp)}` : undefined;
  const pricesLive = refresh.pricesLive ?? freshness.prices_live;
  // The same moment twice says nothing new: show "Updated" only when it differs.
  const unlessSame = (when: string | null) => (when && updated === `Updated ${when}` ? undefined : updated);
  if (freshness.market_state === "open") {
    if (pricesLive) {
      const when = fetched ? formatStamp(fetched, stamp) : null;
      return { status: "live", label: when ? `Live · ${when}` : "Live", updated: unlessSame(when) };
    }
    const priceAt = latestInstant(freshness.price_market_at, freshness.price_observed_at);
    const when = priceAt ? formatStamp(priceAt, stamp) : null;
    return {
      status: "closed",
      label: when ? `Market open · prices as of ${when}` : "Market open",
      short: when ? `Open · ${when}` : "Market open",
      updated: unlessSame(when),
    };
  }
  // Same wording as the Overview hero: a settled price is named by its close.
  const word = freshness.market_state === "holiday" ? "Holiday" : "Closed";
  const price: PriceTime = {
    instant: freshness.price_market_at ?? freshness.price_observed_at,
    date: opts.sessionDate,
    marketOpen: false,
  };
  const when = priceAsOf(price, stamp);
  const day = opts.sessionDate ? relativeDay(opts.sessionDate, stamp) : null;
  return {
    status: "closed",
    label: when ? `${word} · prices as of ${when}` : word,
    // Phone: just the day ("Closed · Fri"); today's close needs no date.
    short: day && day !== "today" && day !== "–" ? `${word} · ${day}` : word,
    updated: unlessSame(when),
  };
}
