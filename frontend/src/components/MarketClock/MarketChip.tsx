import clsx from "clsx";
import { useState } from "react";
import type { ReportingCurrency } from "../../lib/prefs";
import { HeroIntraday } from "../HeroIntraday";
import { Sheet } from "../Sheet";
import { MarketClock, formatChipSpan, useClockModel, type ClockFreshness } from "./MarketClock";
import "./MarketChip.scss";

export interface MarketChipProps {
  freshness: ClockFreshness | null | undefined;
  /** Live prices are streaming: the dot keeps its "live" colour. */
  live?: boolean;
  currency: ReportingCurrency;
  /** Fixed clock (tests). */
  now?: Date;
}

/**
 * The phone's quiet market chip in the hero's corner: "● Open · 1 h 46 m" (minutes,
 * no seconds). A button: tapping opens a bottom sheet with the full statement clock
 * (seconds, session progress bar) and the day's Low / High / Prev close. It never asks
 * for fresh instants itself (the hero's compact band does that).
 */
export function MarketChip({ freshness, live = false, currency, now }: MarketChipProps) {
  const [open, setOpen] = useState(false);
  const model = useClockModel(freshness, undefined, now, false);
  if (!model || !freshness) return null;
  const { view, remaining, rung, sentence } = model;
  const span = remaining != null ? formatChipSpan(remaining) : rung ? "bell rang" : null;
  const text = span ? `${view.state} · ${span}` : view.state;
  return (
    <>
      <button
        type="button"
        className={clsx("market-chip", live && "market-chip--live")}
        aria-label={`${sentence} Show the market clock`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <span className="market-chip__dot" aria-hidden />
        <span className="market-chip__text" aria-hidden>
          {text}
        </span>
      </button>
      <Sheet open={open} onOpenChange={setOpen} title="Market clock">
        <HeroIntraday currency={currency} now={now} clock={<MarketClock freshness={freshness} now={now} variant="sheet" fire={false} />} />
      </Sheet>
    </>
  );
}
