import { useQuery } from "@tanstack/react-query";
import { useMarketPhase, type MarketPhase } from "../../lib/marketPhase";
import { overviewQuery } from "../../lib/queries/portfolio";
import { useTimeZone } from "../../lib/timezone";
import { lastSessionLabel } from "./stamps";

/** What the day figures (a holding's move, the day KPI) are called at each moment. */
export interface DayWords {
  /** Column / tile label: "Today", or "Last session" until the first prices of a new session land. */
  label: string;
  /** One line under the list when the figures are not today's live ones, else null. */
  caption: string | null;
  /** The holding's live dot may show: the market trades and prices stream (or the phase is unknown). */
  live: boolean;
  /** "Last session · Mon" while the day figures are an earlier session's (the same words as the hero), else null. */
  earlier: string | null;
}

/** Pure: the wording for one phase (`sessionDate` is the headline move's session). */
export function dayWords(phase: MarketPhase | null, sessionDate: string | null | undefined, timeZone?: string): DayWords {
  const live = phase === null || phase === "live" || phase === "open";
  const earlier = phase === "closing" ? null : lastSessionLabel(sessionDate, { timeZone });
  if (phase === "closing") return { label: "Today", caption: "Closing · the closing prices are being settled", live, earlier };
  if (phase === "opening") {
    return { label: "Last session", caption: "Market open · figures are the last session's until the first prices land", live, earlier };
  }
  if (earlier && phase !== "live" && phase !== "open") {
    return { label: "Last session", caption: `${earlier.replace("Last session", "Day figures are from the last session")}`, live, earlier };
  }
  return { label: "Today", caption: null, live, earlier };
}

/**
 * The market phase the whole screen follows, read from the Overview payload the shell
 * already holds (never a fetch of its own), so a list or a holding page says the same
 * thing as the top bar and the hero. (Freshness and the session date are the same in both currencies.)
 */
export function useScreenPhase(): DayWords & { phase: MarketPhase | null } {
  const timeZone = useTimeZone();
  const data = useQuery({ ...overviewQuery("EUR"), enabled: false }).data;
  const { phase } = useMarketPhase(data?.freshness, Boolean(data?.daily_caption?.live));
  return { phase, ...dayWords(phase, data?.kpis?.daily_growth_as_of, timeZone) };
}
