/** Health & Repair: maintenance jobs, scheduler, logs, backups, market-data fixes, system info. */
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../api";
import type { components } from "../api-types";
import { subscribeLiveEvents } from "../live";

type S = components["schemas"];
export type JobCatalogue = S["JobCatalogue"];
export type JobInfo = S["JobInfo"];
export type JobParam = S["JobParam"];
export type JobRun = S["JobRun"];
export type SchedulerState = S["SchedulerState"];
export type SchedulerJobName = S["SchedulerJob"]["name"];
export type LogsDto = S["LogsDto"];
export type BackupsDto = S["BackupsDto"];
export type SystemInfo = S["SystemInfo"];
export type ProbeResult = S["ProbeResult"];
export type ProbeRequest = S["ProbeRequest"];
export type InstrumentOut = S["InstrumentOut"];
export type ClosePoint = S["ClosePoint"];
export type RatePoint = S["RatePoint"];
export type SplitPoint = S["SplitPoint"];
export type CheckAction = S["CheckAction"];

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";
export const backupDownloadUrl = (name: string) => `${BASE}/api/backup?name=${encodeURIComponent(name)}`;

const M = "maintenance";

// ---- jobs ------------------------------------------------------------------

export function useJobCatalogue() {
  return useQuery({
    queryKey: [M, "jobs"],
    queryFn: ({ signal }) => api<JobCatalogue>("/api/maintenance/jobs", { signal }),
    // Keep "running" badges honest even if the SSE stream is down.
    refetchInterval: (q) => (q.state.data?.jobs.some((j) => j.running) ? 3000 : false),
  });
}

export interface StartJobVars {
  id: string;
  params?: Record<string, unknown>;
  /** "yes" for danger=confirm, the job's confirm word for danger=typed. */
  confirm?: string;
}

export function useStartJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, params = {}, confirm }: StartJobVars) =>
      api<JobRun>(`/api/maintenance/jobs/${encodeURIComponent(id)}`, { method: "POST", body: { params, confirm } }),
    onSuccess: (run) => {
      qc.setQueryData([M, "run", run.id], run);
      return qc.invalidateQueries({ queryKey: [M, "jobs"] });
    },
  });
}

/** One run; polls every 2 s while running (the SSE `job` event usually beats it). */
export function useJobRun(runId: string | null) {
  return useQuery({
    queryKey: [M, "run", runId],
    queryFn: ({ signal }) => api<JobRun>(`/api/maintenance/runs/${runId}`, { signal }),
    enabled: runId !== null,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 2000 : false),
  });
}

export function applyJobEvent(qc: QueryClient, ev: Record<string, unknown>): void {
  if (ev.type !== "job" || typeof ev.id !== "string") return;
  const { type: _t, ts: _ts, ...run } = ev;
  qc.setQueryData([M, "run", ev.id], run as unknown as JobRun);
  if (ev.status !== "running") {
    void qc.invalidateQueries({ queryKey: [M, "jobs"] });
    void qc.invalidateQueries({ queryKey: ["diagnostics"] });
    if (String(ev.job).startsWith("backup.")) void qc.invalidateQueries({ queryKey: [M, "backups"] });
  }
}

/** Feed SSE `job` events into the run cache (mount once on the page). */
export function useJobEvents(): void {
  const qc = useQueryClient();
  useEffect(() => subscribeLiveEvents((ev) => applyJobEvent(qc, ev)), [qc]);
}

// ---- scheduler -------------------------------------------------------------

export function useScheduler() {
  return useQuery({
    queryKey: [M, "scheduler"],
    queryFn: ({ signal }) => api<SchedulerState>("/api/maintenance/scheduler", { signal }),
    refetchInterval: 15_000,
  });
}

export function useSchedulerRunNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (job: SchedulerJobName) =>
      api<SchedulerState>(`/api/maintenance/scheduler/${job}/run`, { method: "POST" }),
    onSuccess: (s) => qc.setQueryData([M, "scheduler"], s),
  });
}

export function useSchedulerPause() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { jobs: SchedulerJobName[]; paused: boolean; hours?: number | null }) =>
      api<SchedulerState>("/api/maintenance/scheduler/pause", { method: "PUT", body }),
    onSuccess: (s) => qc.setQueryData([M, "scheduler"], s),
  });
}

// ---- logs, backups, system ---------------------------------------------------

export interface LogQuery {
  source: string;
  level: "DEBUG" | "INFO" | "WARNING" | "ERROR";
  limit: number;
  contains: string;
  tracebacks: boolean;
}

export function useLogs(p: LogQuery) {
  return useQuery({
    queryKey: [M, "logs", p],
    queryFn: ({ signal }) => {
      const q = new URLSearchParams({ source: p.source, level: p.level, limit: String(p.limit) });
      if (p.contains.trim()) q.set("contains", p.contains.trim());
      if (p.tracebacks) q.set("tracebacks", "true");
      return api<LogsDto>(`/api/maintenance/logs?${q.toString()}`, { signal });
    },
    staleTime: 5_000,
  });
}

export function useBackups() {
  return useQuery({
    queryKey: [M, "backups"],
    queryFn: ({ signal }) => api<BackupsDto>("/api/maintenance/backups", { signal }),
  });
}

export function useSystemInfo() {
  return useQuery({
    queryKey: ["system"],
    queryFn: ({ signal }) => api<SystemInfo>("/api/system", { signal }),
  });
}

export function useProbe() {
  return useMutation({
    mutationFn: (body: ProbeRequest) => api<ProbeResult>("/api/maintenance/probe", { method: "POST", body }),
  });
}

// ---- market data -------------------------------------------------------------

export function useInstrumentList() {
  return useQuery({
    queryKey: ["instruments"],
    queryFn: ({ signal }) => api<InstrumentOut[]>("/api/instruments", { signal }),
    staleTime: 5 * 60_000,
  });
}

export function useAnomalies() {
  return useQuery({
    queryKey: [M, "anomalies"],
    queryFn: ({ signal }) => api<S["AnomaliesDto"]>("/api/maintenance/prices/anomalies", { signal }),
  });
}

/** Which market-data series a fix applies to. */
export type FixKind = "price" | "fx" | "split";

export interface FixRow {
  date: string;
  value: string;
  source: string;
}

const range = (start?: string, end?: string) => {
  const q = new URLSearchParams();
  if (start) q.set("start", start);
  if (end) q.set("end", end);
  const s = q.toString();
  return s ? `?${s}` : "";
};

/** `subject`: instrument id (price/split) or quote currency (fx). */
function seriesPath(kind: FixKind, subject: string): string {
  const s = encodeURIComponent(subject);
  return kind === "price" ? `/api/maintenance/prices/${s}` : kind === "fx" ? `/api/maintenance/fx/${s}` : `/api/maintenance/splits/${s}`;
}

export function useMarketSeries(kind: FixKind, subject: string | null, start?: string, end?: string) {
  return useQuery({
    queryKey: [M, "series", kind, subject, start ?? "", end ?? ""],
    enabled: Boolean(subject),
    queryFn: async ({ signal }): Promise<FixRow[]> => {
      const path = seriesPath(kind, subject ?? "") + (kind === "split" ? "" : range(start, end));
      if (kind === "price") {
        const r = await api<S["PricesDto"]>(path, { signal });
        return r.closes.map((c) => ({ date: c.date, value: c.close, source: c.source }));
      }
      if (kind === "fx") {
        const r = await api<S["RatesDto"]>(path, { signal });
        return r.rates.map((c) => ({ date: c.date, value: c.rate, source: c.source }));
      }
      const r = await api<S["SplitsDto"]>(path, { signal });
      return r.splits.map((c) => ({ date: c.date, value: c.ratio, source: c.source }));
    },
  });
}

const FIX_FIELD: Record<FixKind, string> = { price: "close", fx: "rate", split: "ratio" };

export function useSaveFix() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, subject, date, value }: { kind: FixKind; subject: string; date: string; value: string }) =>
      api<unknown>(`${seriesPath(kind, subject)}/${date}`, { method: "PUT", body: { [FIX_FIELD[kind]]: value } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [M] }),
  });
}

export function useDeleteFix() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, subject, date }: { kind: FixKind; subject: string; date: string }) =>
      api<void>(`${seriesPath(kind, subject)}/${date}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [M] }),
  });
}

// ---- diagnostics problems ------------------------------------------------------

export function useDismissProblem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number | "all") =>
      api<{ dismissed: number }>(
        id === "all" ? "/api/diagnostics/problems/dismiss-all" : `/api/diagnostics/problems/${id}/dismiss`,
        { method: "POST" },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["diagnostics"] }),
  });
}
