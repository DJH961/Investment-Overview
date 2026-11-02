/**
 * Data-health headline for the TopBar badge (`GET /api/diagnostics/status`,
 * the cheap probe: no full positions walk). The phone-shell package wires it
 * into the TopBar; this module only exports the hook.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

// TODO(orchestrator): switch to components["schemas"]["DiagnosticsStatusOut"] after `npm run gen:api`.
export interface HealthStatusDto {
  severity: string;
  count: number;
  problems: number;
}

export type HealthSeverity = "ok" | "info" | "warning" | "error";

export interface HealthStatus {
  severity: HealthSeverity;
  /** Checks with a problem plus recent background problems. */
  count: number;
  /** Show a badge at all (anything but a clean "ok"). */
  attention: boolean;
  /** Link target for the badge. */
  href: string;
  /** Short text for a tooltip / aria-label. */
  label: string;
  isLoading: boolean;
}

const SEVERITIES: HealthSeverity[] = ["ok", "info", "warning", "error"];

export function toHealthStatus(dto: HealthStatusDto | undefined, isLoading = false): HealthStatus {
  const raw = SEVERITIES.includes(dto?.severity as HealthSeverity) ? (dto?.severity as HealthSeverity) : "ok";
  const count = (dto?.count ?? 0) + (dto?.problems ?? 0);
  // Background problems alone count as a warning.
  const severity: HealthSeverity = raw === "ok" && (dto?.problems ?? 0) > 0 ? "warning" : raw;
  const attention = severity !== "ok" && count > 0;
  return {
    severity,
    count,
    attention,
    href: "/diagnostics",
    label: attention ? `Health & Repair: ${count} item${count === 1 ? "" : "s"} need attention` : "Health & Repair: all clear",
    isLoading,
  };
}

export function useHealthStatus(enabled = true): HealthStatus {
  const q = useQuery({
    queryKey: ["diagnostics", "status"],
    queryFn: ({ signal }) => api<HealthStatusDto>("/api/diagnostics/status", { signal }),
    enabled,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
  return toHealthStatus(q.data, q.isPending && enabled);
}
