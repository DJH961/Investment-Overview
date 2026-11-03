import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { CloudOff, WifiOff } from "lucide-react";
import { Button } from "../Button";
import { useConnectivity, type Connectivity } from "../../lib/network";
import "./OfflineBanner.scss";

/** Newest `dataUpdatedAt` across the cached report queries (survives a reload via persistence). */
function newestDataAt(times: number[]): number | null {
  const newest = Math.max(0, ...times);
  return newest > 0 ? newest : null;
}

export function formatSavedAt(at: number, now = Date.now()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return new Date(now).toDateString() === d.toDateString()
    ? time
    : `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${time}`;
}

export interface OfflineBannerProps {
  /** Override for tests and the styleguide; defaults to the live connectivity. */
  state?: Connectivity;
  className?: string;
}

/**
 * Shown above the page while the network is gone or the server can't be
 * reached: the page keeps showing the last data loaded on this device and
 * refetches by itself once the connection is back.
 */
export function OfflineBanner({ state, className }: OfflineBannerProps) {
  const live = useConnectivity();
  const queryClient = useQueryClient();
  const connectivity = state ?? live;
  if (connectivity === "online") return null;

  const savedAt = newestDataAt(
    queryClient
      .getQueryCache()
      .getAll()
      .filter((q) => q.queryKey[0] !== "auth")
      .map((q) => q.state.dataUpdatedAt),
  );
  const shown = savedAt ? `Showing data saved at ${formatSavedAt(savedAt)}.` : "Showing what this device has saved.";
  const offline = connectivity === "offline";
  const Icon = offline ? WifiOff : CloudOff;

  return (
    <output className={clsx("offline-banner", className)}>
      <Icon className="offline-banner__icon" aria-hidden />
      <p className="offline-banner__text">
        <strong className="offline-banner__title">{offline ? "You're offline." : "Can't reach the server."}</strong>{" "}
        {shown} {offline ? "It updates by itself when you're back online." : "Retrying automatically."}
      </p>
      {!offline && (
        <Button
          size="sm"
          variant="secondary"
          className="offline-banner__retry"
          onClick={() => void queryClient.refetchQueries({ type: "active" })}
        >
          Retry
        </Button>
      )}
    </output>
  );
}
