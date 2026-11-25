/**
 * Temporary types for the 7.4 currency journey (docs/v7_4_contract_api.md §8), until the
 * orchestrator regenerates `api-types.ts` from the backend. Money is a decimal string,
 * rates carry 4 decimals, dates are ISO. Every field mirrors §8; the few additions lane D
 * asks for are marked "(lane D ask)".
 */

type Dec = string;

export interface JourneyBucket {
  usd: Dec;
  /** Null in the USD view (the euro-only line is hidden). */
  eur_cost: Dec | null;
  eur_now: Dec | null;
  currency_eur: Dec | null;
  /** (lane D ask) The USD view's cost line: dollars originally deposited behind this bucket. */
  usd_cost?: Dec | null;
}

export interface JourneyInvested extends JourneyBucket {
  market_eur: Dec | null;
  /** (lane D ask) The USD view's market line, from native dollars. */
  market_usd?: Dec | null;
}

export interface JourneyRate {
  /** Your pool-blended EUR/USD. */
  rate: Dec | null;
  /** The ECB rate averaged over the same dates. */
  ecb_avg: Dec | null;
  /** Live EUR/USD. */
  now: Dec | null;
}

export type BridgeKey = "conversion_cost" | "waiting" | "cash" | "holdings" | "realised";

export interface JourneyBridge {
  lines: { key: BridgeKey; eur: Dec }[];
  /** Equals the Overview card's FX gain (a server test). */
  total_eur: Dec;
}

export interface IdleDollars {
  conversion_id: number;
  date: string;
  usd: Dec;
  days: number;
}

export interface BackInEuros {
  count: number;
  eur_received: Dec;
  orig_eur: Dec;
  realised_eur: Dec;
}

export interface CashOutEurSide {
  put_in: Dec;
  market: Dec;
  currency: Dec;
  conversion_cost: Dec;
  realised: Dec;
  realised_pct: Dec | null;
  xirr: Dec | null;
}

export interface CashOutUsdSide {
  put_in: Dec;
  market: Dec;
  realised: Dec;
  realised_pct: Dec | null;
  xirr: Dec | null;
}

export interface CashOutOut {
  conversion_id: number | null;
  date: string;
  usd_sent: Dec;
  eur_received: Dec;
  fees_eur: Dec;
  eur: CashOutEurSide;
  usd: CashOutUsdSide;
  /** One server sentence: how far the euro result trails or beats the dollar one. */
  note: string;
  flagged: boolean;
}

export interface JourneyView {
  stats: {
    usd_account: JourneyBucket;
    broker_cash: JourneyBucket;
    invested: JourneyInvested;
    your_rate: JourneyRate;
  };
  bridge: JourneyBridge | null;
  idle: IdleDollars[];
  back_in_euros: BackInEuros | null;
  cash_outs: CashOutOut[];
  flagged: { uncovered_buys: number; ecb_fallback_deposits: number };
}

/** §8 names the sides `eur` / `usd`; every other `/both` answer uses `EUR` / `USD`, so both are read. */
export type JourneyBoth = { eur?: JourneyView; usd?: JourneyView; EUR?: JourneyView; USD?: JourneyView };

export type TrailKind = "deposit" | "buy" | "sell" | "withdrawal" | "conversion";

export type StepKey = "sent" | "converted" | "waited" | "deposited" | "bought" | "sold" | "withdrawn" | "back" | "worth_now";

export interface TrailStep {
  key: StepKey;
  date: string | null;
  label: string;
  /** A decimal string when `figure_ccy` is set, otherwise plain text ("12 days"). */
  figure: string;
  figure_ccy: string | null;
  /** At most 24 characters, so no box wraps. */
  detail: string | null;
  /** In-app link (a route), or null. */
  link: string | null;
  /** (lane D ask) Signed change shown with the figure ("worth now" gain, "back" realised), or null. */
  change?: Dec | null;
}

export interface TrailPath {
  usd_share: Dec;
  steps: TrailStep[];
}

export interface TrailSplit {
  market_eur: Dec;
  currency_eur: Dec;
  conversion_cost_eur: Dec;
  total_eur: Dec;
}

export interface TrailOut {
  kind: TrailKind;
  id: number;
  paths: TrailPath[];
  more_paths: number;
  split: TrailSplit | null;
  your_rate: Dec | null;
  ecb_rate: Dec | null;
  flagged: boolean;
}

export interface CashOutPreviewIn {
  withdrawal_id?: number | null;
  usd_sent: Dec;
  eur_received: Dec;
  fees_eur: Dec;
  date: string;
}

/** Fields §8 adds to existing answers (read defensively: absent until lane C lands). */
export interface TrancheJourneyFields {
  cost_eur?: Dec | null;
  orig_eur?: Dec | null;
  your_rate?: Dec | null;
  gain_eur?: Dec | null;
  market_eur?: Dec | null;
  currency_eur?: Dec | null;
  /** Null = still in dollars. */
  back_in_euros?: boolean | null;
}

export interface LifetimeJourneyFields {
  your_rate?: Dec | null;
  ecb_avg?: Dec | null;
  conversion_cost_eur?: Dec | null;
  realised_eur?: Dec | null;
  vs_impact_note?: string | null;
}

export type ConversionDirection = "to_usd" | "to_eur";

/** (lane D ask) A conversion back's funding, for "How each conversion back was funded". */
export interface ConversionBackFunding {
  funded_by?: { withdrawal_id: number; date: string; usd: Dec; pinned: boolean }[];
  /** Dollars taken from the rest of the USD account (FIFO, at their cost). */
  rest_usd?: Dec | null;
}
