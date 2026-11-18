import { useClockModel, type ClockFreshness } from "./MarketClock";
import "./SessionLine.scss";

export interface SessionLineProps {
  freshness: ClockFreshness | null | undefined;
  /** Fixed clock (tests). */
  now?: Date;
}

/**
 * A hairline session progress bar on the phone hero's top edge: filled = the share of the
 * session elapsed (while closed: of the wait for the next open). Decoration only
 * (aria-hidden; the market chip and its sheet carry the words). Re-renders on its own.
 */
export function SessionLine({ freshness, now }: SessionLineProps) {
  const model = useClockModel(freshness, undefined, now, false);
  if (!model || model.progress == null) return null;
  return (
    <span className="session-line" aria-hidden data-testid="session-line">
      <span className="session-line__fill" style={{ width: `${(model.progress * 100).toFixed(2)}%` }} />
    </span>
  );
}
