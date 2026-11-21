/**
 * The 7.1 holding deep-dive endpoints (docs/v7_1_contract.md). The interfaces are typed
 * by hand from the contract until `api-types.ts` is regenerated; every money field is a
 * decimal string, every ratio a fraction, every time ISO. The client never derives a
 * return from these: it shows them, sums them (linear) or converts one instant at the
 * rate sent with it.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { HoldingRowDto } from "./holdings";

type DecStr = string;
type TwinView = NonNullable<HoldingRowDto["twin"]>;

// ---- history ------------------------------------------------------------------------

export type HoldingRange = "1d" | "1w" | "1m" | "3m" | "6m" | "ytd" | "1y" | "all";
export type HistoryMode = "value" | "price";
export const HOLDING_RANGES: HoldingRange[] = ["1d", "1w", "1m", "3m", "6m", "ytd", "1y", "all"];
/** NAV funds have no intraday price: the server answers 1d / 1w with 422. */
export const NAV_RANGES: HoldingRange[] = ["1m", "3m", "6m", "ytd", "1y", "all"];

export interface ChartSessionDto {
  open: string;
  close: string;
}

export interface HoldingHistoryPointV2 {
  t: string;
  /** Price, native currency. */
  v: DecStr | null;
  value_native?: DecStr | null;
  /** Value at that instant's / day's rate (null in price mode). */
  value_eur?: DecStr | null;
  value_usd?: DecStr | null;
  /** Cumulative net flows, each at its own date's rate (null in price mode). */
  invested_eur?: DecStr | null;
  invested_usd?: DecStr | null;
}

export interface TradeMarkerDto {
  t: string;
  kind: "buy" | "sell";
  quantity: DecStr;
  price_native: DecStr;
}

export interface HistoryPeriodDto {
  change_eur: DecStr | null;
  change_usd: DecStr | null;
  return_eur: DecStr | null;
  return_usd: DecStr | null;
  bought_eur: DecStr | null;
  bought_usd: DecStr | null;
  dividends_eur: DecStr | null;
  dividends_usd: DecStr | null;
}

export interface HoldingHistoryV2Dto {
  instrument_id: number;
  symbol: string;
  ccy: string;
  range: HoldingRange;
  mode?: HistoryMode;
  x_mode?: "date" | "time";
  sessions?: ChartSessionDto[];
  points: HoldingHistoryPointV2[];
  trades?: TradeMarkerDto[];
  avg_price_native?: DecStr | null;
  period?: HistoryPeriodDto | null;
}

export function useHoldingHistoryV2(instrumentId: number | null, range: HoldingRange, mode: HistoryMode) {
  return useQuery<HoldingHistoryV2Dto>({
    queryKey: ["holdings", "history", instrumentId, range, mode],
    enabled: instrumentId !== null,
    placeholderData: (prev, prevQuery) =>
      prevQuery?.queryKey[2] === instrumentId && prevQuery?.queryKey[4] === mode ? prev : undefined,
    queryFn: ({ signal }) =>
      api<HoldingHistoryV2Dto>(`/api/holdings/${instrumentId}/history?range=${range}&mode=${mode}`, { signal }),
  });
}

// ---- peek ---------------------------------------------------------------------------

export interface HoldingPeekDto {
  week: { points: { t: string; value_native: DecStr | null }[]; change_pct: DecStr | null };
  tranches: { open_count: number; next_long_term_on: string | null; next_long_term_days: number | null };
  last_trade: { date: string; kind: string; quantity: DecStr | null } | null;
  last_dividend: { date: string; amount: DecStr; currency: string } | null;
  twin: TwinView | null;
}

/** The list row's peek: fetched only once the row is opened. */
export function useHoldingPeek(instrumentId: number, enabled: boolean) {
  return useQuery<HoldingPeekDto>({
    queryKey: ["holdings", "peek", instrumentId],
    enabled,
    staleTime: 60_000,
    queryFn: ({ signal }) => api<HoldingPeekDto>(`/api/holdings/${instrumentId}/peek`, { signal }),
  });
}

// ---- twin ---------------------------------------------------------------------------

export type TwinRange = "1d" | "1w" | "1m" | "3m" | "6m" | "ytd" | "1y";
export const TWIN_RANGES: TwinRange[] = ["1d", "1w", "1m", "3m", "6m", "ytd", "1y"];

export interface HoldingTwinDto {
  instrument_id: number;
  symbol: string;
  twin_symbol: string;
  twin_reason: "same_index" | "close_index" | "manual";
  range: TwinRange;
  x_mode: "date" | "time";
  sessions: ChartSessionDto[];
  twin_points: { t: string; price_native: DecStr }[];
  estimate_points: { t: string; price_native: DecStr }[];
  nav_points: { t: string; nav_native: DecStr }[];
  rebased: { t: string; fund_pct: DecStr | null; twin_pct: DecStr | null; gap_pp: DecStr | null }[] | null;
  twin_now: { price_native: DecStr | null; day_pct: DecStr | null; captured_at: string | null };
  stats: {
    median_gap_pp: DecStr | null;
    bias_pp: DecStr | null;
    bias_label: "runs_high" | "runs_low" | "none";
    sessions: number;
  };
  recent: { session_date: string; estimate_pct: DecStr | null; nav_pct: DecStr | null; gap_pp: DecStr | null }[];
}

export function useHoldingTwin(instrumentId: number | null, range: TwinRange, enabled = true) {
  return useQuery<HoldingTwinDto>({
    queryKey: ["holdings", "twin", instrumentId, range],
    enabled: enabled && instrumentId !== null,
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === instrumentId ? prev : undefined),
    queryFn: ({ signal }) => api<HoldingTwinDto>(`/api/holdings/${instrumentId}/twin?range=${range}`, { signal }),
  });
}

// ---- tranches -----------------------------------------------------------------------

export type TrancheStatus = "long" | "soon" | "short";

export interface TrancheRowDto {
  id: number;
  account_id: number;
  account_name: string;
  acquired_on: string;
  source: "buy" | "reinvest" | "transfer_in";
  quantity_bought: DecStr;
  quantity_left: DecStr;
  cost_per_share_native: DecStr;
  cost_native: DecStr;
  age_days: number;
  long_term_on: string;
  /** null once long-term. */
  days_to_long_term: number | null;
  status: TrancheStatus;
  gain_native: DecStr | null;
  gain_pct: DecStr | null;
}

export interface TrancheGroupDto {
  account_id: number;
  source: "reinvest";
  count: number;
  quantity_left: DecStr;
  cost_native: DecStr;
  avg_cost_per_share_native: DecStr | null;
  gain_native: DecStr | null;
  gain_pct: DecStr | null;
  long_count: number;
  short_count: number;
  row_ids: number[];
}

export interface HoldingTranchesDto {
  instrument_id: number;
  symbol: string;
  currency: string;
  method: "fifo_view";
  as_of: string;
  price_native: DecStr | null;
  rows: TrancheRowDto[];
  groups: TrancheGroupDto[];
  totals: {
    quantity_left: DecStr;
    position_quantity: DecStr;
    matches_position: boolean;
    long_quantity: DecStr;
    short_quantity: DecStr;
    fully_sold_count: number;
  };
}

export function useHoldingTranches(instrumentId: number | null, enabled = true) {
  return useQuery<HoldingTranchesDto>({
    queryKey: ["holdings", "tranches", instrumentId],
    enabled: enabled && instrumentId !== null,
    queryFn: ({ signal }) => api<HoldingTranchesDto>(`/api/holdings/${instrumentId}/tranches`, { signal }),
  });
}

// ---- contract additions to existing payloads ----------------------------------------

/** `/dividends/both` › `by_holding[]` gains these (reporting currency, each payment at its own date's rate). */
export interface DividendHoldingExtra {
  by_year?: { year: number; amount: DecStr }[];
  last_12m?: DecStr | null;
  yield_ttm?: DecStr | null;
}

/** `/analytics/both` › `attribution[]` gains these; `pct_of_total_return` is no longer read. */
export interface AttributionExtra {
  share_of_pnl?: DecStr | null;
  own_return?: DecStr | null;
}
