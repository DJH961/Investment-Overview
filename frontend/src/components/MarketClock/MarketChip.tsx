import clsx from "clsx";
import { useState } from "react";
import type { ReportingCurrency } from "../../lib/prefs";
import { HeroIntraday } from "../HeroIntraday";
import { Sheet } from "../Sheet";
import { MarketClock, formatChipSpan, useClockModel, type ClockFreshness } from "./MarketClock";
import { useBlip, useMarketPhase, usePrevious } from "./marketPhase";
import "./MarketChip.scss";

export interface MarketChipProps {
  freshness: ClockFreshness | null | undefined;
  /** Live prices are streaming: the dot keeps its "live" color. */
  live?: boolean;
  currency: ReportingCurrency;
  /** Fixed clock (tests). */
  now?: Date;
}

/**
 * The phone's quiet market chip in the hero's corner: "● Open for 1h 46m" (minutes,
 * no seconds). A button: tapping opens a bottom sheet with the full statement clock
 * (seconds, session progress bar) and the day's Low / High / Prev close. It never asks
 * for fresh instants itself (the hero's compact band does that).
 */
export function MarketChip({ freshness, live = false, currency, now }: MarketChipProps) {
  const [open, setOpen] = useState(false);
  const model = useClockModel(freshness, undefined, now, false);
  const { phase } = useMarketPhase(freshness, live, now);
  const prev = usePrevious(phase);
  const pulse = useBlip(phase === "live" && prev === "opening", 1400);
  if (!model || !freshness) return null;
  const { view, remaining, rung, sentence, progress, open: marketOpen, bellTime } = model;
  const span = remaining != null ? formatChipSpan(remaining) : rung ? "bell rang" : null;
  // From the bell until the server's next word the chip says what is happening, in a word.
  const text =
    phase === "closing"
      ? "Closing…"
      : phase === "opening"
        ? "Opening"
        : remaining != null && !marketOpen && bellTime
          ? // Shut: as informative as the desktop clock: when it opens, in the owner's zone.
            `${view.state} · opens ${bellTime}`
          : remaining != null
          ? `${view.state} for ${span}`
          : span
            ? `${view.state} · ${span}`
            : view.state;
  // The chip is the session's progress bar: its fill is the share of the session (or of
  // the overnight wait) already gone.
  const fill = progress != null ? `${(Math.min(1, Math.max(0, progress)) * 100).toFixed(1)}%` : null;
  return (
    <>
      <button
        type="button"
        className={clsx(
          "market-chip",
          phase === "live" && "market-chip--live",
          (phase === "closing" || phase === "opening") && "market-chip--pending",
          pulse && "market-chip--pulse",
        )}
        data-phase={phase ?? undefined}
        aria-label={`${sentence} Show the market clock`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {fill && <span className="market-chip__fill" data-testid="market-chip-fill" style={{ width: fill }} aria-hidden />}
        <span className="market-chip__dot" aria-hidden />
        <span className="market-chip__text" aria-hidden>
          {text}
        </span>
        {/* No room for the span: one word, never a bare dot (state is not colour alone). */}
        <span className="market-chip__word" aria-hidden>
          {phase === "closing" || phase === "opening"
            ? text
            : remaining != null && !marketOpen && bellTime && bellTime.length <= 5
              ? `Opens ${bellTime}`
              : view.state}
        </span>
      </button>
      <Sheet open={open} onOpenChange={setOpen} title="Market clock">
        <HeroIntraday currency={currency} now={now} clock={<MarketClock freshness={freshness} now={now} variant="sheet" fire={false} />} />
      </Sheet>
    </>
  );
}
