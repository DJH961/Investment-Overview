import { useHealthStatus } from "../../lib/health";
import type { HealthSummary } from "../TopBar";

/** Data-health summary for the top-bar badge (cheap `GET /api/diagnostics/status`, refetched every 5 min). */
export function useShellHealth(): HealthSummary | undefined {
  const h = useHealthStatus();
  if (h.isLoading) return undefined;
  if (!h.attention) return { severity: "ok", count: 0, label: h.label };
  return { severity: h.severity === "error" ? "error" : "warn", count: h.count, label: h.label };
}
