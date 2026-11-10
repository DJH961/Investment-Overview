import { useEffect, useState } from "react";
import { LOST_AFTER_MS, type LiveStatus } from "../../lib/live";

/**
 * The live status as the freshness chip should show it: a stream blip ("reconnecting")
 * keeps the previous status for the same grace period the connection banner waits, so a
 * one-second proxy reconnect does not flip "Live · 14:32" to "Reconnecting…" and back.
 */
export function useLiveGrace(live: LiveStatus, graceMs: number = LOST_AFTER_MS): LiveStatus {
  // Derived during render: the last status that was not a blip, and whether this blip outlasted the grace.
  const [seen, setSeen] = useState<LiveStatus>(live);
  const [kept, setKept] = useState<LiveStatus>(live);
  const [expired, setExpired] = useState(false);
  if (live !== seen) {
    setSeen(live);
    setExpired(false);
    if (live !== "reconnecting") setKept(live);
  }
  useEffect(() => {
    if (live !== "reconnecting") return undefined;
    const t = setTimeout(() => setExpired(true), graceMs);
    return () => clearTimeout(t);
  }, [live, graceMs]);
  // Anything but a blip shows at once; a blip shows the old status until the grace is over.
  return live === "reconnecting" && !expired ? kept : live;
}
