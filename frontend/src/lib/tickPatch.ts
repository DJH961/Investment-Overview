/**
 * Put a live tick straight into the cached "both currencies" queries (no request):
 * totals, the newest intraday point of the 1d / 1w graphs and the holdings rows'
 * price. The staggered refetch that follows corrects anything approximated here.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { components } from "./api-types";
import type { GraphDto, OverviewDto } from "./queries/portfolio";
import type { HoldingRowDto, HoldingsDto } from "./queries/holdings";

type Ccy = "EUR" | "USD";
const SIDES: Ccy[] = ["EUR", "USD"];
type Both<T> = Record<Ccy, T>;
export type TickPointDto = components["schemas"]["TickPoint"];
export type TickPriceDto = components["schemas"]["TickPrice"];

const decimal = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** The shape of a tick as `handleLiveEvent` sees it (loosely typed SSE payload). */
export interface TickLike {
  total_value_eur?: unknown;
  total_value_usd?: unknown;
  fx_eur_usd?: unknown;
  last_update_at?: unknown;
  prices_live?: unknown;
  point?: unknown;
  prices?: unknown;
  seq?: unknown;
}

/** Totals, the rate and the freshness chip, on both sides of every cached overview. */
export function patchOverviewFromEvent(queryClient: QueryClient, ev: TickLike): void {
  const eur = decimal(ev.total_value_eur);
  const usd = decimal(ev.total_value_usd);
  const fx = decimal(ev.fx_eur_usd);
  const last = typeof ev.last_update_at === "string" ? ev.last_update_at : null;
  const live = typeof ev.prices_live === "boolean" ? ev.prices_live : null;
  const total: Both<string | null> = { EUR: eur, USD: usd };
  for (const [key, data] of queryClient.getQueriesData<Both<OverviewDto>>({ queryKey: ["overview", "both"] })) {
    if (!data || typeof data !== "object") continue;
    const next = { ...data };
    for (const side of SIDES) {
      const dto = data[side];
      if (!dto?.kpis) continue;
      const primary = total[side];
      const secondary = total[side === "EUR" ? "USD" : "EUR"];
      next[side] = {
        ...dto,
        fx_eur_usd: fx ?? dto.fx_eur_usd,
        kpis: primary ? { ...dto.kpis, total_value: primary } : dto.kpis,
        kpis_secondary:
          secondary && dto.kpis_secondary ? { ...dto.kpis_secondary, total_value: secondary } : dto.kpis_secondary,
        freshness: dto.freshness
          ? {
              ...dto.freshness,
              ...(last ? { last_price_update_at: last } : {}),
              ...(live !== null ? { prices_live: live } : {}),
            }
          : dto.freshness,
      };
    }
    queryClient.setQueryData<Both<OverviewDto>>(key, next);
  }
}

const INTRADAY_RANGES = ["1d", "1w"];
const DAILY_RANGES = ["1m", "3m", "6m", "ytd", "1y", "all"];

function withPoint(points: GraphDto["points"], t: string, v: string): GraphDto["points"] {
  const last = points[points.length - 1];
  if (last && last.t === t) return [...points.slice(0, -1), { t, v }];
  if (last && last.t > t) return points; // older than what is on screen
  return [...points, { t, v }];
}

/**
 * Daily ranges carry one point per date (`t` = "YYYY-MM-DD"): today's value replaces
 * the last point when it is the same (UTC) day, is appended when newer, and is ignored
 * when older. Never touches earlier points.
 */
function withDailyPoint(points: GraphDto["points"], t: string, v: string): GraphDto["points"] {
  const day = t.slice(0, 10);
  const last = points[points.length - 1];
  if (!last) return points; // nothing drawn yet: leave it to the fetch
  const lastDay = last.t.slice(0, 10);
  if (lastDay === day) return [...points.slice(0, -1), { ...last, v }];
  if (lastDay > day) return points;
  return [...points, { t: day, v }];
}

/** Append (or replace, same `t`) the live sample in every cached graph range, both sides. */
export function patchGraphPoint(queryClient: QueryClient, point: TickPointDto): void {
  if (!point || typeof point.t !== "string" || point.t === "") return;
  const ranges: Array<[string, typeof withPoint]> = [
    ...INTRADAY_RANGES.map((r): [string, typeof withPoint] => [r, withPoint]),
    ...DAILY_RANGES.map((r): [string, typeof withPoint] => [r, withDailyPoint]),
  ];
  for (const [range, add] of ranges) {
    for (const [key, data] of queryClient.getQueriesData<Both<GraphDto>>({ queryKey: ["graphs", range, "both"] })) {
      if (!data || typeof data !== "object") continue;
      const next = { ...data };
      for (const side of SIDES) {
        const g = data[side];
        if (!g || !Array.isArray(g.points)) continue;
        const own = decimal(point[side]);
        const sec = g.secondary ? decimal(point[g.secondary.ccy]) : null;
        next[side] = {
          ...g,
          points: own ? add(g.points, point.t, own) : g.points,
          secondary: g.secondary && sec ? { ...g.secondary, points: add(g.secondary.points, point.t, sec) } : g.secondary,
        };
      }
      queryClient.setQueryData<Both<GraphDto>>(key, next);
    }
  }
}

function patchRow(row: HoldingRowDto, side: Ccy, fx: number | null, p: TickPriceDto): HoldingRowDto {
  const px = Number(p.px);
  const shares = Number(row.shares);
  if (!Number.isFinite(px) || !Number.isFinite(shares)) return row;
  // Native -> reporting factor: same currency 1, else the EUR/USD rate (USD per EUR).
  let factor: number | null = null;
  if (row.native_currency === side) factor = 1;
  else if (fx && fx > 0 && row.native_currency === "USD" && side === "EUR") factor = 1 / fx;
  else if (fx && fx > 0 && row.native_currency === "EUR" && side === "USD") factor = fx;
  if (factor === null) return row;
  const next: HoldingRowDto = { ...row, price_native: p.px, value: String(shares * px * factor) };
  const prev = p.prev_close === null || p.prev_close === undefined ? NaN : Number(p.prev_close);
  if (Number.isFinite(prev) && prev !== 0) {
    next.today_pct = String(px / prev - 1);
    next.today_move = String(shares * (px - prev) * factor);
  }
  return next;
}

/** Rows' price, value and day move from the tick's native prices (linear: shares x price x rate). */
export function patchHoldingsPrices(
  queryClient: QueryClient,
  prices: Record<string, TickPriceDto>,
  tickFx: string | null,
): void {
  for (const [key, data] of queryClient.getQueriesData<Both<HoldingsDto>>({ queryKey: ["holdings", "both"] })) {
    if (!data || typeof data !== "object") continue;
    const next = { ...data };
    for (const side of SIDES) {
      const h = data[side];
      if (!h?.holdings) continue;
      const fxRaw = tickFx ?? h.fx_eur_usd ?? null;
      const fx = fxRaw === null ? null : Number(fxRaw);
      const fxOk = fx !== null && Number.isFinite(fx) ? fx : null;
      next[side] = {
        ...h,
        holdings: h.holdings.map((row) => {
          const p = prices[String(row.instrument_id)];
          return p ? patchRow(row, side, fxOk, p) : row;
        }),
      };
    }
    queryClient.setQueryData<Both<HoldingsDto>>(key, next);
  }
}

/** Everything one tick changes on screen without a request. */
export function applyTick(queryClient: QueryClient, ev: TickLike): void {
  patchOverviewFromEvent(queryClient, ev);
  const point = ev.point as TickPointDto | null | undefined;
  if (point && typeof point === "object") patchGraphPoint(queryClient, point);
  const prices = ev.prices as Record<string, TickPriceDto> | null | undefined;
  if (prices && typeof prices === "object") {
    patchHoldingsPrices(queryClient, prices, decimal(ev.fx_eur_usd));
  }
}
