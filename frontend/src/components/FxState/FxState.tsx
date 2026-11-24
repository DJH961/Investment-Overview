import clsx from "clsx";
import { Moon, Sunrise } from "lucide-react";
import { forexReopen, useFxMoment } from "../../lib/fxWeekend";
import { formatWeekdayTime } from "../../lib/format";
import { useTimeZone } from "../../lib/timezone";
import "./FxState.scss";

export interface FxStateProps {
  /** Show nothing unless the FX week says so; `weekend` also honors the server's frozen flag. */
  frozen?: boolean;
  /** The server's reopen instant (`today.reopen_at`); falls back to the clock's own Sunday 17:00 New York. */
  reopenAt?: string | null;
  className?: string;
}

/**
 * The FX week on the home screen's currency cards: a small moon "FX closed for the
 * weekend" (the rate reads as Friday's close) and, for two hours after Sunday's reopen,
 * a sunrise "FX is back". Words and glyph, never colour alone. Reads the same client
 * clock as the rate chart (`lib/fxWeekend`); nothing renders on a normal trading day.
 */
export function FxState({ frozen = false, reopenAt, className }: FxStateProps) {
  const { moment, at } = useFxMoment();
  const timeZone = useTimeZone();
  const weekend = moment === "weekend" || frozen;
  if (!weekend && moment !== "back") return null;
  if (weekend) {
    const reopen = formatWeekdayTime(reopenAt ?? forexReopen(at), timeZone);
    return (
      <span className={clsx("fx-state", "fx-state--weekend", className)} data-testid="fx-state" title={`Spot FX is closed from Friday 17:00 to Sunday 17:00 New York time. Back ${reopen}.`}>
        <Moon aria-hidden className="fx-state__icon" />
        FX closed for the weekend
      </span>
    );
  }
  return (
    <span className={clsx("fx-state", "fx-state--back", className)} data-testid="fx-state">
      <Sunrise aria-hidden className="fx-state__icon" />
      FX is back
    </span>
  );
}
