import type { HealthSummary } from "../TopBar";

/**
 * Data-health summary for the top-bar badge.
 *
 * TODO(WP-9): return the result of `useHealthStatus()` from `lib/` (backed by
 * `GET /api/diagnostics/status`) once that hook lands. Until then the badge
 * shows the neutral "Data health" link on desktop and nothing on phone.
 */
export function useShellHealth(): HealthSummary | undefined {
  return undefined;
}
